/**
 * benchmark.test.ts — REST API vs Native API benchmark suite for RouterOS
 *
 * Implements the Benchmark Test Suite Design from BACKLOG.md:
 *   Test 0: Environment validation (license, crash paths, baseline log)
 *   Test 1: Enrichment transport comparison (sequential)
 *   Test 2: Enrichment batch size sweep (native + REST)
 *   Test 3: Per-service latency profiling
 *   Test 4: Schema equivalence (REST vs native produce identical output on small subtree)
 *   Test 5: Full-tree enrichment timing — asserts argsFailed=0 on both transports
 *   Test 6: Failure diagnostics (retry failed native paths via REST)
 *   Test 7: Enrichment retry — 0 failures required (argsFailed must be 0 on both transports)
 *   Test 8: Full-tree transport equivalence — THE CI correctness gate
 *           REST and native must produce byte-identical completion data on the complete tree.
 *           Runs REST twice to verify determinism. 0 differences required. Any diff = CI failure.
 *
 * Requires a running RouterOS CHR with both REST API (port 80) and native API (port 8728).
 * CHR MUST be licensed as p1 (1 Gbit/s) — free license throttles to 1 Mbit/s.
 *
 * Run locally with mikropkl:
 *   QEMU_NETDEV="user,id=net0,hostfwd=tcp::9180-:80,hostfwd=tcp::9728-:8728" \
 *     ~/GitHub/mikropkl/Machines/chr.x86_64.qemu.7.20.8.utm/qemu.sh --background
 *   # Wait ~30s for boot, then license:
 *   curl -u admin: http://localhost:9180/rest/system/license/renew \
 *     -d '{"account":"Amm0","password":"...","level":"p1"}'
 *   URLBASE=http://localhost:9180/rest BASICAUTH=admin: API_PORT=9728 bun test benchmark.test.ts
 *
 * Or automated via:
 *   ./scripts/benchmark-qemu.sh
 *
 * Results are printed to stdout as structured JSON for easy comparison.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  RouterOSClient,
  NativeRouterOSClient,
  enrichWithCompletions,
  crawlInspectTree,
  generateOpenAPI,
  testCrashPaths,
  CRASH_PATHS,
  type InspectNode,
} from "./deep-inspect";

// ── Environment ────────────────────────────────────────────────────────────

const URLBASE = process.env.URLBASE;
const BASICAUTH = process.env.BASICAUTH;
const API_PORT = parseInt(process.env.API_PORT || "8728", 10);

// ── Failure Tracking ───────────────────────────────────────────────────────

interface FailedCall {
  path: string[];
  transport: "rest" | "native";
  error: string;
  durationMs: number;
}

/** Global list of failed completion calls — tracked across all tests */
const failedCalls: FailedCall[] = [];

/** Fetch completion with failure tracking and configurable timeout */
async function trackedFetchCompletion(
  client: RouterOSClient | NativeRouterOSClient,
  path: string[],
  transport: "rest" | "native",
  timeoutMs = 5_000,
): Promise<{ ok: boolean; durationMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    await client.fetchCompletion(path, controller.signal);
    clearTimeout(timeout);
    return { ok: true, durationMs: performance.now() - start };
  } catch (err) {
    clearTimeout(timeout);
    const durationMs = performance.now() - start;
    failedCalls.push({
      path,
      transport,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
    });
    return { ok: false, durationMs };
  }
}

/** Check if a path contains any CRASH_PATH segment */
function pathContainsCrashSegment(path: string[]): boolean {
  return path.some(seg => (CRASH_PATHS as readonly string[]).includes(seg));
}

// ── Log Capture ────────────────────────────────────────────────────────────

interface RouterLog {
  time: string;
  topics: string;
  message: string;
}

/** Fetch recent log entries from the router (REST API) */
async function fetchRouterLogs(since?: string): Promise<RouterLog[]> {
  if (!URLBASE || !BASICAUTH) return [];
  try {
    const resp = await fetch(`${URLBASE}/log`, {
      headers: { Authorization: `Basic ${btoa(BASICAUTH)}` },
    });
    if (!resp.ok) return [];
    const logs = (await resp.json()) as Array<Record<string, string>>;
    return logs
      .map(l => ({ time: l.time || "", topics: l.topics || "", message: l.message || "" }))
      .filter(l => !since || l.time >= since);
  } catch {
    return [];
  }
}

/** Check logs for crash indicators (supout.rif, service malfunction, etc.) */
function findCrashIndicators(logs: RouterLog[]): RouterLog[] {
  const crashPatterns = [
    /supout\.rif/i,
    /service malfunction/i,
    /rebooting/i,
    /kernel panic/i,
    /segmentation fault/i,
    /out of memory/i,
  ];
  return logs.filter(l =>
    crashPatterns.some(p => p.test(l.message) || p.test(l.topics))
  );
}

// ── Controlled Variables ───────────────────────────────────────────────────

interface ControlledVariables {
  routerVersion: string;
  licenseLevel: string;
  architecture: string;
  platform: string;
  hostArch: string;
  apiPort: number;
  restUrl: string;
  timestamp: string;
}

async function recordControlledVariables(
  restClient: RouterOSClient,
): Promise<ControlledVariables> {
  const version = await restClient.fetchVersion();

  // Fetch license level
  let licenseLevel = "unknown";
  try {
    const resp = await fetch(`${URLBASE}/system/license/get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(BASICAUTH || "")}`,
      },
      body: JSON.stringify({ "value-name": "level" }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { ret: string };
      licenseLevel = data.ret;
    }
  } catch {
    // License endpoint unavailable
  }

  // Fetch architecture
  let architecture = "unknown";
  try {
    const resp = await fetch(`${URLBASE}/system/resource/get`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(BASICAUTH || "")}`,
      },
      body: JSON.stringify({ "value-name": "architecture-name" }),
    });
    if (resp.ok) {
      const data = (await resp.json()) as { ret: string };
      architecture = data.ret;
    }
  } catch {
    // Resource endpoint unavailable
  }

  return {
    routerVersion: version,
    licenseLevel,
    architecture,
    platform: `${process.platform}/${process.arch}`,
    hostArch: process.arch,
    apiPort: API_PORT,
    restUrl: URLBASE || "",
    timestamp: new Date().toISOString(),
  };
}

// ── Result Types ───────────────────────────────────────────────────────────

interface BenchmarkResult {
  test: string;
  transport: string;
  durationMs: number;
  callCount: number;
  callsPerSecond: number;
  details?: Record<string, unknown>;
}

function printResult(result: BenchmarkResult) {
  console.log(`\n📊 ${result.test}`);
  console.log(`   Transport: ${result.transport}`);
  console.log(`   Duration:  ${result.durationMs.toFixed(0)}ms`);
  console.log(`   Calls:     ${result.callCount}`);
  console.log(`   Rate:      ${result.callsPerSecond.toFixed(1)} calls/s`);
  if (result.details) {
    for (const [k, v] of Object.entries(result.details)) {
      console.log(`   ${k}: ${JSON.stringify(v)}`);
    }
  }
}

// ── Skip Guard ─────────────────────────────────────────────────────────────

let restClient: RouterOSClient;
let nativeClient: NativeRouterOSClient;
let controlledVars: ControlledVariables;
let hasRouter = false;
let hasNative = false;
let baselineLogTime = "";

const allResults: BenchmarkResult[] = [];

beforeAll(async () => {
  if (!URLBASE || !BASICAUTH) {
    console.log("⚠️  URLBASE/BASICAUTH not set — skipping benchmarks");
    return;
  }

  restClient = new RouterOSClient(URLBASE, BASICAUTH);

  try {
    controlledVars = await recordControlledVariables(restClient);
    hasRouter = true;
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  RouterOS API Benchmark Suite");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Version:     ${controlledVars.routerVersion}`);
    console.log(`  License:     ${controlledVars.licenseLevel}`);
    console.log(`  Arch:        ${controlledVars.architecture}`);
    console.log(`  Host:        ${controlledVars.platform}`);
    console.log(`  REST URL:    ${controlledVars.restUrl}`);
    console.log(`  API Port:    ${controlledVars.apiPort}`);
    console.log(`  Timestamp:   ${controlledVars.timestamp}`);
    console.log("═══════════════════════════════════════════════════════\n");

    // CRITICAL: License must be p1 (1 Gbit/s). Free license throttles to 1 Mbit/s.
    if (controlledVars.licenseLevel === "free") {
      console.error("🛑  CHR license is 'free' (1 Mbit/s throttle!)");
      console.error(`    License with: curl -u admin: ${URLBASE}/system/license/renew \\`);
      console.error('      -d \'{"account":"...","password":"...","level":"p1"}\'');
      throw new Error("CHR must be licensed as p1 — free license throttles to 1 Mbit/s, invalidating benchmarks");
    }
  } catch (err) {
    if ((err as Error).message.includes("CHR must be licensed")) throw err;
    console.log(`⚠️  Router unreachable: ${(err as Error).message}`);
    return;
  }

  // Capture baseline log timestamp
  const logs = await fetchRouterLogs();
  if (logs.length > 0) {
    baselineLogTime = logs[logs.length - 1].time;
    console.log(`Baseline log timestamp: ${baselineLogTime}`);
  }

  // Try connecting native API
  const url = new URL(URLBASE);
  const colonIdx = BASICAUTH.indexOf(":");
  const user = BASICAUTH.substring(0, colonIdx);
  const password = BASICAUTH.substring(colonIdx + 1);

  try {
    nativeClient = new NativeRouterOSClient(url.hostname, API_PORT, user, password);
    await nativeClient.connect();
    const nativeVersion = await nativeClient.fetchVersion();
    console.log(`Native API connected (version: ${nativeVersion})`);
    hasNative = true;
  } catch (err) {
    console.log(`⚠️  Native API not available on port ${API_PORT}: ${(err as Error).message}`);
    console.log("   Native API tests will be skipped.");
    console.log("   Ensure port 8728 is forwarded: hostfwd=tcp::9728-:8728");
  }
});

