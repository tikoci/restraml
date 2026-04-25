#!/usr/bin/env bun
/**
 * test-crash-path-memory.ts — Reproduce the /console/inspect crash-path hang
 * under low memory using quickchr.
 *
 * MikroTik support case SUP-127641: `POST /rest/console/inspect` with
 * `request=syntax` (or `request=completion`) at bare path `do` hangs the
 * entire HTTP server for ~30 s on RouterOS 7.20.8 (long-term).
 *
 * This script:
 *   1. Boots a RouterOS 7.20.8 x86 CHR at LOW memory (128 MB by default, or
 *      whatever is passed as --low-mem).
 *   2. Runs testCrashPaths() — sequential health-check probes for all known
 *      crash-path candidates, each with a 5 s timeout.
 *   3. Shuts the CHR down, then boots a fresh CHR at HIGH memory (512 MB by
 *      default, or --high-mem) and repeats.
 *   4. Prints a side-by-side summary and any timing data.
 *
 * Usage:
 *   bun scripts/test-crash-path-memory.ts                     # low=128, high=512, version=7.20.8
 *   bun scripts/test-crash-path-memory.ts --version 7.22.1    # same, different version
 *   bun scripts/test-crash-path-memory.ts --low-mem 256 --high-mem 1024
 *   bun scripts/test-crash-path-memory.ts --low-only           # skip high-mem run
 *   bun scripts/test-crash-path-memory.ts --high-only          # skip low-mem run
 *
 * The script is intentionally self-contained and plain — no Bun-specific
 * runtime features beyond process args, so the sequence is easy to follow
 * for anyone reading it (including MikroTik's C engineers).
 *
 * It re-uses `testCrashPaths()` and `RouterOSClient` from deep-inspect.ts so
 * the exact same probe logic is used in both local tests and CI.
 */

import { parseArgs } from "node:util";
import { QuickCHR } from "@tikoci/quickchr";
import {
  RouterOSClient,
  testCrashPaths,
  CRASH_PATHS,
} from "../deep-inspect.ts";

// ── CLI ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string", default: "7.20.8" },
    "low-mem": { type: "string", default: "128" },
    "high-mem": { type: "string", default: "512" },
    "low-only": { type: "boolean", default: false },
    "high-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Usage: bun scripts/test-crash-path-memory.ts [options]

Options:
  --version <ver>     RouterOS version to test (default: 7.20.8)
  --low-mem <mb>      CHR RAM for the low-memory run (default: 128)
  --high-mem <mb>     CHR RAM for the high-memory run (default: 512)
  --low-only          Skip the high-memory run
  --high-only         Skip the low-memory run
  --help              Show this help

Testing crash paths: ${CRASH_PATHS.join(", ")}
`);
  process.exit(0);
}

const ROS_VERSION = values.version as string;
const LOW_MEM = parseInt(values["low-mem"] as string, 10);
const HIGH_MEM = parseInt(values["high-mem"] as string, 10);
const runLow = !(values["high-only"] as boolean);
const runHigh = !(values["low-only"] as boolean);

// ── Probe function ─────────────────────────────────────────────────────────

interface RunResult {
  memMb: number;
  rosVersion: string;
  results: Awaited<ReturnType<typeof testCrashPaths>>;
  wallMs: number;
  restUrl: string;
}

async function runProbe(memMb: number): Promise<RunResult> {
  console.log(
    `\n${"─".repeat(60)}\nBooting RouterOS ${ROS_VERSION} (x86, ${memMb} MB RAM)...\n`,
  );

  const chr = await QuickCHR.start({
    arch: "x86",
    version: ROS_VERSION,
    mem: memMb,
    secureLogin: false,
    background: true,
  });

  console.log(`CHR ready: ${chr.restUrl}`);
  console.log(
    `Ports: http=${chr.ports.http}  ssh=${chr.ports.ssh}  api=${chr.ports.api}`,
  );

  const env = await chr.subprocessEnv();
  const client = new RouterOSClient(env.URLBASE, env.BASICAUTH);

  // Fetch RouterOS version for reporting
  const rosVer = await client.fetchVersion().catch(() => ROS_VERSION);
  console.log(`RouterOS version: ${rosVer}\n`);

  console.log(
    `Testing ${CRASH_PATHS.length} crash paths: ${CRASH_PATHS.join(", ")}`,
  );
  console.log("(Each probe has a 5 s timeout; hangs show as ✗)\n");

  const start = Date.now();
  const results = await testCrashPaths(client);
  const wallMs = Date.now() - start;

  console.log(`\nAll probes complete in ${(wallMs / 1000).toFixed(1)} s`);

  await chr.stop();
  console.log("CHR stopped.");

  return { memMb, rosVersion: rosVer, results, wallMs, restUrl: chr.restUrl };
}

// ── Main ───────────────────────────────────────────────────────────────────

const runResults: RunResult[] = [];

if (runLow) {
  runResults.push(await runProbe(LOW_MEM));
}
if (runHigh) {
  runResults.push(await runProbe(HIGH_MEM));
}

// ── Summary table ──────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(`SUMMARY — RouterOS ${ROS_VERSION} /console/inspect crash-path probe`);
console.log(`Paths tested: ${CRASH_PATHS.join(", ")}`);
console.log(`${"═".repeat(60)}\n`);

// Header
const memCols = runResults.map((r) => `${r.memMb} MB`);
const pathColW = Math.max(...CRASH_PATHS.map((p) => p.length), 8);
const memColW = 8;
const header = ["path".padEnd(pathColW), ...memCols.map((c) => c.padEnd(memColW))].join("  ");
console.log(header);
console.log("─".repeat(header.length));

for (const path of CRASH_PATHS) {
  const cols = runResults.map((r) => {
    const res = r.results.find((x) => x.path === path);
    if (!res) return "N/A".padEnd(memColW);
    return (res.safe ? "✓ safe" : `✗ HANG`).padEnd(memColW);
  });
  console.log([path.padEnd(pathColW), ...cols].join("  "));
}

console.log("─".repeat(header.length));
console.log(
  `${"total wall (s)".padEnd(pathColW)}  ${runResults.map((r) => `${(r.wallMs / 1000).toFixed(1)} s`.padEnd(memColW)).join("  ")}`,
);

// Structured output for copy-paste into support ticket
console.log(`\n${"─".repeat(60)}`);
console.log("JSON (for bug report):");
console.log(
  JSON.stringify(
    runResults.map((r) => ({
      memMb: r.memMb,
      routerosVersion: r.rosVersion,
      wallMs: r.wallMs,
      results: r.results.map((x) => ({
        path: x.path,
        safe: x.safe,
        ...(x.error ? { error: x.error } : {}),
      })),
    })),
    null,
    2,
  ),
);
