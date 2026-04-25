#!/usr/bin/env bun
/**
 * test-native-api-tags.ts — Research: native API tag-multiplexing reliability
 *                            under varying RAM and concurrency.
 *
 * Background (MikroTik SUP-127641 / docs/mikrotik-bug-native-api-inspect.md):
 *   `/console/inspect request=completion` via the RouterOS native API binary
 *   protocol (port 8728) returns non-deterministic results — ~20-30% of calls
 *   randomly drop one or more completion entries vs the REST transport.
 *   The same command via REST (port 80) is 100% deterministic.
 *
 * Open questions this script is designed to answer:
 *   Q1: Does RAM size affect the drop rate?
 *       (MikroTik suggested "try increasing RAM" in April 2026)
 *   Q2: Does the number of in-flight tags affect the drop rate?
 *       (Our enrichment code uses ENRICHMENT_BATCH_SIZE=50 concurrent tags)
 *   Q3: Does higher concurrency trigger CONNRESET (TCP teardown of all in-flight)?
 *       (Observed in CI on Linux/KVM; NOT reproduced on macOS/HVF previously)
 *
 * Methodology:
 *   For each RAM size in [low, high]:
 *     1. Boot a fresh RouterOS CHR via quickchr
 *     2. Establish REST baseline: expected completion count per probe path
 *     3. Connect native API (port 8728, one persistent TCP connection)
 *     4. For each concurrency level [1, 10, 25, 50]:
 *          Run ROUNDS queries across PROBE_PATHS using Promise.all(concurrency calls)
 *          Track per-query: drop (result < baseline), CONNRESET, response time
 *     5. Stop CHR, print results
 *   Final summary: drop-rate matrix [RAM × concurrency]
 *
 * Usage:
 *   bun scripts/test-native-api-tags.ts
 *   bun scripts/test-native-api-tags.ts --version 7.22.1
 *   bun scripts/test-native-api-tags.ts --low-mem 256 --high-mem 1024
 *   bun scripts/test-native-api-tags.ts --rounds 100            # more queries per cell
 *   bun scripts/test-native-api-tags.ts --concurrency 1,10,50   # custom levels
 *   bun scripts/test-native-api-tags.ts --low-only              # skip high-mem run
 *   bun scripts/test-native-api-tags.ts --high-only             # skip low-mem run
 *
 * Output:
 *   - Per-run per-concurrency table printed to stdout
 *   - JSON block at the end for copy-paste into bug reports
 */

import { parseArgs } from "node:util";
import { QuickCHR } from "@tikoci/quickchr";
import { RosAPI, RosErrorCode, type Sentence } from "../ros-api-protocol.ts";
import { RouterOSClient } from "../deep-inspect.ts";

// ── Probe paths (fixed paths with known stable completion sets) ────────────
// These paths are ARG-LEVEL paths (ending at a specific argument, not a command).
// `request=completion` at the arg level returns per-type hints with multiple items,
// which is what enrichWithCompletions() uses in production and what exercises
// the partial-drop bug (some entries missing vs complete response miss).
//
// Verified counts on 7.22.1 via REST:
//   ip/address/add/interface           → 8 total completions
//   ip/firewall/filter/add/chain       → 8 total completions
//   ip/firewall/filter/add/action      → 16 total completions
//   ip/firewall/filter/add/protocol    → 47 total completions (best for detecting partial drops)
//   interface/ethernet/set/speed       → 36 total completions
// Note: command-level paths (e.g. ip,address,add) return 1 placeholder completion,
//       insufficient for detecting partial entry drops.
const PROBE_PATHS: string[][] = [
  ["ip", "address", "add", "interface"],           // 8 completions
  ["ip", "firewall", "filter", "add", "chain"],    // 8 completions
  ["ip", "firewall", "filter", "add", "action"],   // 16 completions
  ["ip", "firewall", "filter", "add", "protocol"], // 47 completions — primary drop detector
  ["interface", "ethernet", "set", "speed"],       // 36 completions
];

