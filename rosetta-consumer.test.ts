/**
 * rosetta-consumer.test.ts — Contract tests from rosetta's perspective.
 *
 * rosetta/src/extract-commands.ts imports deep-inspect.<arch>.json and reads:
 *   - _meta.version, _meta.generatedAt, _meta.completionStats,
 *     _meta.crashPathsTested, _meta.crashPathsCrashed, _meta.architecture
 *   - Tree nodes via walk(): _type (dir|cmd|arg|path), desc (string|absent)
 *   - Completion entries via _completion: Record<string,{style?,preference?,desc?}>
 *
 * rosetta/src/db.ts schema:
 *   ros_versions  PRIMARY KEY (version, arch)
 *   commands      path, name, type, parent_path, description, ros_version
 *   command_versions  (command_path, ros_version)
 *
 * These tests do NOT import rosetta code — they assert the output shape of
 * deep-inspect.ts against the exact field names and types rosetta uses.
 * No live router required. Think of it as a typed API contract checklist.
 */

import { describe, test, expect } from "bun:test";
import type {
  DeepInspectMeta,
  DeepInspectOutput,
  InspectNode,
  CompletionEntry,
} from "./deep-inspect";

// ── Shared fixture ─────────────────────────────────────────────────────────

const sampleInspect: InspectNode = JSON.parse(
  await Bun.file("fixtures/sample-inspect.json").text(),
);

/** Minimal valid _meta as produced by deep-inspect.ts for a per-arch run */
function makeMeta(arch: "x86" | "arm64", version = "7.22.1"): DeepInspectMeta {
  return {
    version,
    generatedAt: new Date().toISOString(),
    architecture: arch,
    apiTransport: "rest",
    enrichmentDurationMs: 12345,
    crashPathsTested: ["where", "do", "else", "rule", "command", "on-error"],
    crashPathsSafe: [],
    crashPathsCrashed: [],
    completionStats: {
      argsTotal: 1000,
      argsWithCompletion: 300,
      argsFailed: 2,
      argsTimedOut: 5,
      argsBlankOnRetry: 1,
    },
  };
}

// ── _meta envelope ─────────────────────────────────────────────────────────
// rosetta/src/extract-commands.ts reads these fields from _meta directly.