afterAll(async () => {
  nativeClient?.close();

  // Check router logs for crash indicators
  if (hasRouter) {
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  POST-TEST LOG ANALYSIS");
    console.log("═══════════════════════════════════════════════════════");

    const logs = await fetchRouterLogs(baselineLogTime);
    const crashLogs = findCrashIndicators(logs);

    if (crashLogs.length > 0) {
      console.log(`\n🚨 CRASH INDICATORS FOUND (${crashLogs.length}):`);
      for (const log of crashLogs) {
        console.log(`   [${log.time}] ${log.topics}: ${log.message}`);
      }
    } else {
      console.log(`\n✓ No crash indicators in ${logs.length} log entries since baseline`);
    }

    // Show error-topic logs
    const errorLogs = logs.filter(l =>
      /error|critical|warning/i.test(l.topics)
    );
    if (errorLogs.length > 0) {
      console.log(`\n⚠️  Error/warning logs (${errorLogs.length}):`);
      for (const log of errorLogs.slice(-20)) {
        console.log(`   [${log.time}] ${log.topics}: ${log.message}`);
      }
    }
  }

  // Failed call summary
  if (failedCalls.length > 0) {
    console.log("\n═══════════════════════════════════════════════════════");
    console.log(`  FAILED CALLS SUMMARY (${failedCalls.length} failures)`);
    console.log("═══════════════════════════════════════════════════════");

    // Group by transport
    const restFails = failedCalls.filter(f => f.transport === "rest");
    const nativeFails = failedCalls.filter(f => f.transport === "native");

    console.log(`  REST failures:   ${restFails.length}`);
    console.log(`  Native failures: ${nativeFails.length}`);

    // Check crash path overlap
    const crashPathFails = failedCalls.filter(f => pathContainsCrashSegment(f.path));
    const nonCrashPathFails = failedCalls.filter(f => !pathContainsCrashSegment(f.path));
    console.log(`  On crash paths:  ${crashPathFails.length}`);
    console.log(`  Non-crash paths: ${nonCrashPathFails.length}`);

    // Show first 30 unique failed path+transport combos
    const uniqueFails = new Map<string, FailedCall>();
    for (const f of failedCalls) {
      const key = `${f.transport}:${f.path.join(",")}`;
      if (!uniqueFails.has(key)) uniqueFails.set(key, f);
    }
    console.log(`\n  Unique failed paths (${uniqueFails.size}):`);
    let shown = 0;
    for (const [, f] of uniqueFails) {
      if (shown >= 30) { console.log("  ... (truncated)"); break; }
      const crashFlag = pathContainsCrashSegment(f.path) ? " [CRASH_PATH]" : "";
      console.log(`    ${f.transport} /${f.path.join("/")} — ${f.error} (${f.durationMs.toFixed(0)}ms)${crashFlag}`);
      shown++;
    }
  }

  if (allResults.length > 0) {
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  BENCHMARK SUMMARY");
    console.log("═══════════════════════════════════════════════════════");
    console.log(JSON.stringify({
      controlledVariables: controlledVars,
      results: allResults,
      failedCalls: failedCalls.length,
      crashPathFailures: failedCalls.filter(f => pathContainsCrashSegment(f.path)).length,
    }, null, 2));
    console.log("═══════════════════════════════════════════════════════\n");
  }
});

function skip() { return !hasRouter; }
function skipNative() { return !hasNative; }

// ── Test 0: Environment validation ─────────────────────────────────────────

describe("Test 0: Environment validation", () => {
  test("license must be p1 (not free)", () => {
    if (skip()) return;
    expect(controlledVars.licenseLevel).not.toBe("free");
    expect(controlledVars.licenseLevel).toBe("p1");
    console.log(`  ✓ License: ${controlledVars.licenseLevel}`);
  });

  test("RouterOS version is not beta/rc (stable baseline)", () => {
    if (skip()) return;
    const v = controlledVars.routerVersion;
    const isBeta = /beta|rc/i.test(v);
    if (isBeta) {
      console.log(`  ⚠️  Version ${v} is beta/RC — results may include RouterOS bugs`);
    } else {
      console.log(`  ✓ Stable version: ${v}`);
    }
    // Warn but don't fail — we want data from betas too
  });

  test("crash path probe (REST)", async () => {
    if (skip()) return;
    console.log("  Probing CRASH_PATHS via REST...");
    const results = await testCrashPaths(restClient);
    const safe = results.filter(r => r.safe).length;
    const crashed = results.filter(r => !r.safe).length;
    console.log(`  REST crash paths: ${safe} safe, ${crashed} crashed/timed-out`);

    allResults.push({
      test: "Crash path probe (REST)",
      transport: "rest",
      durationMs: 0,
      callCount: results.length,
      callsPerSecond: 0,
      details: {
        results: results.map(r => ({ path: r.path, safe: r.safe, error: r.error })),
      },
    });
  }, 120_000);

  test("crash path probe (native)", async () => {
    if (skipNative()) return;
    if (!URLBASE || !BASICAUTH) return;
    console.log("  Probing CRASH_PATHS via native API...");

    // Use a fresh native connection for crash path testing
    const url = new URL(URLBASE);
    const colonIdx = BASICAUTH.indexOf(":");
    const user = BASICAUTH.substring(0, colonIdx);
    const password = BASICAUTH.substring(colonIdx + 1);

    const probeClient = new NativeRouterOSClient(url.hostname, API_PORT, user, password);
    await probeClient.connect();

    const results = await testCrashPaths(probeClient);
    probeClient.close();

    const safe = results.filter(r => r.safe).length;
    const crashed = results.filter(r => !r.safe).length;
    console.log(`  Native crash paths: ${safe} safe, ${crashed} crashed/timed-out`);

    allResults.push({
      test: "Crash path probe (native)",
      transport: "native",
      durationMs: 0,
      callCount: results.length,
      callsPerSecond: 0,
      details: {
        results: results.map(r => ({ path: r.path, safe: r.safe, error: r.error })),
      },
    });
  }, 120_000);

  test("check baseline router logs for pre-existing issues", async () => {
    if (skip()) return;
    const logs = await fetchRouterLogs();
    const crashes = findCrashIndicators(logs);
    if (crashes.length > 0) {
      console.log(`  ⚠️  Pre-existing crash indicators in log:`);
      for (const log of crashes) {
        console.log(`    [${log.time}] ${log.topics}: ${log.message}`);
      }
    } else {
      console.log(`  ✓ No pre-existing crash indicators (${logs.length} log entries)`);
    }
  }, 30_000);
});