// ── Default test parameters ────────────────────────────────────────────────

// Number of individual /console/inspect queries per probe path per concurrency level.
// At ROUNDS=50, each concurrency×path cell runs 50 queries → 50×5=250 total per level.
const DEFAULT_ROUNDS = 50;
const DEFAULT_LOW_MEM = 256;
const DEFAULT_HIGH_MEM = 1024;
const DEFAULT_VERSION = "7.22.1";
// Concurrency levels: number of simultaneous in-flight tags on one connection.
const DEFAULT_CONCURRENCY = [1, 10, 25, 50];

// ── CLI ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    version: { type: "string", default: DEFAULT_VERSION },
    "low-mem": { type: "string", default: String(DEFAULT_LOW_MEM) },
    "high-mem": { type: "string", default: String(DEFAULT_HIGH_MEM) },
    "low-only": { type: "boolean", default: false },
    "high-only": { type: "boolean", default: false },
    rounds: { type: "string", default: String(DEFAULT_ROUNDS) },
    concurrency: { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: false,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Usage: bun scripts/test-native-api-tags.ts [options]

Options:
  --version <ver>            RouterOS version (default: ${DEFAULT_VERSION})
  --low-mem <mb>             RAM for low-memory run (default: ${DEFAULT_LOW_MEM} MB)
  --high-mem <mb>            RAM for high-memory run (default: ${DEFAULT_HIGH_MEM} MB)
  --low-only                 Skip the high-memory run
  --high-only                Skip the low-memory run
  --rounds <n>               Queries per probe path per concurrency level (default: ${DEFAULT_ROUNDS})
  --concurrency <csv>        Comma-separated list of concurrency levels (default: ${DEFAULT_CONCURRENCY.join(",")})
  --help                     Show this help

Probe paths: ${PROBE_PATHS.map((p) => p.join("/")).join(", ")}
`);
  process.exit(0);
}

const ROS_VERSION = values.version as string;
const LOW_MEM = parseInt(values["low-mem"] as string, 10);
const HIGH_MEM = parseInt(values["high-mem"] as string, 10);
const ROUNDS = parseInt(values.rounds as string, 10);
const CONCURRENCY_LEVELS = values.concurrency
  ? (values.concurrency as string).split(",").map((n) => parseInt(n.trim(), 10))
  : DEFAULT_CONCURRENCY;
const runLow = !(values["high-only"] as boolean);
const runHigh = !(values["low-only"] as boolean);

// ── Types ──────────────────────────────────────────────────────────────────

interface PathBaseline {
  path: string[];
  restCount: number; // number of completion entries from REST
}

interface ConcurrencyResult {
  concurrency: number;
  queriesAttempted: number;
  queriesCompleted: number;     // returned a result (not CONNRESET or hang)
  queriesWithDrop: number;      // returned fewer entries than REST baseline
  connResets: number;           // number of CONNRESET events (each kills N in-flight commands)
  commandsLostToConnReset: number;
  hangs: number;                // calls that timed out (CALL_TIMEOUT_MS): router stopped responding
  totalMs: number;
  meanMsPerQuery: number;
  dropRatePct: string;
  abortedEarly: boolean;        // true if a hang caused us to abort remaining rounds
  perPath: PathConcurrencyResult[];
}

interface PathConcurrencyResult {
  path: string;
  restCount: number;
  queriesCompleted: number;
  drops: number;
  dropRatePct: string;
  minCount: number;
  maxCount: number;
}

interface RamRunResult {
  memMb: number;
  rosVersion: string;
  baselines: PathBaseline[];
  concurrencyResults: ConcurrencyResult[];
}

// ── REST baseline establishment ─────────────────────────────────────────────

async function establishBaselines(
  restClient: RouterOSClient,
): Promise<PathBaseline[]> {
  console.log("\nEstablishing REST baselines (3 reads each, must be identical)...");
  const baselines: PathBaseline[] = [];

  for (const path of PROBE_PATHS) {
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const completions = await restClient.fetchCompletion(path);
      counts.push(completions.length);
    }

    const allSame = counts.every((c) => c === counts[0]);
    const pathStr = path.join("/");
    if (!allSame) {
      console.warn(
        `  ⚠ ${pathStr}: REST is NOT deterministic! counts=${counts.join(",")} — skipping this path`,
      );
    } else if (counts[0] === 0) {
      console.log(`  ? ${pathStr}: REST returned 0 completions (path may not exist in this version) — skipping`);
    } else {
      console.log(`  ✓ ${pathStr}: ${counts[0]} completions`);
      baselines.push({ path, restCount: counts[0] });
    }
  }

  if (baselines.length === 0) {
    throw new Error("No probe paths returned completions — wrong RouterOS version?");
  }
  return baselines;
}

// ── Native API concurrency probe ───────────────────────────────────────────

/**
 * Per-call timeout: if the router stops responding (rather than closing the
 * connection), api.write() hangs forever. This cap prevents the test from
 * stalling indefinitely. The timed-out tag stays in RosAPI's pending Map,
 * so the caller MUST close and reconnect after any round with hangs.
 */
const CALL_TIMEOUT_MS = 30_000; // 30 seconds per individual call

type CallResult = { sentences: Sentence[] | null; ms: number; timedOut: boolean };

/** Wrap a single api.write() with a deadline. */
async function writeWithTimeout(api: RosAPI, path: string[]): Promise<CallResult> {
  const t0 = Date.now();
  const queryP = api
    .write("/console/inspect", "=request=completion", `=path=${path.join(",")}`)
    .then((sentences): CallResult => ({ sentences, ms: Date.now() - t0, timedOut: false }))
    .catch((err): CallResult => {
      const code = (err as { code?: string }).code ?? "";
      const isReset = code === RosErrorCode.CONNRESET || code === "CONNRESET";
      return {
        sentences: isReset ? null : ([] as Sentence[]),
        ms: Date.now() - t0,
        timedOut: false,
      };
    });

  const timeoutP = new Promise<CallResult>((resolve) =>
    setTimeout(() => resolve({ sentences: null, ms: CALL_TIMEOUT_MS, timedOut: true }), CALL_TIMEOUT_MS),
  );

  return Promise.race([queryP, timeoutP]);
}

/**
 * Send `count` /console/inspect requests simultaneously on one native API connection.
 * Returns per-call results; `timedOut:true` means the router stopped responding (no TCP close).
 */
async function sendConcurrentCompletions(
  api: RosAPI,
  path: string[],
  count: number,
): Promise<CallResult[]> {
  const tasks = Array.from({ length: count }, () => writeWithTimeout(api, path));
  return Promise.all(tasks);
}

// ── Per-concurrency-level runner ───────────────────────────────────────────

async function runAtConcurrency(
  apiHost: string,
  apiPort: number,
  baselines: PathBaseline[],
  concurrency: number,
  rounds: number,
): Promise<ConcurrencyResult> {
  console.log(`\n  Concurrency = ${concurrency} (${rounds} queries × ${baselines.length} paths = ${rounds * baselines.length} total)...`);

  const perPath: Map<string, PathConcurrencyResult> = new Map(
    baselines.map((b) => [
      b.path.join("/"),
      {
        path: b.path.join("/"),
        restCount: b.restCount,
        queriesCompleted: 0,
        drops: 0,
        dropRatePct: "0.0%",
        minCount: Infinity,
        maxCount: 0,
      },
    ]),
  );

  let totalAttempted = 0;
  let totalCompleted = 0;
  let totalDrops = 0;
  let connResets = 0;
  let commandsLostToConnReset = 0;
  let hangs = 0;
  let totalMs = 0;
  let abortedEarly = false;

  // Create and connect native API for this concurrency level
  let api = new RosAPI(apiHost, apiPort, "admin", "");
  await api.connect();

  // Rounds of queries: each round sends `concurrency` copies of EACH probe path.
  // We interleave paths within each round to exercise multiplexing across different commands.
  for (let round = 0; round < rounds; round++) {
    // Build one big concurrent batch: concurrency copies × each probe path
    // (interleaved so tags for different paths are all in-flight simultaneously)
    const allTasks: { pathKey: string; baseline: PathBaseline; promise: Promise<CallResult[]> }[] = [];

    for (const baseline of baselines) {
      allTasks.push({
        pathKey: baseline.path.join("/"),
        baseline,
        promise: sendConcurrentCompletions(api, baseline.path, concurrency),
      });
    }

    // Fire all paths' batches at once (outer concurrency: all paths simultaneously)
    const batchStart = Date.now();
    const allResults = await Promise.all(allTasks.map(({ promise }) => promise));
    const batchMs = Date.now() - batchStart;
    totalMs += batchMs;

    let roundHadHangs = false;
    for (let i = 0; i < allTasks.length; i++) {
      const { pathKey, baseline } = allTasks[i];
      const results = allResults[i];
      // pathKey is guaranteed to be in the map (built from baselines above)
      // biome-ignore lint/style/noNonNullAssertion: key always present
      const pr = perPath.get(pathKey)!;

      for (const { sentences, ms: _ms, timedOut } of results) {
        totalAttempted++;

        if (timedOut) {
          // Router stopped responding — no TCP close, just silence.
          // Outstanding tags remain in RosAPI pending Map; must reconnect.
          hangs++;
          roundHadHangs = true;
          continue;
        }

        if (sentences === null) {
          // CONNRESET — this entire batch's in-flight commands were killed
          connResets++;
          commandsLostToConnReset += concurrency * baselines.length; // rough estimate
          // RosAPI will auto-reconnect on next write() — don't count as drop
          continue;
        }

        totalCompleted++;
        pr.queriesCompleted++;

        const count = sentences.length;
        if (count < pr.minCount) pr.minCount = count;
        if (count > pr.maxCount) pr.maxCount = count;

        if (count < baseline.restCount) {
          totalDrops++;
          pr.drops++;
        }
      }
    }

    // If any calls timed out, the pending map has stale tags — must reconnect.
    if (roundHadHangs) {
      process.stdout.write(
        `    Round ${round + 1}/${rounds}: HANG detected (${hangs} total hangs) — closing and reconnecting API...\n`,
      );
      api.close();
      // If router is completely unresponsive (>half the batch hung), abort remaining rounds
      const hangPct = hangs / Math.max(totalAttempted, 1);
      if (hangPct > 0.5) {
        process.stdout.write(
          `    Hang rate ${(hangPct * 100).toFixed(0)}% > 50% — aborting remaining rounds for concurrency=${concurrency}\n`,
        );
        abortedEarly = true;
        break;
      }
      // Otherwise reconnect and continue
      api = new RosAPI(apiHost, apiPort, "admin", "");
      await api.connect();
    }

    // Progress report every 10 rounds
    if ((round + 1) % 10 === 0) {
      process.stdout.write(
        `    Round ${round + 1}/${rounds}: drops=${totalDrops}, connResets=${connResets}, hangs=${hangs}\n`,
      );
    }
  }

  api.close();

  // Finalize per-path stats
  for (const pr of perPath.values()) {
    pr.dropRatePct =
      pr.queriesCompleted > 0
        ? `${((pr.drops / pr.queriesCompleted) * 100).toFixed(1)}%`
        : "N/A";
    if (pr.minCount === Infinity) pr.minCount = 0;
  }

  const meanMsPerQuery =
    totalCompleted > 0 ? Math.round(totalMs / totalCompleted) : 0;
  const dropRatePct =
    totalCompleted > 0
      ? `${((totalDrops / totalCompleted) * 100).toFixed(1)}%`
      : "N/A";
  const hangNote = abortedEarly ? " [ABORTED: hang rate>50%]" : "";

  console.log(
    `    ↳ completed=${totalCompleted}, drops=${totalDrops} (${dropRatePct}), connResets=${connResets}, hangs=${hangs}, mean=${meanMsPerQuery}ms/query${hangNote}`,
  );

  return {
    concurrency,
    queriesAttempted: totalAttempted,
    queriesCompleted: totalCompleted,
    queriesWithDrop: totalDrops,
    connResets,
    commandsLostToConnReset,
    hangs,
    totalMs,
    meanMsPerQuery,
    dropRatePct,
    abortedEarly,
    perPath: [...perPath.values()],
  };
}

// ── Per-RAM-size runner ────────────────────────────────────────────────────

async function runAtRam(memMb: number): Promise<RamRunResult> {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`STARTING RUN: RouterOS ${ROS_VERSION}  RAM: ${memMb} MB`);
  console.log(`${"═".repeat(70)}`);

  console.log(`\nBooting CHR ${ROS_VERSION} (x86, ${memMb} MB)...`);
  const chr = await QuickCHR.start({
    arch: "x86",
    version: ROS_VERSION,
    mem: memMb,
    secureLogin: false,
    background: true,
  });

  console.log(`CHR ready: ${chr.restUrl}`);
  console.log(
    `Ports: http=${chr.ports.http}  api=${chr.ports.api}  ssh=${chr.ports.ssh}`,
  );

  const env = await chr.subprocessEnv();
  const restClient = new RouterOSClient(env.URLBASE, env.BASICAUTH);
  const rosVersion = await restClient.fetchVersion().catch(() => ROS_VERSION);
  console.log(`RouterOS version: ${rosVersion}`);

  // REST baseline
  const baselines = await establishBaselines(restClient);
  restClient.close?.();

  // Run each concurrency level (each level manages its own API connection + reconnect)
  const apiHost = "127.0.0.1";
  const apiPort = chr.ports.api;
  console.log(`\nNative API: ${apiHost}:${apiPort} (admin:)`);
  console.log(`  NOTE: per-call timeout is ${CALL_TIMEOUT_MS / 1000}s; hangs trigger reconnect and may abort the level.`);

  // Run each concurrency level
  const concurrencyResults: ConcurrencyResult[] = [];
  for (const c of CONCURRENCY_LEVELS) {
    const result = await runAtConcurrency(apiHost, apiPort, baselines, c, ROUNDS);
    concurrencyResults.push(result);
  }

  await chr.stop();
  console.log(`\nCHR stopped (${memMb} MB run complete).`);

  return { memMb, rosVersion, baselines, concurrencyResults };
}

// ── Main ───────────────────────────────────────────────────────────────────

const allRuns: RamRunResult[] = [];

if (runLow) allRuns.push(await runAtRam(LOW_MEM));
if (runHigh) allRuns.push(await runAtRam(HIGH_MEM));

// ── Summary table ──────────────────────────────────────────────────────────

console.log(`\n\n${"═".repeat(70)}`);
console.log(`RESULTS — RouterOS ${ROS_VERSION} Native API /console/inspect request=completion`);
console.log(`Probe paths: ${PROBE_PATHS.map((p) => p.join("/")).join(", ")}`);
console.log(`Rounds per cell: ${ROUNDS}`);
console.log(`${"═".repeat(70)}`);

// Drop-rate summary: rows=concurrency, cols=RAM
console.log("\n── Drop rate (queries returning fewer entries than REST baseline) ──\n");

const concColW = 14;
const ramColW = 14;
const headerParts = [
  "concurrency".padEnd(concColW),
  ...allRuns.map((r) => `${r.memMb} MB`.padEnd(ramColW)),
];
console.log(headerParts.join("  "));
console.log("─".repeat(headerParts.join("  ").length));

for (const c of CONCURRENCY_LEVELS) {
  const cols = allRuns.map((r) => {
    const cr = r.concurrencyResults.find((x) => x.concurrency === c);
    if (!cr) return "—".padEnd(ramColW);
    return `${cr.dropRatePct} (${cr.queriesWithDrop}/${cr.queriesCompleted})`.padEnd(ramColW);
  });
  console.log([`${c} tags`.padEnd(concColW), ...cols].join("  "));
}

// CONNRESET row
console.log("─".repeat(headerParts.join("  ").length));
for (const c of CONCURRENCY_LEVELS) {
  const cols = allRuns.map((r) => {
    const cr = r.concurrencyResults.find((x) => x.concurrency === c);
    if (!cr) return "—".padEnd(ramColW);
    return `${cr.connResets} resets`.padEnd(ramColW);
  });
  console.log([`${c}t CONNRESET`.padEnd(concColW), ...cols].join("  "));
}

// Hangs row
console.log("─".repeat(headerParts.join("  ").length));
for (const c of CONCURRENCY_LEVELS) {
  const cols = allRuns.map((r) => {
    const cr = r.concurrencyResults.find((x) => x.concurrency === c);
    if (!cr) return "—".padEnd(ramColW);
    const note = cr.abortedEarly ? " ABORTED" : "";
    return `${cr.hangs} hangs${note}`.padEnd(ramColW);
  });
  console.log([`${c}t HANGS`.padEnd(concColW), ...cols].join("  "));
}

// Mean response time
console.log("─".repeat(headerParts.join("  ").length));
for (const c of CONCURRENCY_LEVELS) {
  const cols = allRuns.map((r) => {
    const cr = r.concurrencyResults.find((x) => x.concurrency === c);
    if (!cr) return "—".padEnd(ramColW);
    return `~${cr.meanMsPerQuery} ms`.padEnd(ramColW);
  });
  console.log([`${c}t mean ms`.padEnd(concColW), ...cols].join("  "));
}

// Per-path breakdown for each run
for (const run of allRuns) {
  console.log(
    `\n── Per-path detail (RAM: ${run.memMb} MB, version: ${run.rosVersion}) ──\n`,
  );
  const pathColW = 34;
  const restColW = 8;
  const levelColW = 14;
  const ppHeader = [
    "path".padEnd(pathColW),
    "REST".padEnd(restColW),
    ...CONCURRENCY_LEVELS.map((c) => `${c}-tag drop`.padEnd(levelColW)),
  ].join("  ");
  console.log(ppHeader);
  console.log("─".repeat(ppHeader.length));

  for (const b of run.baselines) {
    const pathStr = b.path.join("/");
    const cols: string[] = [pathStr.padEnd(pathColW), String(b.restCount).padEnd(restColW)];
    for (const c of CONCURRENCY_LEVELS) {
      const cr = run.concurrencyResults.find((x) => x.concurrency === c);
      const pp = cr?.perPath.find((p) => p.path === pathStr);
      if (!pp) { cols.push("—".padEnd(levelColW)); continue; }
      cols.push(`${pp.dropRatePct} (${pp.drops}/${pp.queriesCompleted})`.padEnd(levelColW));
    }
    console.log(cols.join("  "));
  }
}

// JSON for bug report
console.log(`\n${"─".repeat(70)}`);
console.log("JSON (for bug report / docs update):");
console.log(
  JSON.stringify(
    allRuns.map((r) => ({
      memMb: r.memMb,
      routerosVersion: r.rosVersion,
      baselines: r.baselines.map((b) => ({
        path: b.path.join("/"),
        restCompletionCount: b.restCount,
      })),
      concurrencyMatrix: r.concurrencyResults.map((cr) => ({
        concurrency: cr.concurrency,
        totalQueries: cr.queriesCompleted,
        drops: cr.queriesWithDrop,
        dropRatePct: cr.dropRatePct,
        connResets: cr.connResets,
        hangs: cr.hangs,
        abortedEarly: cr.abortedEarly,
        meanMsPerQuery: cr.meanMsPerQuery,
        perPath: cr.perPath.map((pp) => ({
          path: pp.path,
          restCount: pp.restCount,
          drops: pp.drops,
          dropRatePct: pp.dropRatePct,
        })),
      })),
    })),
    null,
    2,
  ),
);
