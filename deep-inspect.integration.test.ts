/**
 * deep-inspect.integration.test.ts — Integration tests requiring a live RouterOS CHR
 *
 * These tests require a running RouterOS instance accessible at URLBASE with BASICAUTH.
 *
 * Local setup using mikropkl's qemu.sh:
 *   cd ~/Lab/mikropkl/Machines/chr.x86_64.qemu.*.utm
 *   ./qemu.sh --background
 *   # Wait ~30s for CHR to boot
 *   URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun test deep-inspect.integration.test.ts
 *   ./qemu.sh --stop
 *
 * CI setup: the GitHub Actions workflows boot CHR in QEMU on the runner with the
 * same URLBASE/BASICAUTH env vars.
 *
 * Skipped automatically when URLBASE is not set or the router is unreachable.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  RouterOSClient,
  enrichWithCompletions,
  testCrashPaths,
  crawlInspectTree,
  generateOpenAPI,
  CRASH_PATHS,
  type InspectNode,
} from "./deep-inspect";

// ── Skip guard ─────────────────────────────────────────────────────────────

const URLBASE = process.env.URLBASE;
const BASICAUTH = process.env.BASICAUTH;
const hasRouter = !!(URLBASE && BASICAUTH);

let client: RouterOSClient;
let routerVersion: string;

// Quick connectivity check — skip the whole suite if the router is unreachable
beforeAll(async () => {
  if (!hasRouter || !URLBASE || !BASICAUTH) return;
  client = new RouterOSClient(URLBASE, BASICAUTH);
  try {
    routerVersion = await client.fetchVersion();
  } catch {
    // Router unreachable — tests will be skipped via the guard
  }
});

function requireRouter() {
  if (!hasRouter || !routerVersion) {
    return true; // signal to skip
  }
  return false;
}

// ── RouterOS Client Tests ──────────────────────────────────────────────────

describe("RouterOSClient (live)", () => {
  test("fetchVersion returns a version string", () => {
    if (requireRouter()) return;
    expect(routerVersion).toMatch(/^\d+\.\d+/);
  });

  test("fetchChild returns children at root", async () => {
    if (requireRouter()) return;
    const children = await client.fetchChild([]);
    expect(children.length).toBeGreaterThan(0);
    // Root should have well-known entries
    const names = children.map((c) => c.name);
    expect(names).toContain("ip");
    expect(names).toContain("system");
  });

  test("fetchChild returns args for a known cmd", async () => {
    if (requireRouter()) return;
    const children = await client.fetchChild(["ip", "address", "add"]);
    const argNames = children
      .filter((c) => c["node-type"] === "arg")
      .map((c) => c.name);
    expect(argNames).toContain("address");
    expect(argNames).toContain("interface");
  });

  test("fetchSyntax returns description for a known arg", async () => {
    if (requireRouter()) return;
    const syntax = await client.fetchSyntax(["ip", "address", "add", "address"]);
    expect(syntax.length).toBeGreaterThan(0);
    expect(syntax[0].text.length).toBeGreaterThan(0);
  });

  test("fetchCompletion returns values for convert,from", async () => {
    if (requireRouter()) return;
    const completions = await client.fetchCompletion(["convert", "from"]);
    expect(completions.length).toBeGreaterThan(0);
    // convert,from should have base64, hex, etc.
    const names = completions.map((c) => c.completion);
    expect(names).toContain("base64");
  });
});

// ── Completion Enrichment Tests ────────────────────────────────────────────

describe("enrichWithCompletions (live)", () => {
  test("enriches a small subtree with _completion data", async () => {
    if (requireRouter()) return;
    // Use a known small subtree: convert (1 cmd with 3 args)
    const tree: InspectNode = {
      convert: {
        _type: "cmd",
        from: { _type: "arg", desc: "value to convert from" },
        to: { _type: "arg", desc: "value to convert to" },
      },
    };

    const stats = await enrichWithCompletions(tree, client);
    expect(stats.argsTotal).toBe(2);

    // At least one of convert's args should have completions
    const convertNode = tree.convert as InspectNode;
    const fromNode = convertNode.from as InspectNode;
    if (fromNode._completion) {
      expect(Object.keys(fromNode._completion).length).toBeGreaterThan(0);
      // base64 should be one of the completion values
      expect(fromNode._completion).toHaveProperty("base64");
    }
  });
});

// ── CRASH_PATHS Tests ──────────────────────────────────────────────────────

describe("testCrashPaths (live)", () => {
  // Each crash path gets a 5s timeout probe — with 6 paths that's up to 30s
  test("tests all CRASH_PATHS and reports results", async () => {
    if (requireRouter()) return;
    const results = await testCrashPaths(client);
    expect(results).toHaveLength(CRASH_PATHS.length);

    for (const result of results) {
      expect((CRASH_PATHS as readonly string[]).includes(result.path)).toBe(true);
      expect(typeof result.safe).toBe("boolean");
    }

    // Log results for visibility
    const safe = results.filter((r) => r.safe).map((r) => r.path);
    const crashed = results.filter((r) => !r.safe).map((r) => r.path);
    console.log(`CRASH_PATHS safe: [${safe.join(", ")}]`);
    console.log(`CRASH_PATHS crashed: [${crashed.join(", ")}]`);
  }, 60_000);
});

// ── Live Crawl Tests ───────────────────────────────────────────────────────

describe("crawlInspectTree (live)", () => {
  test("crawls a small subtree", async () => {
    if (requireRouter()) return;
    // Crawl just system/identity — very small tree
    const tree = await crawlInspectTree(client, ["system", "identity"]);

    // system/identity should have get, set, print commands
    expect(tree.get).toBeDefined();
    expect((tree.get as InspectNode)._type).toBe("cmd");

    // get should have a 'value-name' arg
    const valueName = (tree.get as InspectNode)["value-name"] as InspectNode;
    expect(valueName).toBeDefined();
    expect(valueName._type).toBe("arg");
  }, 30_000);
});

// ── End-to-End: deep-inspect.json + openapi.json ──────────────────────────

describe("end-to-end (live)", () => {
  test("generates deep-inspect.json and openapi.json from live subtree", async () => {
    if (requireRouter()) return;

    // Crawl system/identity (tiny tree) and enrich
    const tree: InspectNode = {
      system: {
        _type: "dir",
        ...(await crawlInspectTree(client, ["system", "identity"], new Set())),
      },
    };

    // Wrap as identity dir (the crawl returns children of the path)
    const fullTree: InspectNode = {
      system: {
        _type: "dir",
        identity: tree.system,
      },
    };

    await enrichWithCompletions(fullTree, client);

    // Generate OpenAPI
    const openapi = generateOpenAPI(fullTree, routerVersion);
    expect(openapi.openapi).toBe("3.0.3");
    expect(openapi.info.version).toBe(routerVersion);

    const paths = Object.keys(openapi.paths);
    expect(paths.length).toBeGreaterThan(0);

    // Write to temp dir to verify file output works
    const tmpDir = `${import.meta.dir}/tmp-integration-test`;
    await Bun.write(`${tmpDir}/deep-inspect.json`, JSON.stringify(fullTree));
    await Bun.write(`${tmpDir}/openapi.json`, JSON.stringify(openapi, null, 2));

    // Verify files were written
    const diFile = Bun.file(`${tmpDir}/deep-inspect.json`);
    expect(await diFile.exists()).toBe(true);
    const diData = await diFile.json();
    expect(diData.system).toBeDefined();

    const oaFile = Bun.file(`${tmpDir}/openapi.json`);
    expect(await oaFile.exists()).toBe(true);

    // Cleanup
    const { rmSync } = await import("fs");
    rmSync(tmpDir, { recursive: true, force: true });
  }, 30_000);
});