// ── Test 1: Enrichment transport comparison ────────────────────────────────

describe("Test 1: Enrichment transport comparison", () => {

  test("REST sequential enrichment on /ip subtree", async () => {
    if (skip()) return;

    // Crawl /ip subtree via REST (smallish: ~200-400 args)
    const tree = await crawlInspectTree(restClient, ["ip"]);

    // Count args on crash paths before enrichment
    const argPaths = collectArgPaths(tree, ["ip"]);
    const onCrashPaths = argPaths.filter(p => pathContainsCrashSegment(p));
    console.log(`  Total args: ${argPaths.length}, on crash paths: ${onCrashPaths.length}`);

    const failsBefore = failedCalls.length;
    const start = performance.now();
    const stats = await enrichWithCompletions(tree, restClient, ["ip"]);
    const durationMs = performance.now() - start;
    const newFails = failedCalls.length - failsBefore;

    const result: BenchmarkResult = {
      test: "Enrichment /ip (REST sequential)",
      transport: "rest",
      durationMs,
      callCount: stats.argsTotal,
      callsPerSecond: stats.argsTotal / (durationMs / 1000),
      details: {
        argsWithCompletion: stats.argsWithCompletion,
        argsFailed: stats.argsFailed,
        trackedFailures: newFails,
        argsOnCrashPaths: onCrashPaths.length,
      },
    };
    allResults.push(result);
    printResult(result);

    expect(stats.argsTotal).toBeGreaterThan(0);
  }, 120_000);

  test("Native sequential enrichment on /ip subtree", async () => {
    if (skipNative()) return;

    // Crawl same /ip subtree via REST (to get identical tree structure)
    const tree = await crawlInspectTree(restClient, ["ip"]);

    const argPaths = collectArgPaths(tree, ["ip"]);
    const onCrashPaths = argPaths.filter(p => pathContainsCrashSegment(p));
    console.log(`  Total args: ${argPaths.length}, on crash paths: ${onCrashPaths.length}`);

    const failsBefore = failedCalls.length;
    const start = performance.now();
    const stats = await enrichWithCompletions(tree, nativeClient, ["ip"]);
    const durationMs = performance.now() - start;
    const newFails = failedCalls.length - failsBefore;

    const result: BenchmarkResult = {
      test: "Enrichment /ip (native sequential)",
      transport: "native",
      durationMs,
      callCount: stats.argsTotal,
      callsPerSecond: stats.argsTotal / (durationMs / 1000),
      details: {
        argsWithCompletion: stats.argsWithCompletion,
        argsFailed: stats.argsFailed,
        trackedFailures: newFails,
        argsOnCrashPaths: onCrashPaths.length,
      },
    };
    allResults.push(result);
    printResult(result);

    // Check logs right after native enrichment for crash indicators
    const logs = await fetchRouterLogs(baselineLogTime);
    const crashes = findCrashIndicators(logs);
    if (crashes.length > 0) {
      console.log(`  🚨 Crash indicators after native enrichment:`);
      for (const log of crashes) console.log(`    [${log.time}] ${log.message}`);
    }

    expect(stats.argsTotal).toBeGreaterThan(0);
  }, 120_000);

  test("compare REST vs native enrichment speed on /ip", () => {
    if (skipNative()) return;
    const restResult = allResults.find(r => r.test.includes("REST sequential"));
    const nativeResult = allResults.find(r => r.test.includes("native sequential"));
    if (!restResult || !nativeResult) return;

    const speedup = restResult.durationMs / nativeResult.durationMs;
    console.log(`\n📈 REST vs Native speedup: ${speedup.toFixed(2)}x`);
    console.log(`   REST:   ${restResult.durationMs.toFixed(0)}ms (${restResult.callsPerSecond.toFixed(1)} calls/s)`);
    console.log(`   Native: ${nativeResult.durationMs.toFixed(0)}ms (${nativeResult.callsPerSecond.toFixed(1)} calls/s)`);

    // No assertion on which is faster — that's what we're measuring
    expect(speedup).toBeGreaterThan(0);
  });
});

// ── Test 2: Batch size sweep (enrichment, native only) ─────────────────────

describe("Test 2: Batch size sweep (native enrichment)", () => {
  // We test by calling enrichWithCompletions which uses ENRICHMENT_BATCH_SIZE=50 internally.
  // For a proper sweep we'd need to modify ENRICHMENT_BATCH_SIZE. Instead, we measure
  // sequential (1-at-a-time) vs batched (default 50) by timing raw completion calls.
  // Also tests REST for comparison to isolate protocol-level concurrency overhead.

  const BATCH_SIZES = [1, 10, 50];
  const SAMPLE_SIZE = 100; // number of completion calls per test

  // Crawl once and share paths across all batch tests
  let sharedArgPaths: string[][] = [];

  test("collect sample arg paths from /ip", async () => {
    if (skip()) return;
    const tree = await crawlInspectTree(restClient, ["ip"]);
    sharedArgPaths = collectArgPaths(tree, ["ip"]).slice(0, SAMPLE_SIZE);
    console.log(`\n  Collected ${sharedArgPaths.length} arg paths for batch sweep`);
    expect(sharedArgPaths.length).toBeGreaterThan(0);
  }, 60_000);

  for (const batchSize of BATCH_SIZES) {
    test(`native batch=${batchSize}: ${SAMPLE_SIZE} completion calls`, async () => {
      if (skipNative() || sharedArgPaths.length === 0) return;

      // Verify native connection is alive before each batch test
      try {
        await nativeClient.fetchVersion();
      } catch {
        console.log("  ⚠️  Native connection lost — skipping");
        return;
      }

      const PER_CALL_TIMEOUT_MS = 3_000; // Reduced from 5s to detect hangers faster
      const argPaths = sharedArgPaths;
      let completedCalls = 0;
      let timedOutCalls = 0;
      const timedOutPaths: string[][] = [];

      const start = performance.now();
      for (let i = 0; i < argPaths.length; i += batchSize) {
        const batch = argPaths.slice(i, i + batchSize);
        await Promise.all(batch.map(async (path) => {
          const result = await trackedFetchCompletion(nativeClient, path, "native", PER_CALL_TIMEOUT_MS);
          if (result.ok) {
            completedCalls++;
          } else {
            timedOutCalls++;
            timedOutPaths.push(path);
          }
        }));
      }
      const durationMs = performance.now() - start;

      if (timedOutPaths.length > 0) {
        console.log(`  ⚠️  Timed out paths (${timedOutPaths.length}):`);
        for (const p of timedOutPaths.slice(0, 10)) {
          const crashFlag = pathContainsCrashSegment(p) ? " [CRASH_PATH]" : "";
          console.log(`    /${p.join("/")}${crashFlag}`);
        }
      }

      const result: BenchmarkResult = {
        test: `Batch sweep (native, batch=${batchSize})`,
        transport: "native",
        durationMs,
        callCount: argPaths.length,
        callsPerSecond: argPaths.length / (durationMs / 1000),
        details: { batchSize, completedCalls, timedOutCalls, timedOutPaths: timedOutPaths.map(p => p.join(",")) },
      };
      allResults.push(result);
      printResult(result);

      expect(durationMs).toBeGreaterThan(0);
    }, 120_000);
  }

  // Also test REST batching for direct comparison
  for (const batchSize of [1, 50]) {
    test(`REST batch=${batchSize}: ${SAMPLE_SIZE} completion calls`, async () => {
      if (skip() || sharedArgPaths.length === 0) return;

      const argPaths = sharedArgPaths;

      const start = performance.now();
      for (let i = 0; i < argPaths.length; i += batchSize) {
        const batch = argPaths.slice(i, i + batchSize);
        await Promise.all(batch.map(path =>
          restClient.fetchCompletion(path).catch(() => [])
        ));
      }
      const durationMs = performance.now() - start;

      const result: BenchmarkResult = {
        test: `Batch sweep (REST, batch=${batchSize})`,
        transport: "rest",
        durationMs,
        callCount: argPaths.length,
        callsPerSecond: argPaths.length / (durationMs / 1000),
        details: { batchSize },
      };
      allResults.push(result);
      printResult(result);

      expect(durationMs).toBeGreaterThan(0);
    }, 120_000);
  }
});

