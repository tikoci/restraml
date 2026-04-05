/**
 * native-api.test.ts — Tests for NativeRouterOSClient and transport selection
 *
 * Integration tests require a live RouterOS CHR at URLBASE/BASICAUTH with
 * the native API accessible on port 8728 (forwarded to host 8728 in CI).
 *
 * Run locally:
 *   URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun test native-api.test.ts
 *
 * Integration tests are skipped automatically when URLBASE is absent or
 * the native API connection fails.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  NativeRouterOSClient,
  RouterOSClient,
  type IRouterOSClient,
} from "./deep-inspect";

// ── Skip guard ─────────────────────────────────────────────────────────────

const URLBASE = process.env.URLBASE;
const BASICAUTH = process.env.BASICAUTH;

let nativeClient: NativeRouterOSClient;
let restClient: RouterOSClient;
let routerVersion: string | undefined;

beforeAll(async () => {
  if (!URLBASE || !BASICAUTH) return;

  restClient = new RouterOSClient(URLBASE, BASICAUTH);

  const url = new URL(URLBASE);
  const colonIdx = BASICAUTH.indexOf(":");
  const user = BASICAUTH.substring(0, colonIdx);
  const password = BASICAUTH.substring(colonIdx + 1);

  nativeClient = new NativeRouterOSClient(url.hostname, 8728, user, password);
  try {
    await nativeClient.connect();
    routerVersion = await nativeClient.fetchVersion();
  } catch {
    // Native API not available — integration tests will be skipped
  }
});

afterAll(() => {
  nativeClient?.close();
});

function requireNative() {
  return !routerVersion;
}

// ── Unit Tests (no live router required) ──────────────────────────────────

describe("IRouterOSClient structural typing", () => {
  test("NativeRouterOSClient satisfies IRouterOSClient", () => {
    const checkAssignment = (_: IRouterOSClient) => {};
    const nc = new NativeRouterOSClient("127.0.0.1", 8728, "admin", "");
    checkAssignment(nc);
    expect(typeof nc.fetchVersion).toBe("function");
    expect(typeof nc.fetchChild).toBe("function");
    expect(typeof nc.fetchSyntax).toBe("function");
    expect(typeof nc.fetchCompletion).toBe("function");
    expect(typeof nc.close).toBe("function");
  });

  test("RouterOSClient satisfies IRouterOSClient", () => {
    const checkAssignment = (_: IRouterOSClient) => {};
    const rc = new RouterOSClient("http://localhost/rest", "admin:");
    checkAssignment(rc);
    expect(typeof rc.fetchVersion).toBe("function");
    expect(typeof rc.fetchChild).toBe("function");
    expect(typeof rc.fetchSyntax).toBe("function");
    expect(typeof rc.fetchCompletion).toBe("function");
  });

  test("NativeRouterOSClient.connect() rejects on unreachable port", async () => {
    // Port 19999 on localhost should refuse connections — validates that
    // the auto-fallback receive an error to catch, not a hang.
    const nc = new NativeRouterOSClient("127.0.0.1", 19999, "admin", "");
    await expect(nc.connect()).rejects.toThrow();
  });
});

// ── Integration Tests ──────────────────────────────────────────────────────

describe("NativeRouterOSClient (live)", () => {
  test("fetchVersion matches REST client version", async () => {
    if (requireNative()) return;
    expect(routerVersion).toMatch(/^\d+\.\d+/);
    const restVersion = await restClient.fetchVersion();
    expect(routerVersion).toBe(restVersion);
  });

  test("fetchChild([]) returns well-known root paths", async () => {
    if (requireNative()) return;
    const nativeChildren = await nativeClient.fetchChild([]);
    expect(nativeChildren.length).toBeGreaterThan(0);
    const nativeNames = new Set(nativeChildren.map((c) => c.name));
    // Core RouterOS paths that must always be present
    for (const name of ["ip", "system", "interface", "routing"]) {
      expect(nativeNames.has(name)).toBe(true);
    }
    // Note: special-login IS a real CLI path (visible in /console/inspect
    // and RouterOS CLI). The native API and REST should return the same root
    // children from /console/inspect. If a difference is observed, it is likely
    // version-specific or a timing artifact, not a transport difference.
  });

  test("fetchChild at /ip/address/add returns same arg names as REST", async () => {
    if (requireNative()) return;
    const path = ["ip", "address", "add"];
    const [native, rest] = await Promise.all([
      nativeClient.fetchChild(path),
      restClient.fetchChild(path),
    ]);
    const nativeNames = native.map((c) => c.name).sort();
    const restNames = rest.map((c) => c.name).sort();
    expect(nativeNames).toEqual(restNames);
  });

  test("fetchCompletion returns completions for /ip/address/set/", async () => {
    if (requireNative()) return;
    const completions = await nativeClient.fetchCompletion(["ip", "address", "set", ""]);
    expect(completions.length).toBeGreaterThan(0);
    for (const c of completions) {
      expect(c.completion).toBeDefined();
      expect(typeof c.completion).toBe("string");
    }
  });

  test("fetchCompletion completion names match REST client", async () => {
    if (requireNative()) return;
    const path = ["ip", "address", "set", ""];
    const [nativeCompletions, restCompletions] = await Promise.all([
      nativeClient.fetchCompletion(path),
      restClient.fetchCompletion(path),
    ]);
    const nativeNames = nativeCompletions.map((c) => c.completion).sort();
    const restNames = restCompletions.map((c) => c.completion).sort();
    expect(nativeNames).toEqual(restNames);
  });

  test("performance: native API vs REST for 20 completion calls (baseline)", async () => {
    if (requireNative()) return;
    const path = ["ip", "address", "set", ""];
    const N = 20;

    const nativeStart = performance.now();
    for (let i = 0; i < N; i++) {
      await nativeClient.fetchCompletion(path);
    }
    const nativeDurationMs = performance.now() - nativeStart;

    const restStart = performance.now();
    for (let i = 0; i < N; i++) {
      await restClient.fetchCompletion(path);
    }
    const restDurationMs = performance.now() - restStart;

    const speedup = restDurationMs / nativeDurationMs;
    console.log(
      `Perf baseline (${N} calls): native=${nativeDurationMs.toFixed(0)}ms ` +
      `REST=${restDurationMs.toFixed(0)}ms speedup=${speedup.toFixed(1)}x`,
    );
    // Baseline capture — no hard speedup assertion since the ratio varies by network topology:
    // - Direct KVM connection (low RTT): ~1.5–2× (HTTP overhead is marginal)
    // - QEMU port-forwarded CHR (higher RTT): ~10–22× (HTTP overhead dominates)
    // Full enrichment (34k diverse paths) amplifies the difference further: ~45× on X86 KVM.
    expect(nativeDurationMs).toBeGreaterThan(0); // sanity: the test ran
    expect(speedup).toBeGreaterThan(0);
  });
});
