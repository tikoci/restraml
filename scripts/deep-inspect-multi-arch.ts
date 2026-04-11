#!/usr/bin/env bun
/**
 * deep-inspect-multi-arch.ts — Phase 3.2 orchestrator
 *
 * Per-arch deep-inspect runs using quickchr as the CHR provisioner. Each arch
 * gets its own fresh CHR, all_packages installed, p1 trial license applied
 * (if MikroTik credentials are available), then `bun deep-inspect.ts --live`
 * runs against it as a subprocess. Produces `deep-inspect.x86.json` and
 * `deep-inspect.arm64.json` side-by-side (plus `openapi.<arch>.json`).
 *
 * No merging, no cross-arch fallback. Each file is a self-contained view of
 * its arch, suitable for diffing via `scripts/diff-deep-inspect.ts`.
 *
 * This script is the answer to BACKLOG.md Phase 3 "how do we iterate locally"
 * question. It is NOT intended for CI — CI is Phase 3.5 and will be a
 * separate workflow job.
 *
 * Usage:
 *   bun scripts/deep-inspect-multi-arch.ts                    # both arches, stable channel
 *   bun scripts/deep-inspect-multi-arch.ts --arch arm64       # just ARM64
 *   bun scripts/deep-inspect-multi-arch.ts --channel long-term
 *   bun scripts/deep-inspect-multi-arch.ts --version 7.22.1
 *   bun scripts/deep-inspect-multi-arch.ts --output-dir /tmp/inspect
 *
 * Licensing is handled inside quickchr's `start()` via `license: "p1"`:
 *   MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD env vars are checked first
 *   (CI path), then Bun.secrets (local `quickchr login`). If neither is set,
 *   quickchr logs a warning and skips licensing — the CHR runs free-tier
 *   (1 Mbps), which still produces correct output but is noticeably slower.
 *
 * Exit codes:
 *   0  all requested arches completed, zero crashPathsCrashed, zero argsFailed
 *   1  setup / invocation error
 *   2  one or more arches produced anomalies (crash paths or failed args)
 */

import { parseArgs } from "node:util";
import { QuickCHR, type Arch, type Channel } from "@tikoci/quickchr";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── CLI ────────────────────────────────────────────────────────────────────

interface Opts {
  arches: Arch[];
  channel: Channel;
  version?: string;
  outputDir: string;
  keepRunning: boolean;
}

function parseCli(): Opts {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      arch: { type: "string" },
      channel: { type: "string", default: "stable" },
      version: { type: "string" },
      "output-dir": { type: "string", default: "." },
      "keep-running": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const archRaw = values.arch;
  let arches: Arch[];
  if (!archRaw) {
    arches = ["x86", "arm64"];
  } else if (archRaw === "x86" || archRaw === "arm64") {
    arches = [archRaw];
  } else {
    throw new Error(`--arch must be x86, arm64, or omitted; got "${archRaw}"`);
  }

  const channel = (values.channel ?? "stable") as Channel;
  if (!["stable", "long-term", "testing", "development"].includes(channel)) {
    throw new Error(`--channel must be stable, long-term, testing, or development; got "${channel}"`);
  }

  return {
    arches,
    channel,
    version: values.version,
    outputDir: values["output-dir"] ?? ".",
    keepRunning: values["keep-running"] ?? false,
  };
}

function printUsage() {
  console.log(`
deep-inspect-multi-arch.ts — per-arch deep-inspect runs via quickchr

Usage:
  bun scripts/deep-inspect-multi-arch.ts [options]

Options:
  --arch <x86|arm64>   Run only one architecture (default: both)
  --channel <ch>       RouterOS release channel (default: stable)
  --version <ver>      Specific RouterOS version (overrides --channel)
  --output-dir <dir>   Where to write deep-inspect.<arch>.json (default: .)
  --keep-running       Leave CHRs running after crawl (for post-mortem)
  --help               Show this help

Output files (one per arch):
  <output-dir>/deep-inspect.<arch>.json
  <output-dir>/openapi.<arch>.json

Failure policy (BACKLOG.md principle 3):
  Nonzero crashPathsCrashed or argsFailed → exit 2 with full path list.
  Do not add to any skip list without confirming repro + filing upstream.

Licensing:
  Passed to quickchr as \`license: "p1"\` in StartOptions. quickchr resolves
  MikroTik web credentials from MIKROTIK_WEB_ACCOUNT / MIKROTIK_WEB_PASSWORD
  env vars (CI) or Bun.secrets (local, via \`quickchr login\`). If neither is
  set, quickchr warns and skips — CHR runs free-tier (1 Mbps), slower
  enrichment but correct output.
`.trim());
}