// ── Test 3: Per-service latency profiling ──────────────────────────────────

describe("Test 3: Per-service latency profiling", () => {
  const SAMPLE_PER_SERVICE = 30;
  const TOP_LEVEL_SERVICES = ["ip", "system", "interface", "routing", "tool"];

  for (const service of TOP_LEVEL_SERVICES) {
    test(`service latency: /${service}`, async () => {
      if (skipNative()) return;

      // Crawl subtree and sample arg paths
      let tree: InspectNode;
      try {
        tree = await crawlInspectTree(restClient, [service]);
      } catch {
        console.log(`  /${service} crawl failed — skipping`);
        return;
      }

      const argPaths = collectArgPaths(tree, [service]).slice(0, SAMPLE_PER_SERVICE);
      if (argPaths.length === 0) {
        console.log(`  /${service}: no args found`);
        return;
      }

      // Measure individual call latencies (native)
      const nativeLatencies: number[] = [];
      for (const path of argPaths) {
        const s = performance.now();
        try {
          await nativeClient.fetchCompletion(path);
        } catch {
          // Skip failed calls
        }
        nativeLatencies.push(performance.now() - s);
      }

      // Measure individual call latencies (REST)
      const restLatencies: number[] = [];
      for (const path of argPaths) {
        const s = performance.now();
        try {
          await restClient.fetchCompletion(path);
        } catch {
          // Skip failed calls
        }
        restLatencies.push(performance.now() - s);
      }

      const nativeStats = latencyStats(nativeLatencies);
      const restStats = latencyStats(restLatencies);

      const nativeResult: BenchmarkResult = {
        test: `Service latency /${service} (native)`,
        transport: "native",
        durationMs: nativeLatencies.reduce((a, b) => a + b, 0),
        callCount: nativeLatencies.length,
        callsPerSecond: nativeLatencies.length / (nativeLatencies.reduce((a, b) => a + b, 0) / 1000),
        details: { ...nativeStats, service },
      };
      const restResult: BenchmarkResult = {
        test: `Service latency /${service} (REST)`,
        transport: "rest",
        durationMs: restLatencies.reduce((a, b) => a + b, 0),
        callCount: restLatencies.length,
        callsPerSecond: restLatencies.length / (restLatencies.reduce((a, b) => a + b, 0) / 1000),
        details: { ...restStats, service },
      };
      allResults.push(nativeResult, restResult);

      console.log(`\n  /${service} (${argPaths.length} args):`);
      console.log(`    Native — mean: ${nativeStats.meanMs.toFixed(1)}ms  p50: ${nativeStats.p50Ms.toFixed(1)}ms  p95: ${nativeStats.p95Ms.toFixed(1)}ms  p99: ${nativeStats.p99Ms.toFixed(1)}ms`);
      console.log(`    REST   — mean: ${restStats.meanMs.toFixed(1)}ms  p50: ${restStats.p50Ms.toFixed(1)}ms  p95: ${restStats.p95Ms.toFixed(1)}ms  p99: ${restStats.p99Ms.toFixed(1)}ms`);

      expect(nativeLatencies.length).toBeGreaterThan(0);
    }, 120_000);
  }
});

// ── Test 4: Schema equivalence (REST vs native produce identical output) ──

describe("Test 4: Schema equivalence", () => {
  test("crawl /ip/address via REST and native produce same tree structure", async () => {
    if (skipNative()) return;

    // Use /ip/address (small subtree) instead of all /ip to avoid long crawl times
    const subtree = ["ip", "address"];

    console.log("  Crawling /ip/address via REST...");
    const restStart = performance.now();
    const restTree = await crawlInspectTree(restClient, subtree);
    const restCrawlMs = performance.now() - restStart;

    console.log("  Crawling /ip/address via native...");
    const nativeStart = performance.now();
    const nativeTree = await crawlInspectTree(nativeClient, subtree);
    const nativeCrawlMs = performance.now() - nativeStart;

    console.log(`\n  Crawl /ip/address timing:`);
    console.log(`    REST:   ${restCrawlMs.toFixed(0)}ms (${countNodes(restTree)} nodes)`);
    console.log(`    Native: ${nativeCrawlMs.toFixed(0)}ms (${countNodes(nativeTree)} nodes)`);
    console.log(`    Speedup: ${(restCrawlMs / nativeCrawlMs).toFixed(1)}x (native vs REST)`);

    // Compare structure: same keys at every level
    const restKeys = collectAllKeys(restTree).sort();
    const nativeKeys = collectAllKeys(nativeTree).sort();

    const missingInNative = restKeys.filter(k => !nativeKeys.includes(k));
    const extraInNative = nativeKeys.filter(k => !restKeys.includes(k));

    if (missingInNative.length > 0) {
      console.log(`  ⚠️  Keys in REST but not native: ${missingInNative.slice(0, 20).join(", ")}`);
    }
    if (extraInNative.length > 0) {
      console.log(`  ⚠️  Keys in native but not REST: ${extraInNative.slice(0, 20).join(", ")}`);
    }

    console.log(`  REST keys:   ${restKeys.length}`);
    console.log(`  Native keys: ${nativeKeys.length}`);

    // Record crawl comparison as a result
    allResults.push({
      test: "Crawl /ip/address (REST)",
      transport: "rest",
      durationMs: restCrawlMs,
      callCount: countNodes(restTree),
      callsPerSecond: countNodes(restTree) / (restCrawlMs / 1000),
    });
    allResults.push({
      test: "Crawl /ip/address (native)",
      transport: "native",
      durationMs: nativeCrawlMs,
      callCount: countNodes(nativeTree),
      callsPerSecond: countNodes(nativeTree) / (nativeCrawlMs / 1000),
    });

    expect(restKeys).toEqual(nativeKeys);
  }, 120_000);

  test("enrichment via REST and native produce same _completion keys", async () => {
    if (skipNative()) return;

    // Use a small known subtree for deterministic comparison
    const path = ["system", "identity"];

    const restTree = await crawlInspectTree(restClient, path);
    const nativeTree = await crawlInspectTree(restClient, path); // same crawl source

    await enrichWithCompletions(restTree, restClient, path);
    await enrichWithCompletions(nativeTree, nativeClient, path);

    // Compare _completion keys on all arg nodes
    const restCompletions = collectCompletionKeys(restTree);
    const nativeCompletions = collectCompletionKeys(nativeTree);

    console.log(`  REST completions: ${Object.keys(restCompletions).length} args with completions`);
    console.log(`  Native completions: ${Object.keys(nativeCompletions).length} args with completions`);

    // Verify same args have completions
    const restArgPaths = Object.keys(restCompletions).sort();
    const nativeArgPaths = Object.keys(nativeCompletions).sort();
    expect(restArgPaths).toEqual(nativeArgPaths);

    // Compare completion values — allow minor non-determinism (RouterOS may return
    // slightly different completions depending on connection/session state)
    let matchCount = 0;
    let diffCount = 0;
    for (const argPath of restArgPaths) {
      const restVals = restCompletions[argPath].sort();
      const nativeVals = nativeCompletions[argPath].sort();
      if (JSON.stringify(restVals) === JSON.stringify(nativeVals)) {
        matchCount++;
      } else {
        diffCount++;
        const onlyInRest = restVals.filter(v => !nativeVals.includes(v));
        const onlyInNative = nativeVals.filter(v => !restVals.includes(v));
        console.log(`  ⚠️  Completion diff at "${argPath}":`);
        if (onlyInRest.length > 0) console.log(`       REST only: ${onlyInRest.join(", ")}`);
        if (onlyInNative.length > 0) console.log(`       Native only: ${onlyInNative.join(", ")}`);
      }
    }

    console.log(`  Completion match: ${matchCount}/${restArgPaths.length} identical, ${diffCount} differ`);
    // All completions must match — enrichWithCompletions retry pass guarantees 0 argsFailed,
    // and RouterOS completion data is static (not session-dependent).
    expect(diffCount).toBe(0);
  }, 60_000);

  test("OpenAPI generation is identical from REST vs native crawl", async () => {
    if (skipNative()) return;

    const path = ["system", "identity"];
    const version = controlledVars.routerVersion;

    // Crawl via both transports
    const restTree = await crawlInspectTree(restClient, path);
    const nativeTree = await crawlInspectTree(nativeClient, path);

    // Wrap for OpenAPI generation
    const wrapTree = (inner: InspectNode): InspectNode => ({
      system: { _type: "dir", identity: { _type: "dir", ...inner } },
    });

    const restOpenAPI = generateOpenAPI(wrapTree(restTree), version);
    const nativeOpenAPI = generateOpenAPI(wrapTree(nativeTree), version);

    // Compare paths
    const restPaths = Object.keys(restOpenAPI.paths).sort();
    const nativePaths = Object.keys(nativeOpenAPI.paths).sort();

    console.log(`  REST OpenAPI paths:   ${restPaths.length}`);
    console.log(`  Native OpenAPI paths: ${nativePaths.length}`);

    expect(restPaths).toEqual(nativePaths);

    // Compare full serialized output (deterministic)
    const restJson = JSON.stringify(restOpenAPI);
    const nativeJson = JSON.stringify(nativeOpenAPI);
    expect(restJson).toEqual(nativeJson);
  }, 300_000);
});