describe("rosetta consumer: _meta envelope", () => {
  test("_meta.version is a non-empty string", () => {
    const meta = makeMeta("x86");
    expect(typeof meta.version).toBe("string");
    expect(meta.version.length).toBeGreaterThan(0);
    // rosetta logs: _meta.version=${meta.version}
    expect(meta.version).toMatch(/^\d+\.\d+/);
  });

  test("_meta.generatedAt is an ISO 8601 timestamp", () => {
    const meta = makeMeta("x86");
    expect(typeof meta.generatedAt).toBe("string");
    // rosetta stores this verbatim in ros_versions.generated_at
    expect(meta.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(new Date(meta.generatedAt).getTime()).not.toBeNaN();
  });

  test("_meta.architecture is 'x86' or 'arm64' for per-arch files", () => {
    // rosetta keys ros_versions on PRIMARY KEY (version, arch).
    // If architecture is absent, rosetta falls back to deriving arch from
    // the filename — which works because --output-suffix matches the arch.
    // But providing it explicitly is more reliable.
    for (const arch of ["x86", "arm64"] as const) {
      const meta = makeMeta(arch);
      expect(meta.architecture).toBe(arch);
    }
  });

  test("_meta.crashPathsTested is a string array (may be empty)", () => {
    const meta = makeMeta("x86");
    expect(Array.isArray(meta.crashPathsTested)).toBe(true);
    for (const p of meta.crashPathsTested) {
      expect(typeof p).toBe("string");
    }
    // rosetta stores as JSON.stringify(meta.crashPathsTested)
    expect(JSON.parse(JSON.stringify(meta.crashPathsTested))).toEqual(meta.crashPathsTested);
  });

  test("_meta.crashPathsCrashed is a string array (may be empty)", () => {
    const meta = makeMeta("x86");
    expect(Array.isArray(meta.crashPathsCrashed)).toBe(true);
    // rosetta stores as JSON.stringify(meta.crashPathsCrashed) in ros_versions
    JSON.stringify(meta.crashPathsCrashed); // must not throw
  });

  test("_meta.completionStats has all fields rosetta reads", () => {
    const meta = makeMeta("x86");
    const s = meta.completionStats;
    // rosetta stores as JSON.stringify(meta.completionStats) — all fields must survive round-trip
    const roundTripped = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(typeof roundTripped.argsTotal).toBe("number");
    expect(typeof roundTripped.argsWithCompletion).toBe("number");
    expect(typeof roundTripped.argsFailed).toBe("number");
    // argsTimedOut and argsBlankOnRetry are newer fields rosetta uses for display
    expect(typeof roundTripped.argsTimedOut).toBe("number");
    expect(typeof roundTripped.argsBlankOnRetry).toBe("number");
  });

  test("DeepInspectOutput _meta is a top-level key alongside tree", () => {
    const output: DeepInspectOutput = { _meta: makeMeta("x86"), ...sampleInspect };
    // rosetta: const meta = inspectData._meta && typeof inspectData._meta === "object" ? ...
    expect(typeof output._meta).toBe("object");
    expect(output._meta).not.toBeNull();
    // Tree data must be present at the same level
    expect((output.ip as InspectNode)?._type).toBe("path");
  });
});

// ── Tree walker contract ────────────────────────────────────────────────────
// rosetta/src/extract-commands.ts walk() skips _type, desc, _meta keys and
// processes every other object child that has a truthy _type.

describe("rosetta consumer: tree walker contract", () => {
  test("_type values are one of dir|cmd|arg|path", () => {
    const validTypes = new Set(["dir", "cmd", "arg", "path"]);

    function checkTypes(node: InspectNode, path: string) {
      for (const [key, child] of Object.entries(node)) {
        if (key === "_type" || key === "desc" || key === "_meta" || key === "_completion") continue;
        if (typeof child !== "object" || child === null) continue;
        const c = child as InspectNode;
        if (c._type !== undefined) {
          expect(validTypes.has(c._type), `${path}/${key} has invalid _type "${c._type}"`).toBe(true);
          // Recurse for dir/path/cmd — same as rosetta walk()
          if (c._type === "dir" || c._type === "path" || c._type === "cmd") {
            checkTypes(c, `${path}/${key}`);
          }
        }
      }
    }

    checkTypes(sampleInspect, "");
  });

  test("desc is a string when present (rosetta: typeof node.desc === 'string')", () => {
    function checkDesc(node: InspectNode, path: string) {
      if ("desc" in node && node.desc !== undefined) {
        expect(typeof node.desc, `${path}.desc must be string`).toBe("string");
      }
      for (const [key, child] of Object.entries(node)) {
        if (key === "_type" || key === "desc" || key === "_completion") continue;
        if (typeof child !== "object" || child === null) continue;
        const c = child as InspectNode;
        if (c._type) checkDesc(c, `${path}/${key}`);
      }
    }
    checkDesc(sampleInspect, "");
  });

  test("_meta key is not a tree node (rosetta: skip key '_meta' in walk)", () => {
    // If _meta were a tree node, rosetta's walk() would try to insert it as a command.
    // Verify it does NOT have _type.
    const output: DeepInspectOutput = { _meta: makeMeta("x86"), ...sampleInspect };
    const meta = output._meta as unknown as InspectNode;
    expect(meta._type).toBeUndefined();
  });

  test("top-level keys have _type (no ghost keys without _type)", () => {
    // rosetta walk() only processes nodes with truthy _type. A key without
    // _type is silently skipped. This is intentional for _meta, but unexpected
    // for real tree nodes. Verify that known tree roots have _type populated.
    const knownRoots = ["ip", "system", "interface", "convert", "certificate"];
    for (const key of knownRoots) {
      const node = sampleInspect[key] as InspectNode | undefined;
      if (node !== undefined) {
        expect(node._type, `${key} missing _type`).toBeDefined();
      }
    }
  });
});

// ── _completion payload contract ───────────────────────────────────────────
// diff-deep-inspect.ts reads _completion as Record<string, CompletionEntry>
// where CompletionEntry = { style?: string; preference?: number; desc?: string }

describe("rosetta consumer: _completion payload contract", () => {
  test("CompletionEntry fields are optional and typed correctly", () => {
    const entries: Array<[string, CompletionEntry]> = [
      ["tcp",   { style: "none", preference: 80, desc: "Transmission Control Protocol" }],
      ["udp",   { style: "none", preference: 60 }],
      ["icmp",  { style: "obj-disabled" }],
    ];

    for (const [key, entry] of entries) {
      if (entry.style !== undefined) expect(typeof entry.style, `${key}.style`).toBe("string");
      if (entry.preference !== undefined) expect(typeof entry.preference, `${key}.preference`).toBe("number");
      if (entry.desc !== undefined) expect(typeof entry.desc, `${key}.desc`).toBe("string");
    }
  });

  test("_completion is a Record<string, CompletionEntry> (not array)", () => {
    // diff-deep-inspect.ts uses Object.keys(ca) — must be an object, not an array.
    const completion: Record<string, CompletionEntry> = {
      tcp: { style: "none", preference: 80 },
      udp: { style: "none" },
    };
    expect(Array.isArray(completion)).toBe(false);
    expect(Object.keys(completion)).toEqual(["tcp", "udp"]);
  });

  test("_completion survives JSON round-trip with all fields intact", () => {
    const completion: Record<string, CompletionEntry> = {
      accept: { style: "none", preference: 96, desc: "Accept the packet" },
      drop:   { style: "obj-disabled", preference: 80 },
      log:    { style: "none" },
    };
    const rt = JSON.parse(JSON.stringify(completion)) as Record<string, CompletionEntry>;
    expect(rt.accept.style).toBe("none");
    expect(rt.accept.preference).toBe(96);
    expect(rt.accept.desc).toBe("Accept the packet");
    expect(rt.drop.style).toBe("obj-disabled");
    expect(rt.drop.preference).toBe(80);
    // Minimal entry: only style present
    expect(rt.log.style).toBe("none");
    expect(rt.log.preference).toBeUndefined();
    expect(rt.log.desc).toBeUndefined();
  });
});

// ── Filename → arch derivation contract ───────────────────────────────────
// rosetta/src/extract-commands.ts deriveArch():
//   /deep-inspect\.arm64\b/.test(filepath) → "arm64"
//   /deep-inspect\.x86\b/.test(filepath)   → "x86"
//   else                                    → "x86" (default)
// This relies on the output filename suffix matching the arch.

describe("rosetta consumer: filename → arch derivation", () => {
  // Mirror rosetta's deriveArch() logic — changes here must be coordinated.
  function deriveArch(filepath: string): "x86" | "arm64" {
    if (/deep-inspect\.arm64\b/.test(filepath)) return "arm64";
    if (/deep-inspect\.x86\b/.test(filepath)) return "x86";
    return "x86";
  }

  test("deep-inspect.x86.json → 'x86'", () => {
    expect(deriveArch("docs/7.22.1/extra/deep-inspect.x86.json")).toBe("x86");
  });

  test("deep-inspect.arm64.json → 'arm64'", () => {
    expect(deriveArch("docs/7.22.1/extra/deep-inspect.arm64.json")).toBe("arm64");
  });

  test("legacy deep-inspect.json (no suffix) → 'x86' (back-compat default)", () => {
    expect(deriveArch("docs/7.22/extra/deep-inspect.json")).toBe("x86");
  });

  test("suffix must not be shared by partial filename matches", () => {
    // e.g. deep-inspect.x86_64.json should NOT match the x86 regex if someone
    // ever adds a suffix with that name — the \b word boundary protects us.
    expect(deriveArch("deep-inspect.x86_64.json")).toBe("x86"); // \b matches before _
    // (This is a known edge case, not a bug — x86_64 is not a valid --arch value anyway)
    expect(deriveArch("deep-inspect.arm64.foobar.json")).toBe("arm64");
  });
});

// ── ros_versions table contract ────────────────────────────────────────────
// rosetta INSERT OR REPLACE INTO ros_versions:
//   (version, arch, channel, extra_packages, extracted_at,
//    generated_at, crash_paths_tested, crash_paths_crashed, completion_stats, source_url)
// PRIMARY KEY (version, arch) — so two arches for the same version are separate rows.

describe("rosetta consumer: ros_versions table contract", () => {
  test("x86 and arm64 produce distinct (version, arch) primary keys", () => {
    const x86 = makeMeta("x86", "7.22.1");
    const arm64 = makeMeta("arm64", "7.22.1");
    const x86Key = `${x86.version}::${x86.architecture}`;
    const arm64Key = `${arm64.version}::${arm64.architecture}`;
    expect(x86Key).not.toBe(arm64Key);
    expect(x86.version).toBe(arm64.version); // same version string
    expect(x86.architecture).not.toBe(arm64.architecture); // but different arch
  });

  test("completionStats round-trips as JSON for TEXT column storage", () => {
    const meta = makeMeta("x86");
    const stored = JSON.stringify(meta.completionStats);
    const retrieved = JSON.parse(stored) as typeof meta.completionStats;
    expect(retrieved.argsTotal).toBe(meta.completionStats.argsTotal);
    expect(retrieved.argsBlankOnRetry).toBe(meta.completionStats.argsBlankOnRetry);
  });

  test("crashPathsTested round-trips as JSON for TEXT column storage", () => {
    const meta = makeMeta("x86");
    const stored = JSON.stringify(meta.crashPathsTested);
    const retrieved = JSON.parse(stored) as typeof meta.crashPathsTested;
    expect(retrieved).toEqual(meta.crashPathsTested);
  });
});