// ── Per-arch run ───────────────────────────────────────────────────────────

interface ArchResult {
  arch: Arch;
  version: string;
  deepInspectPath: string;
  crashPathsCrashed: string[];
  argsFailed: number;
  argsTimedOut: number;
  argsBlankOnRetry: number;
  argsTotal: number;
  argsWithCompletion: number;
  enrichmentDurationMs?: number;
}

async function runArch(arch: Arch, opts: Opts): Promise<ArchResult> {
  console.log(`\n━━━ ${arch.toUpperCase()} ━━━`);
  console.log(`Starting CHR (${arch}, channel=${opts.channel}${opts.version ? `, version=${opts.version}` : ""})...`);

  // `license: "p1"` is the one-shot form — quickchr resolves MikroTik creds
  // from env vars or Bun.secrets internally. Arch-aware defaults for mem and
  // boot timeout are handled inside quickchr based on cross-arch emulation
  // detection, so no manual bumping here. start() resolves REST-ready per its
  // docstring (all provisioning complete), so no belt-and-suspenders waitForBoot.
  const chr = await QuickCHR.start({
    arch,
    channel: opts.channel,
    version: opts.version,
    installAllPackages: true,
    secureLogin: false,
    background: true,
    license: "p1",
  });

  console.log(`CHR ready at ${chr.restUrl}`);
  console.log(`  ports: http=${chr.ports.http} ssh=${chr.ports.ssh} api=${chr.ports.api}`);

  // subprocessEnv() builds the env map for a child process against this CHR —
  // QUICKCHR_* keys plus URLBASE/BASICAUTH for restraml's existing deep-inspect.ts.
  const chrEnv = await chr.subprocessEnv();

  const deepInspectArgs = [
    "deep-inspect.ts",
    "--live",
    "--arch",
    arch,
    "--output-suffix",
    arch,
    "--output-dir",
    opts.outputDir,
    "--transport",
    "rest",
  ];

  console.log(`\nRunning: bun ${deepInspectArgs.join(" ")}`);
  console.log(`  URLBASE=${chrEnv.URLBASE}  BASICAUTH=${chrEnv.BASICAUTH}`);

  const proc = Bun.spawn(["bun", ...deepInspectArgs], {
    cwd: process.cwd(),
    env: { ...process.env, ...chrEnv },
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${arch}: deep-inspect.ts exited with code ${exitCode}`);
  }

  // Post-crawl load snapshot (best-effort) — informational, not load-bearing.
  // Proof-of-life for queryLoad(); the real retry/load correlation work wants
  // in-crawl sampling and is tracked in BACKLOG.md Phase 3.5.
  const load = await chr.queryLoad();
  if (load) {
    console.log(`  post-crawl load: cpu=${load.cpuPercent}% mem=${load.memUsedMb}MB`);
  }

  // Read the output file and extract _meta to check for anomalies.
  const deepInspectPath = join(opts.outputDir, `deep-inspect.${arch}.json`);
  const deepInspect = JSON.parse(readFileSync(deepInspectPath, "utf-8")) as {
    _meta: {
      version: string;
      architecture?: string;
      enrichmentDurationMs?: number;
      crashPathsCrashed: string[];
      completionStats: {
        argsTotal: number;
        argsWithCompletion: number;
        argsFailed: number;
        argsTimedOut: number;
        argsBlankOnRetry: number;
      };
    };
  };

  const meta = deepInspect._meta;
  const result: ArchResult = {
    arch,
    version: meta.version,
    deepInspectPath,
    crashPathsCrashed: meta.crashPathsCrashed ?? [],
    argsFailed: meta.completionStats.argsFailed,
    argsTimedOut: meta.completionStats.argsTimedOut,
    argsBlankOnRetry: meta.completionStats.argsBlankOnRetry,
    argsTotal: meta.completionStats.argsTotal,
    argsWithCompletion: meta.completionStats.argsWithCompletion,
    enrichmentDurationMs: meta.enrichmentDurationMs,
  };

  // Sanity check that --arch threaded through correctly
  if (meta.architecture !== arch) {
    throw new Error(
      `${arch}: _meta.architecture is "${meta.architecture}", expected "${arch}". ` +
      "--arch flag is not threading through deep-inspect.ts correctly.",
    );
  }

  // Destroy the CHR unless the caller asked to keep it running. destroy() is
  // stop + remove in one — throwaway semantics for orchestration, so we don't
  // leave machine directories behind between runs.
  if (!opts.keepRunning) {
    console.log(`Destroying ${arch} CHR...`);
    await chr.destroy();
  } else {
    console.log(`Leaving ${arch} CHR running (--keep-running): ${chr.name} at ${chr.restUrl}`);
  }

  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

function summarize(results: ArchResult[]): void {
  console.log("\n━━━ SUMMARY ━━━");
  for (const r of results) {
    const durS = r.enrichmentDurationMs ? `${(r.enrichmentDurationMs / 1000).toFixed(1)}s` : "?";
    console.log(
      `  ${r.arch.padEnd(5)} v${r.version}  ` +
      `${r.argsWithCompletion}/${r.argsTotal} enriched  ` +
      `${r.argsFailed} failed  ${r.argsTimedOut} retried  ` +
      `${r.argsBlankOnRetry} blank-on-retry  ` +
      `${r.crashPathsCrashed.length} crashed  ` +
      `(${durS})`,
    );
    console.log(`         → ${r.deepInspectPath}`);
  }
}

function checkAnomalies(results: ArchResult[]): boolean {
  // Per BACKLOG.md principle 3: any crash or failed arg is a signal worth
  // investigating, not a thing to silently tolerate.
  let anomalies = false;
  for (const r of results) {
    if (r.crashPathsCrashed.length > 0) {
      anomalies = true;
      console.error(`\n⚠ ${r.arch}: ${r.crashPathsCrashed.length} path(s) crashed during crawl:`);
      for (const p of r.crashPathsCrashed) console.error(`    ${p}`);
      console.error(
        "  → Investigate each before continuing. Check our client (URL encoding, JSON body),",
      );
      console.error(
        "    then reproduce against a stock CHR. If confirmed, file with MikroTik.",
      );
      console.error("    DO NOT add these to a skip list without a filed report.");
    }
    if (r.argsFailed > 0) {
      anomalies = true;
      console.error(`\n⚠ ${r.arch}: ${r.argsFailed} arg(s) failed enrichment (after retry).`);
      console.error(`  See ${r.deepInspectPath} _meta.completionStats for details.`);
    }
  }
  return anomalies;
}

async function main() {
  let opts: Opts;
  try {
    opts = parseCli();
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    printUsage();
    process.exit(1);
  }

  console.log(`deep-inspect multi-arch orchestrator`);
  console.log(`  arches: ${opts.arches.join(", ")}`);
  console.log(`  channel: ${opts.channel}${opts.version ? ` (pinned ${opts.version})` : ""}`);
  console.log(`  output: ${opts.outputDir}`);

  const results: ArchResult[] = [];
  let fatal = false;

  for (const arch of opts.arches) {
    try {
      const result = await runArch(arch, opts);
      results.push(result);
    } catch (e) {
      fatal = true;
      console.error(`\n✗ ${arch} run failed: ${(e as Error).message}`);
      if ((e as Error).stack) console.error((e as Error).stack);
      // Continue to the next arch — partial results are still useful for
      // investigation. The summary will make clear which ones finished.
    }
  }

  summarize(results);

  if (fatal) {
    console.error("\n✗ One or more arch runs failed — see errors above.");
    process.exit(1);
  }

  const anomalies = checkAnomalies(results);
  if (anomalies) {
    console.error("\n✗ Anomalies detected. Do not proceed until each is investigated.");
    process.exit(2);
  }

  console.log("\n✓ All runs clean: zero crash paths, zero failed args.");
}

await main();