// ── Test 5: Full-tree enrichment timing (CI benchmark) ─────────────────────

describe("Test 5: Full-tree enrichment timing", () => {
  test("full-tree enrichment via REST", async () => {
    if (skip()) return;

    // Load a real inspect.json for full-tree test
    const inspectFile = findLatestInspectJson();
    if (!inspectFile) {
      console.log("No inspect.json found in docs/ — skipping full-tree test");
      return;
    }

    console.log(`  Loading: ${inspectFile}`);
    const tree: InspectNode = await Bun.file(inspectFile).json();

    const start = performance.now();
    const stats = await enrichWithCompletions(tree, restClient);
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      test: "Full-tree enrichment (REST)",
      transport: "rest",
      durationMs,
      callCount: stats.argsTotal,
      callsPerSecond: stats.argsTotal / (durationMs / 1000),
      details: {
        argsWithCompletion: stats.argsWithCompletion,
        argsFailed: stats.argsFailed,
        inspectFile,
      },
    };
    allResults.push(result);
    printResult(result);

    expect(stats.argsTotal).toBeGreaterThan(1000);
    expect(stats.argsFailed).toBe(0); // retry pass must recover all paths
  }, 600_000); // 10 min timeout

  test("full-tree enrichment via native API", async () => {
    if (skipNative()) return;

    const inspectFile = findLatestInspectJson();
    if (!inspectFile) {
      console.log("No inspect.json found — skipping");
      return;
    }

    console.log(`  Loading: ${inspectFile}`);
    const tree: InspectNode = await Bun.file(inspectFile).json();

    const start = performance.now();
    const stats = await enrichWithCompletions(tree, nativeClient);
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      test: "Full-tree enrichment (native)",
      transport: "native",
      durationMs,
      callCount: stats.argsTotal,
      callsPerSecond: stats.argsTotal / (durationMs / 1000),
      details: {
        argsWithCompletion: stats.argsWithCompletion,
        argsFailed: stats.argsFailed,
        inspectFile,
      },
    };
    allResults.push(result);
    printResult(result);

    expect(stats.argsTotal).toBeGreaterThan(1000);
    expect(stats.argsFailed).toBe(0); // retry pass must recover all paths
  }, 600_000);

  test("full-tree crawl: REST vs native", async () => {
    if (skipNative()) return;

    // REST crawl
    console.log("  Crawling full tree via REST...");
    const restStart = performance.now();
    const restTree = await crawlInspectTree(restClient);
    const restDurationMs = performance.now() - restStart;
    const restNodeCount = countNodes(restTree);

    const restResult: BenchmarkResult = {
      test: "Full crawl (REST)",
      transport: "rest",
      durationMs: restDurationMs,
      callCount: restNodeCount,
      callsPerSecond: restNodeCount / (restDurationMs / 1000),
    };
    allResults.push(restResult);
    printResult(restResult);

    // Native crawl — set a timeout relative to REST crawl time
    // Native should be faster for crawl (sequential), so 3× REST time is generous
    const nativeCrawlTimeout = Math.max(restDurationMs * 3, 300_000);
    console.log(`  Crawling full tree via native API (timeout: ${(nativeCrawlTimeout / 1000).toFixed(0)}s)...`);

    let nativeTree: InspectNode | null = null;
    let nativeDurationMs = 0;
    try {
      const nativeStart = performance.now();
      const crawlPromise = crawlInspectTree(nativeClient);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Native crawl timed out")), nativeCrawlTimeout)
      );
      nativeTree = await Promise.race([crawlPromise, timeoutPromise]);
      nativeDurationMs = performance.now() - nativeStart;
    } catch (err) {
      console.log(`  ⚠️  Native full crawl failed: ${(err as Error).message}`);
      console.log(`  REST crawl completed: ${restDurationMs.toFixed(0)}ms, ${restNodeCount} nodes`);
      // Record partial result
      allResults.push({
        test: "Full crawl (native)",
        transport: "native",
        durationMs: -1,
        callCount: 0,
        callsPerSecond: 0,
        details: { error: (err as Error).message },
      });
      // Don't fail — the REST crawl result is still valuable
      expect(restNodeCount).toBeGreaterThan(0);
      return;
    }

    const nativeNodeCount = countNodes(nativeTree);

    const nativeResult: BenchmarkResult = {
      test: "Full crawl (native)",
      transport: "native",
      durationMs: nativeDurationMs,
      callCount: nativeNodeCount,
      callsPerSecond: nativeNodeCount / (nativeDurationMs / 1000),
    };
    allResults.push(nativeResult);
    printResult(nativeResult);

    const speedup = restDurationMs / nativeDurationMs;
    console.log(`\n📈 Full crawl speedup: ${speedup.toFixed(1)}x (native vs REST)`);
    console.log(`   REST:   ${restDurationMs.toFixed(0)}ms (${restNodeCount} nodes)`);
    console.log(`   Native: ${nativeDurationMs.toFixed(0)}ms (${nativeNodeCount} nodes)`);

    // Trees should have same number of nodes (same /console/inspect data source)
    expect(nativeNodeCount).toBe(restNodeCount);
  }, 3600_000); // 60 min timeout — full REST crawl can take 25+ minutes
});

// ── Test 6: Failure diagnostics ────────────────────────────────────────────

describe("Test 6: Failure diagnostics", () => {
  test("retry failed native paths via REST (and vice versa)", async () => {
    if (!hasRouter || failedCalls.length === 0) {
      console.log("  No failures to diagnose");
      return;
    }

    // Get unique failed paths per transport
    const nativeFails = new Map<string, string[]>();
    const restFails = new Map<string, string[]>();
    for (const f of failedCalls) {
      const key = f.path.join(",");
      if (f.transport === "native") nativeFails.set(key, f.path);
      else restFails.set(key, f.path);
    }

    console.log(`\n  Diagnosing ${nativeFails.size} native failures and ${restFails.size} REST failures`);

    // Retry native failures via REST
    let nativeOnlyFailures = 0;
    let bothFail = 0;
    let nativeFailRestOk = 0;

    if (nativeFails.size > 0) {
      console.log(`\n  Retrying ${nativeFails.size} native-failed paths via REST:`);
      for (const [, path] of [...nativeFails].slice(0, 50)) {
        const crashFlag = pathContainsCrashSegment(path) ? " [CRASH_PATH]" : "";
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3_000);
          await restClient.fetchCompletion(path, controller.signal);
          clearTimeout(timeout);
          nativeFailRestOk++;
          console.log(`    ✓ REST OK: /${path.join("/")}${crashFlag}`);
        } catch (err) {
          bothFail++;
          console.log(`    ✗ REST also fails: /${path.join("/")} — ${(err as Error).message}${crashFlag}`);
        }
      }
      nativeOnlyFailures = nativeFailRestOk;
    }

    // Retry REST failures via native
    let restOnlyFailures = 0;
    let restFailNativeOk = 0;

    if (restFails.size > 0 && hasNative) {
      console.log(`\n  Retrying ${restFails.size} REST-failed paths via native:`);
      for (const [, path] of [...restFails].slice(0, 50)) {
        const crashFlag = pathContainsCrashSegment(path) ? " [CRASH_PATH]" : "";
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3_000);
          await nativeClient.fetchCompletion(path, controller.signal);
          clearTimeout(timeout);
          restFailNativeOk++;
          console.log(`    ✓ Native OK: /${path.join("/")}${crashFlag}`);
        } catch {
          console.log(`    ✗ Native also fails: /${path.join("/")}${crashFlag}`);
        }
      }
      restOnlyFailures = restFailNativeOk;
    }

    console.log(`\n  Diagnosis summary:`);
    console.log(`    Native-only failures (transport-specific): ${nativeOnlyFailures}`);
    console.log(`    REST-only failures (transport-specific): ${restOnlyFailures}`);
    console.log(`    Both transports fail (path-specific): ${bothFail}`);
    console.log(`    Native fails that REST recovers: ${nativeFailRestOk}`);
    console.log(`    REST fails that native recovers: ${restFailNativeOk}`);

    allResults.push({
      test: "Failure diagnostics",
      transport: "both",
      durationMs: 0,
      callCount: nativeFails.size + restFails.size,
      callsPerSecond: 0,
      details: {
        nativeUniqueFails: nativeFails.size,
        restUniqueFails: restFails.size,
        nativeOnlyFailures,
        restOnlyFailures,
        bothFail,
        nativeFailRestOk,
        restFailNativeOk,
      },
    });
  }, 120_000);

  test("check router logs after all tests", async () => {
    if (skip()) return;

    const logs = await fetchRouterLogs(baselineLogTime);
    const crashes = findCrashIndicators(logs);

    console.log(`\n  Total log entries since baseline: ${logs.length}`);
    if (crashes.length > 0) {
      console.log(`  🚨 CRASH INDICATORS (${crashes.length}):`);
      for (const log of crashes) {
        console.log(`    [${log.time}] ${log.topics}: ${log.message}`);
      }
      // This is important data — don't fail, just report
    } else {
      console.log(`  ✓ No crash indicators`);
    }

    // Show all error-level logs
    const errorLogs = logs.filter(l => /error|critical/i.test(l.topics));
    if (errorLogs.length > 0) {
      console.log(`  Error/critical logs (${errorLogs.length}):`);
      for (const log of errorLogs.slice(-10)) {
        console.log(`    [${log.time}] ${log.topics}: ${log.message}`);
      }
    }
  }, 30_000);
});

// ── Test 7: Enrichment failure path analysis ───────────────────────────────

describe("Test 7: Enrichment retry — 0 failures required", () => {
  /**
   * Goal: Verify that enrichWithCompletions produces 0 argsFailed on both transports.
   *
   * Root cause (found in investigation): Under concurrent batch=50 REST load, the RouterOS
   * HTTP daemon serializes specific subsystems (/system=93.6%, /certificate=6.4%), causing
   * those paths to queue past the 5s COMPLETION_TIMEOUT_MS. Native has 7 random-jitter
   * timeouts per run under the same batch=50 concurrency.
   *
   * Fix: enrichWithCompletions now does a sequential retry pass (COMPLETION_RETRY_TIMEOUT_MS=30s)
   * for all batch failures before reporting them. Test 7 probe confirmed all REST-only failures
   * respond in 1–2ms when called sequentially — so the retry pass should yield 0 argsFailed.
   *
   * This test MUST pass with argsFailed=0 on both transports. Any failure is a CI blocker.
   */
  test("enrichment produces 0 missed paths after retry (REST and native)", async () => {
    if (!hasRouter) return;
    if (!hasNative) {
      console.log("  Native API not available — skipping");
      return;
    }

    const inspectPath = findLatestInspectJson();
    if (!inspectPath) {
      console.log("  No inspect.json found — skipping");
      return;
    }
    console.log(`  Loading: ${inspectPath}`);
    const rawInspect = JSON.parse(await Bun.file(inspectPath).text()) as InspectNode;
    const totalArgs = (function count(t: InspectNode): number {
      let n = 0;
      for (const [k, v] of Object.entries(t)) {
        if (k.startsWith("_") || typeof v !== "object" || v === null) continue;
        if ((v as InspectNode)._type === "arg") n++;
        n += count(v as InspectNode);
      }
      return n;
    })(rawInspect);
    console.log(`  Total args in tree: ${totalArgs}`);

    // ----- Step 1: REST enrichment with failure capture -----
    const restFails: Array<{ path: string[]; error: string }> = [];
    const restTree = JSON.parse(JSON.stringify(rawInspect)) as InspectNode;
    console.log("\n  Running REST enrichment (capturing failures)...");
    const restStart = performance.now();
    const restStats = await enrichWithCompletions(
      restTree,
      restClient,
      [],
      { argsTotal: 0, argsWithCompletion: 0, argsFailed: 0, argsTimedOut: 0, argsBlankOnRetry: 0 },
      (p, err) => restFails.push({ path: p, error: err.message }),
    );
    const restMs = performance.now() - restStart;
    console.log(
      `  REST done: ${restMs.toFixed(0)}ms, ${restStats.argsFailed} failed, ${restStats.argsWithCompletion} completions`,
    );

    // ----- Step 2: Native enrichment with failure capture -----
    const nativeFails: Array<{ path: string[]; error: string }> = [];
    const nativeTree = JSON.parse(JSON.stringify(rawInspect)) as InspectNode;
    console.log("\n  Running native enrichment (capturing failures)...");
    const nativeStart = performance.now();
    const nativeStats = await enrichWithCompletions(
      nativeTree,
      nativeClient,
      [],
      { argsTotal: 0, argsWithCompletion: 0, argsFailed: 0, argsTimedOut: 0, argsBlankOnRetry: 0 },
      (p, err) => nativeFails.push({ path: p, error: err.message }),
    );
    const nativeMs = performance.now() - nativeStart;
    console.log(
      `  Native done: ${nativeMs.toFixed(0)}ms, ${nativeStats.argsFailed} failed, ${nativeStats.argsWithCompletion} completions`,
    );

    // ----- Step 3: Cross-reference -----
    const restFailMap = new Map(restFails.map((f) => [f.path.join("/"), f]));
    const nativeFailMap = new Map(nativeFails.map((f) => [f.path.join("/"), f]));

    const restOnlyPaths = [...restFailMap.keys()].filter((k) => !nativeFailMap.has(k));
    const nativeOnlyPaths = [...nativeFailMap.keys()].filter((k) => !restFailMap.has(k));
    const bothFailPaths = [...restFailMap.keys()].filter((k) => nativeFailMap.has(k));

    // Error type breakdown
    function categorizeError(msg: string): string {
      if (/abort|Abort|timed? out|operation was aborted/i.test(msg)) return "timeout";
      if (/connection.*closed|closed.*connection|EOF|socket/i.test(msg)) return "connection-closed";
      if (/\b4\d\d\b|\b5\d\d\b/.test(msg)) return "http-error";
      return `other: ${msg}`;
    }
    const restErrorCounts = new Map<string, number>();
    for (const f of restFails) {
      const cat = categorizeError(f.error);
      restErrorCounts.set(cat, (restErrorCounts.get(cat) ?? 0) + 1);
    }
    const nativeErrorCounts = new Map<string, number>();
    for (const f of nativeFails) {
      const cat = categorizeError(f.error);
      nativeErrorCounts.set(cat, (nativeErrorCounts.get(cat) ?? 0) + 1);
    }

    console.log("\n  ─── Cross-reference summary ───────────────────────────────");
    console.log(`  REST-only failures   (fail REST, succeed native): ${restOnlyPaths.length}`);
    console.log(`  Native-only failures (fail native, succeed REST): ${nativeOnlyPaths.length}`);
    console.log(`  Both-fail paths      (fail both transports):      ${bothFailPaths.length}`);

    console.log("\n  REST error types:");
    for (const [cat, n] of [...restErrorCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cat}: ${n}`);
    }
    console.log("  Native error types:");
    for (const [cat, n] of [...nativeErrorCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cat}: ${n}`);
    }

    // ----- Print failure lists -----
    console.log(`\n  Native failures (all ${nativeFails.length}):`);
    for (const f of nativeFails) {
      const cat = categorizeError(f.error);
      const crashFlag = pathContainsCrashSegment(f.path) ? " [CRASH_PATH]" : "";
      console.log(`    /${f.path.join("/")}${crashFlag}  →  ${cat}`);
    }

    console.log(`\n  REST-only failures (first 30 of ${restOnlyPaths.length}):`);
    for (const key of restOnlyPaths.slice(0, 30)) {
      const f = restFailMap.get(key);
      if (!f) continue;
      const cat = categorizeError(f.error);
      const crashFlag = pathContainsCrashSegment(f.path) ? " [CRASH_PATH]" : "";
      console.log(`    /${key}${crashFlag}  →  ${cat}`);
    }

    if (bothFailPaths.length > 0) {
      console.log(`\n  Both-fail paths (all ${bothFailPaths.length}):`);
      for (const key of bothFailPaths) {
        const rf = restFailMap.get(key);
        const nf = nativeFailMap.get(key);
        if (!rf || !nf) continue;
        const crashFlag = pathContainsCrashSegment(rf.path) ? " [CRASH_PATH]" : "";
        console.log(`    /${key}${crashFlag}  REST→${categorizeError(rf.error)}  native→${categorizeError(nf.error)}`);
      }
    }

    // ----- Step 4: Timing hypothesis probe -----
    // For REST-only failures: call nativeClient.fetchCompletion WITHOUT 5s timeout (10s cap).
    // If native takes >5s but responds → confirms abort/timeout fires late (H3) or path is
    // slow but within 10s (H1/H2). If native also errors at 10s → something else is going on.
    const PROBE_TIMEOUT_MS = 10_000;
    const PROBE_SAMPLE_SIZE = 20;
    const sample = restOnlyPaths.slice(0, PROBE_SAMPLE_SIZE);

    if (sample.length > 0) {
      console.log(
        `\n  🕐 Latency probe: ${sample.length} REST-only paths on native (no 5s limit, ${PROBE_TIMEOUT_MS / 1000}s cap)`,
      );
      console.log("     (If native takes >5s → the 5s REST timeout explains the REST failure)");

      let slowNativeCount = 0;
      let fastNativeCount = 0;
      let errorNativeCount = 0;

      for (const key of sample) {
        const p = restFailMap.get(key)?.path;
        if (!p) continue;
        const probeStart = performance.now();
        const probeAbort = new AbortController();
        const probeTimer = setTimeout(() => probeAbort.abort(), PROBE_TIMEOUT_MS);
        try {
          await nativeClient.fetchCompletion(p, probeAbort.signal);
          clearTimeout(probeTimer);
          const ms = performance.now() - probeStart;
          if (ms > 5_000) {
            slowNativeCount++;
            console.log(`    ⚠️  SLOW: /${key}  ${ms.toFixed(0)}ms  (REST timeout explains this!)`);
          } else {
            fastNativeCount++;
            console.log(`    ✓ fast: /${key}  ${ms.toFixed(0)}ms  (race condition? RE-TEST)`);
          }
        } catch (err) {
          clearTimeout(probeTimer);
          const ms = performance.now() - probeStart;
          errorNativeCount++;
          console.log(`    ✗ error: /${key}  ${ms.toFixed(0)}ms  ${(err as Error).message}`);
        }
      }

      console.log(`\n  Probe results (${sample.length} paths):`);
      console.log(`    Native SLOW >5s (timeout explains REST fail): ${slowNativeCount}`);
      console.log(`    Native fast <5s (race/concurrency):           ${fastNativeCount}`);
      console.log(`    Native also errors:                           ${errorNativeCount}`);
    }

    // Pattern analysis: which top-level path trees do failures cluster in?
    const restTopLevelCounts = new Map<string, number>();
    for (const key of restOnlyPaths) {
      const top = key.split("/")[0];
      restTopLevelCounts.set(top, (restTopLevelCounts.get(top) ?? 0) + 1);
    }
    if (restTopLevelCounts.size > 0) {
      console.log("\n  REST-only failures by top-level path:");
      for (const [top, n] of [...restTopLevelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        const pct = ((n / restOnlyPaths.length) * 100).toFixed(1);
        console.log(`    /${top}: ${n} (${pct}%)`);
      }
    }

    allResults.push({
      test: "Enrichment failure analysis",
      transport: "both",
      durationMs: restMs + nativeMs,
      callCount: totalArgs * 2,
      callsPerSecond: 0,
      details: {
        restFailed: restStats.argsFailed,
        nativeFailed: nativeStats.argsFailed,
        restOnlyFails: restOnlyPaths.length,
        nativeOnlyFails: nativeOnlyPaths.length,
        bothFail: bothFailPaths.length,
        restErrorTypes: Object.fromEntries(restErrorCounts),
        nativeErrorTypes: Object.fromEntries(nativeErrorCounts),
      },
    });

    // Core requirement: 0 missed paths after retry.
    // If this fails, the schema is incomplete — investigate retryQueue paths above.
    expect(restStats.argsFailed).toBe(0);
    expect(nativeStats.argsFailed).toBe(0);

    // Sanity: onFailure callback count matches stats
    expect(restFails.length).toBe(restStats.argsFailed);
    expect(nativeFails.length).toBe(nativeStats.argsFailed);
  }, 600_000);
});

// ── Test 8: Full-tree transport equivalence ────────────────────────────────

describe("Test 8: Full-tree transport equivalence — CI correctness gate", () => {
  /**
   * THE CI correctness gate for schema generation.
   *
   * Requirements:
   *   1. REST and native produce BYTE-IDENTICAL completion data on every arg in the full tree.
   *   2. Running either transport again produces the same result (determinism).
   *   3. argsFailed = 0 on both transports (enforced by enrichWithCompletions retry pass).
   *
   * Why this matters: the schema feeds MCP tools that answer questions like
   * "is /certificate/enable-ssl-certificate a valid attribute?". One missed path in CI
   * = wrong answer in production. There is no future version check — same-version runs MUST
   * be identical.
   *
   * Approach: 3 independent enrichments of the same base tree (REST×2, native×1), producing
   * three snapshots of completion data. Then assert:
   *   - rest_run1 === native_run1  (cross-transport equivalence)
   *   - rest_run1 === rest_run2    (REST determinism)
   * Any difference prints the exact differing arg path + completion values.
   *
   * Expected runtime: ~3 × 60s = ~3 minutes on 7.20.8 x86 KVM p1.
   */

  let inspectFile: string;

  beforeAll(async () => {
    const f = findLatestInspectJson();
    if (!f) return;
    inspectFile = f;
  });

  /** Extract completion snapshot: Map<"path/to/arg", sorted JSON of completion object> */
  function snapshotCompletions(tree: InspectNode, pfx: string[] = []): Map<string, string> {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(tree)) {
      if (k.startsWith("_") || typeof v !== "object" || v === null) continue;
      const node = v as InspectNode;
      const p = [...pfx, k];
      if (node._type === "arg" && node._completion) {
        // Sort keys so JSON comparison is order-independent
        const sorted = Object.fromEntries(
          Object.entries(node._completion as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        );
        m.set(p.join("/"), JSON.stringify(sorted));
      }
      m.size; // side-effect to avoid unused-expression lint
      for (const [k2, v2] of snapshotCompletions(node, p)) m.set(k2, v2);
    }
    return m;
  }

  /** Compare two snapshots. Returns array of human-readable difference lines. */
  function diffSnapshots(
    labelA: string,
    snapA: Map<string, string>,
    labelB: string,
    snapB: Map<string, string>,
  ): string[] {
    const diffs: string[] = [];
    const allPaths = new Set([...snapA.keys(), ...snapB.keys()]);
    for (const p of [...allPaths].sort()) {
      const a = snapA.get(p);
      const b = snapB.get(p);
      if (a === b) continue;
      if (a === undefined) {
        diffs.push(`  MISSING in ${labelA}: /${p}  (${labelB} has ${Object.keys(JSON.parse(b as string)).length} completions)`);
      } else if (b === undefined) {
        diffs.push(`  MISSING in ${labelB}: /${p}  (${labelA} has ${Object.keys(JSON.parse(a)).length} completions)`);
      } else {
        const kA = Object.keys(JSON.parse(a));
        const kB = Object.keys(JSON.parse(b));
        const onlyA = kA.filter((k) => !kB.includes(k));
        const onlyB = kB.filter((k) => !kA.includes(k));
        diffs.push(`  DIFF at /${p}:`);
        if (onlyA.length > 0) diffs.push(`    only in ${labelA}: ${onlyA.join(", ")}`);
        if (onlyB.length > 0) diffs.push(`    only in ${labelB}: ${onlyB.join(", ")}`);
      }
    }
    return diffs;
  }

  test("REST enrichment is deterministic (two independent runs must be identical)", async () => {
    if (!hasRouter) return;
    if (!inspectFile) {
      console.log("  No inspect.json found — skipping");
      return;
    }

    console.log(`  Loading: ${inspectFile}`);

    // Run 1
    const tree1 = JSON.parse(await Bun.file(inspectFile).text()) as InspectNode;
    console.log("  REST run 1...");
    const s1 = performance.now();
    const stats1 = await enrichWithCompletions(tree1, restClient);
    console.log(`  REST run 1: ${(performance.now() - s1).toFixed(0)}ms, argsFailed=${stats1.argsFailed}`);
    expect(stats1.argsFailed).toBe(0);

    // Run 2
    const tree2 = JSON.parse(await Bun.file(inspectFile).text()) as InspectNode;
    console.log("  REST run 2...");
    const s2 = performance.now();
    const stats2 = await enrichWithCompletions(tree2, restClient);
    console.log(`  REST run 2: ${(performance.now() - s2).toFixed(0)}ms, argsFailed=${stats2.argsFailed}`);
    expect(stats2.argsFailed).toBe(0);

    const snap1 = snapshotCompletions(tree1);
    const snap2 = snapshotCompletions(tree2);

    const diffs = diffSnapshots("REST-run1", snap1, "REST-run2", snap2);
    if (diffs.length > 0) {
      console.log(`\n  ⚠️  REST non-determinism detected (${diffs.length} differences):`);
      for (const d of diffs.slice(0, 30)) console.log(d);
      if (diffs.length > 30) console.log(`  ... and ${diffs.length - 30} more`);
    } else {
      console.log(`  ✓ REST is deterministic — both runs produced ${snap1.size} identical completion entries`);
    }

    expect(diffs.length).toBe(0);
  }, 900_000); // ~2 × 90s with margin

  test("REST and native produce identical completion data on full tree", async () => {
    if (!hasRouter) return;
    if (!hasNative) {
      console.log("  Native API not available — skipping");
      return;
    }
    if (!inspectFile) {
      console.log("  No inspect.json found — skipping");
      return;
    }

    // REST enrichment
    const restTree = JSON.parse(await Bun.file(inspectFile).text()) as InspectNode;
    console.log("  REST enrichment...");
    const restStart = performance.now();
    const restStats = await enrichWithCompletions(restTree, restClient);
    const restMs = performance.now() - restStart;
    console.log(`  REST: ${restMs.toFixed(0)}ms, ${restStats.argsWithCompletion} args enriched, argsFailed=${restStats.argsFailed}`);
    expect(restStats.argsFailed).toBe(0);

    // Native enrichment (same base tree)
    const nativeTree = JSON.parse(await Bun.file(inspectFile).text()) as InspectNode;
    console.log("  Native enrichment...");
    const nativeStart = performance.now();
    const nativeStats = await enrichWithCompletions(nativeTree, nativeClient);
    const nativeMs = performance.now() - nativeStart;
    console.log(`  Native: ${nativeMs.toFixed(0)}ms, ${nativeStats.argsWithCompletion} args enriched, argsFailed=${nativeStats.argsFailed}`);
    expect(nativeStats.argsFailed).toBe(0);

    // Snapshot and diff
    const restSnap = snapshotCompletions(restTree);
    const nativeSnap = snapshotCompletions(nativeTree);

    console.log(`\n  REST snapshot:   ${restSnap.size} args with completions`);
    console.log(`  Native snapshot: ${nativeSnap.size} args with completions`);

    const diffs = diffSnapshots("REST", restSnap, "Native", nativeSnap);

    if (diffs.length > 0) {
      console.log(`\n  ⚠️  TRANSPORT MISMATCH — ${diffs.length} differences:`);
      for (const d of diffs) console.log(d);
    } else {
      console.log(`  ✓ REST === Native — ${restSnap.size} completion entries, 0 differences`);
    }

    allResults.push({
      test: "Full-tree transport equivalence",
      transport: "both",
      durationMs: restMs + nativeMs,
      callCount: restStats.argsTotal + nativeStats.argsTotal,
      callsPerSecond: 0,
      details: {
        restEnriched: restStats.argsWithCompletion,
        nativeEnriched: nativeStats.argsWithCompletion,
        restArgsFailed: restStats.argsFailed,
        nativeArgsFailed: nativeStats.argsFailed,
        differences: diffs.length,
        argsWithCompletions: restSnap.size,
      },
    });

    // ZERO differences is the hard requirement — any diff is a CI failure
    expect(diffs.length).toBe(0);
  }, 600_000);
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Collect all arg node paths from an inspect tree */
function collectArgPaths(tree: InspectNode, prefix: string[] = []): string[][] {
  const paths: string[][] = [];
  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("_") || typeof value !== "object" || value === null) continue;
    const node = value as InspectNode;
    const currentPath = [...prefix, key];
    if (node._type === "arg") paths.push(currentPath);
    paths.push(...collectArgPaths(node, currentPath));
  }
  return paths;
}

/** Collect all keys (recursive, dot-joined paths) from an inspect tree */
function collectAllKeys(tree: InspectNode, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("_")) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    keys.push(fullKey);
    if (typeof value === "object" && value !== null) {
      keys.push(...collectAllKeys(value as InspectNode, fullKey));
    }
  }
  return keys;
}

/** Collect _completion keys for all arg nodes, keyed by dot-joined path */
function collectCompletionKeys(tree: InspectNode, prefix = ""): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("_") || typeof value !== "object" || value === null) continue;
    const node = value as InspectNode;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (node._type === "arg" && node._completion) {
      result[fullKey] = Object.keys(node._completion);
    }
    Object.assign(result, collectCompletionKeys(node, fullKey));
  }
  return result;
}

/** Count all non-meta nodes in tree */
function countNodes(tree: InspectNode): number {
  let count = 0;
  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("_")) continue;
    count++;
    if (typeof value === "object" && value !== null) {
      count += countNodes(value as InspectNode);
    }
  }
  return count;
}

/** Compute latency stats (mean, p50, p95, p99) from an array of ms values */
function latencyStats(latencies: number[]): { meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number } {
  if (latencies.length === 0) return { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const percentile = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
  return {
    meanMs: mean,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

/** Find the latest (highest version) inspect.json in docs/ */
function findLatestInspectJson(): string | null {
  const { readdirSync } = require("fs");
  const docsDir = `${import.meta.dir}/docs`;
  try {
    const dirs = readdirSync(docsDir) as string[];
    // Filter version directories, sort by version descending
    const versionDirs = dirs
      .filter((d: string) => /^\d+\.\d+/.test(d))
      .sort((a: string, b: string) => {
        const pa = a.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
        const pb = b.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
        if (!pa || !pb) return 0;
        const va = [parseInt(pa[1], 10), parseInt(pa[2], 10), parseInt(pa[3] || "0", 10)];
        const vb = [parseInt(pb[1], 10), parseInt(pb[2], 10), parseInt(pb[3] || "0", 10)];
        for (let i = 0; i < 3; i++) {
          if (va[i] !== vb[i]) return vb[i] - va[i];
        }
        return 0;
      });

    // Find one with inspect.json (prefer stable — no beta/rc)
    for (const dir of versionDirs) {
      if (/beta|rc/.test(dir)) continue;
      const path = `${docsDir}/${dir}/inspect.json`;
      try {
        require("fs").accessSync(path);
        return path;
      } catch { /* not found */ }
    }
    // Fall back to any version
    for (const dir of versionDirs) {
      const path = `${docsDir}/${dir}/inspect.json`;
      try {
        require("fs").accessSync(path);
        return path;
      } catch { /* not found */ }
    }
  } catch { /* docs dir not found */ }
  return null;
}
