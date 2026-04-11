#!/usr/bin/env bun
/**
 * diff-deep-inspect.ts — Phase 3.3 overlap/delta reporter
 *
 * Compares two deep-inspect.<arch>.json files (typically x86 vs arm64) and
 * reports:
 *   1. Structural delta — paths present on one arch but not the other. Usually
 *      driven by extra packages (wifi-qcom, zerotier, switch-marvell, etc).
 *   2. Completion enum drift — args present on both arches but with different
 *      `_completion` keysets. This is the interesting bucket: it surfaces
 *      real schema gaps that neither arch's view shows alone.
 *   3. _meta side-by-side — versions, transports, completion stats, crash
 *      paths. Makes differences in the run itself obvious.
 *
 * Usage:
 *   bun scripts/diff-deep-inspect.ts <a.json> <b.json>
 *   bun scripts/diff-deep-inspect.ts /tmp/multi-arch/deep-inspect.x86.json \
 *                                    /tmp/multi-arch/deep-inspect.arm64.json
 *   bun scripts/diff-deep-inspect.ts a.json b.json --json
 *   bun scripts/diff-deep-inspect.ts a.json b.json --all   # don't cap lists
 *
 * Exit codes:
 *   0  diff produced (even if non-empty — a difference is not a failure)
 *   1  invocation / file read error
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────

type NodeType = "dir" | "cmd" | "arg";

interface CompletionEntry {
  style?: string;
  preference?: number;
  desc?: string;
}

interface Node {
  _type?: NodeType;
  _completion?: Record<string, CompletionEntry>;
  [key: string]: unknown;
}

interface DeepInspect {
  _meta: {
    version: string;
    generatedAt?: string;
    architecture?: string;
    apiTransport?: string;
    enrichmentDurationMs?: number;
    crashPathsTested?: number;
    crashPathsSafe?: number;
    crashPathsCrashed?: string[];
    completionStats: {
      argsTotal: number;
      argsWithCompletion: number;
      argsFailed: number;
      argsTimedOut: number;
      argsBlankOnRetry: number;
    };
  };
  [key: string]: unknown;
}

interface CompletionDrift {
  path: string;
  onlyInA: string[];
  onlyInB: string[];
  sharedCount: number;
}

interface TypeMismatch {
  path: string;
  aType: NodeType | undefined;
  bType: NodeType | undefined;
}

interface DiffReport {
  a: { label: string; path: string; meta: DeepInspect["_meta"] };
  b: { label: string; path: string; meta: DeepInspect["_meta"] };
  counts: {
    pathsA: number;
    pathsB: number;
    pathsBoth: number;
    pathsOnlyA: number;
    pathsOnlyB: number;
    argsA: number;
    argsB: number;
    argsWithCompletionA: number;
    argsWithCompletionB: number;
    completionDrift: number;
    typeMismatches: number;
  };
  onlyInA: string[];
  onlyInB: string[];
  completionDrift: CompletionDrift[];
  typeMismatches: TypeMismatch[];
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface Opts {
  fileA: string;
  fileB: string;
  json: boolean;
  all: boolean;
  cap: number;
}

function parseCli(): Opts {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      cap: { type: "string", default: "50" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help || positionals.length < 2) {
    printUsage();
    process.exit(values.help ? 0 : 1);
  }

  const fileA = positionals[0];
  const fileB = positionals[1];
  if (!fileA || !fileB) {
    printUsage();
    process.exit(1);
  }

  const cap = Number(values.cap);
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error(`--cap must be a non-negative integer; got "${values.cap}"`);
  }

  return {
    fileA,
    fileB,
    json: values.json ?? false,
    all: values.all ?? false,
    cap,
  };
}

function printUsage() {
  console.log(`
diff-deep-inspect.ts — compare two deep-inspect.<arch>.json files

Usage:
  bun scripts/diff-deep-inspect.ts <a.json> <b.json> [options]

Options:
  --json       Emit machine-readable JSON instead of text report
  --all        Don't cap path/drift lists (default caps at 50 per section)
  --cap <n>    Cap lists at n entries (default: 50)
  --help       Show this help

Example:
  bun scripts/diff-deep-inspect.ts \\
    /tmp/multi-arch/deep-inspect.x86.json \\
    /tmp/multi-arch/deep-inspect.arm64.json
`.trim());
}

// ── Walker ─────────────────────────────────────────────────────────────────

/**
 * Walk the deep-inspect tree and produce a flat map: "/a/b/c" → Node.
 * Skips `_meta` at the top level and any `_*` metadata keys inside nodes.
 */
function flatten(root: DeepInspect): Map<string, Node> {
  const out = new Map<string, Node>();
  function recur(node: unknown, path: string) {
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (k.startsWith("_")) continue;
      const child = (node as Record<string, unknown>)[k] as Node;
      const p = `${path}/${k}`;
      out.set(p, child);
      recur(child, p);
    }
  }
  // Skip _meta — walk only the schema tree.
  for (const k of Object.keys(root)) {
    if (k === "_meta") continue;
    const child = (root as unknown as Record<string, Node>)[k] as Node;
    const p = `/${k}`;
    out.set(p, child);
    recur(child, p);
  }
  return out;
}

function countArgs(map: Map<string, Node>): { total: number; withCompletion: number } {
  let total = 0;
  let withCompletion = 0;
  for (const n of map.values()) {
    if (n._type === "arg") {
      total++;
      if (n._completion && Object.keys(n._completion).length > 0) withCompletion++;
    }
  }
  return { total, withCompletion };
}

// ── Diff ───────────────────────────────────────────────────────────────────

function diff(
  a: DeepInspect,
  b: DeepInspect,
  aLabel: string,
  bLabel: string,
  aPath: string,
  bPath: string,
): DiffReport {
  const mapA = flatten(a);
  const mapB = flatten(b);

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const typeMismatches: TypeMismatch[] = [];
  const completionDrift: CompletionDrift[] = [];

  for (const [p, na] of mapA) {
    const nb = mapB.get(p);
    if (!nb) {
      onlyInA.push(p);
      continue;
    }
    if (na._type !== nb._type) {
      typeMismatches.push({ path: p, aType: na._type, bType: nb._type });
    }
    if (na._type === "arg" && nb._type === "arg") {
      const ca = na._completion ?? {};
      const cb = nb._completion ?? {};
      const keysA = new Set(Object.keys(ca));
      const keysB = new Set(Object.keys(cb));
      if (keysA.size === 0 && keysB.size === 0) continue;
      const oa = [...keysA].filter((k) => !keysB.has(k));
      const ob = [...keysB].filter((k) => !keysA.has(k));
      if (oa.length === 0 && ob.length === 0) continue;
      const shared = [...keysA].filter((k) => keysB.has(k)).length;
      completionDrift.push({ path: p, onlyInA: oa.sort(), onlyInB: ob.sort(), sharedCount: shared });
    }
  }
  for (const p of mapB.keys()) {
    if (!mapA.has(p)) onlyInB.push(p);
  }

  onlyInA.sort();
  onlyInB.sort();
  // Sort drift by total delta desc — biggest gaps float to the top.
  completionDrift.sort(
    (x, y) => y.onlyInA.length + y.onlyInB.length - (x.onlyInA.length + x.onlyInB.length),
  );

  const argsA = countArgs(mapA);
  const argsB = countArgs(mapB);

  const pathsBoth = [...mapA.keys()].filter((k) => mapB.has(k)).length;

  return {
    a: { label: aLabel, path: aPath, meta: a._meta },
    b: { label: bLabel, path: bPath, meta: b._meta },
    counts: {
      pathsA: mapA.size,
      pathsB: mapB.size,
      pathsBoth,
      pathsOnlyA: onlyInA.length,
      pathsOnlyB: onlyInB.length,
      argsA: argsA.total,
      argsB: argsB.total,
      argsWithCompletionA: argsA.withCompletion,
      argsWithCompletionB: argsB.withCompletion,
      completionDrift: completionDrift.length,
      typeMismatches: typeMismatches.length,
    },
    onlyInA,
    onlyInB,
    completionDrift,
    typeMismatches,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────

function cap<T>(arr: T[], n: number, all: boolean): { shown: T[]; truncated: number } {
  if (all || arr.length <= n) return { shown: arr, truncated: 0 };
  return { shown: arr.slice(0, n), truncated: arr.length - n };
}

function textReport(r: DiffReport, opts: Opts): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const A = r.a.label;
  const B = r.b.label;

  lines.push("━━━ deep-inspect diff ━━━");
  lines.push(`  ${pad(A, 8)} ${r.a.path}`);
  lines.push(`  ${pad(B, 8)} ${r.b.path}`);
  lines.push("");

  lines.push("  _meta                            " + pad(A, 16) + B);
  const m = (label: string, av: unknown, bv: unknown) =>
    lines.push(`  ${pad(label, 32)} ${pad(String(av ?? "—"), 16)}${String(bv ?? "—")}`);
  m("version", r.a.meta.version, r.b.meta.version);
  m("architecture", r.a.meta.architecture, r.b.meta.architecture);
  m("apiTransport", r.a.meta.apiTransport, r.b.meta.apiTransport);
  m(
    "enrichmentDuration",
    r.a.meta.enrichmentDurationMs ? `${(r.a.meta.enrichmentDurationMs / 1000).toFixed(1)}s` : "—",
    r.b.meta.enrichmentDurationMs ? `${(r.b.meta.enrichmentDurationMs / 1000).toFixed(1)}s` : "—",
  );
  m("crashPathsCrashed", r.a.meta.crashPathsCrashed?.length ?? 0, r.b.meta.crashPathsCrashed?.length ?? 0);
  m("argsTotal", r.a.meta.completionStats.argsTotal, r.b.meta.completionStats.argsTotal);
  m("argsWithCompletion", r.a.meta.completionStats.argsWithCompletion, r.b.meta.completionStats.argsWithCompletion);
  m("argsTimedOut", r.a.meta.completionStats.argsTimedOut, r.b.meta.completionStats.argsTimedOut);
  m("argsBlankOnRetry", r.a.meta.completionStats.argsBlankOnRetry, r.b.meta.completionStats.argsBlankOnRetry);
  m("argsFailed", r.a.meta.completionStats.argsFailed, r.b.meta.completionStats.argsFailed);
  lines.push("");

  lines.push("━━━ Summary ━━━");
  const c = r.counts;
  lines.push(`  paths: ${A} ${c.pathsA}, ${B} ${c.pathsB}, shared ${c.pathsBoth}`);
  lines.push(`    only in ${A}: ${c.pathsOnlyA}`);
  lines.push(`    only in ${B}: ${c.pathsOnlyB}`);
  lines.push(`  args : ${A} ${c.argsA} (${c.argsWithCompletionA} w/ completions), ${B} ${c.argsB} (${c.argsWithCompletionB} w/ completions)`);
  lines.push(`  completion drift: ${c.completionDrift} arg(s) with different _completion keysets`);
  lines.push(`  type mismatches : ${c.typeMismatches}`);
  lines.push("");

  if (c.typeMismatches > 0) {
    lines.push("━━━ Type Mismatches ━━━");
    lines.push("  (same path, different _type — structural surprise, investigate)");
    for (const tm of r.typeMismatches) {
      lines.push(`    ${tm.path}  ${A}=${tm.aType ?? "?"}  ${B}=${tm.bType ?? "?"}`);
    }
    lines.push("");
  }

  // Paths only in one arch — grouped by top-level segment for readability.
  const section = (title: string, paths: string[]) => {
    if (paths.length === 0) return;
    lines.push(`━━━ ${title} (${paths.length}) ━━━`);
    const byTop = new Map<string, string[]>();
    for (const p of paths) {
      const top = p.split("/")[1] ?? "";
      let group = byTop.get(top);
      if (!group) {
        group = [];
        byTop.set(top, group);
      }
      group.push(p);
    }
    const groups = [...byTop.entries()].sort((a, b) => b[1].length - a[1].length);
    const { shown, truncated } = cap(groups, 20, opts.all);
    for (const [top, ps] of shown) {
      lines.push(`  /${top}  (${ps.length})`);
      const { shown: pshown, truncated: ptrunc } = cap(ps, opts.cap, opts.all);
      for (const p of pshown) lines.push(`    ${p}`);
      if (ptrunc > 0) lines.push(`    … +${ptrunc} more (use --all to expand)`);
    }
    if (truncated > 0) lines.push(`  … +${truncated} more top-level group(s) (use --all)`);
    lines.push("");
  };
  section(`Paths only in ${A}`, r.onlyInA);
  section(`Paths only in ${B}`, r.onlyInB);

  if (r.completionDrift.length > 0) {
    lines.push(`━━━ Completion Enum Drift (${r.completionDrift.length}) ━━━`);
    lines.push("  (same arg on both arches, different _completion keysets)");
    lines.push("  (sorted by total delta size — biggest gaps first)");
    const { shown, truncated } = cap(r.completionDrift, opts.cap, opts.all);
    for (const d of shown) {
      const delta = d.onlyInA.length + d.onlyInB.length;
      lines.push(`  ${d.path}  (Δ${delta}, shared=${d.sharedCount})`);
      if (d.onlyInA.length > 0) {
        const keys = d.onlyInA.slice(0, 10).join(", ");
        const more = d.onlyInA.length > 10 ? ` … +${d.onlyInA.length - 10}` : "";
        lines.push(`      ${A} only: ${keys}${more}`);
      }
      if (d.onlyInB.length > 0) {
        const keys = d.onlyInB.slice(0, 10).join(", ");
        const more = d.onlyInB.length > 10 ? ` … +${d.onlyInB.length - 10}` : "";
        lines.push(`      ${B} only: ${keys}${more}`);
      }
    }
    if (truncated > 0) lines.push(`  … +${truncated} more (use --all to expand)`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────

function deriveLabel(meta: DeepInspect["_meta"], path: string): string {
  if (meta.architecture) return meta.architecture;
  // Fall back to filename-derived hint, e.g. deep-inspect.arm64.json → arm64.
  const m = path.match(/deep-inspect\.([^.]+)\.json$/);
  return m?.[1] ?? path;
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

  let a: DeepInspect;
  let b: DeepInspect;
  try {
    a = JSON.parse(readFileSync(opts.fileA, "utf-8")) as DeepInspect;
    b = JSON.parse(readFileSync(opts.fileB, "utf-8")) as DeepInspect;
  } catch (e) {
    console.error(`Failed to read/parse inputs: ${(e as Error).message}`);
    process.exit(1);
  }

  const aLabel = deriveLabel(a._meta, opts.fileA);
  const bLabel = deriveLabel(b._meta, opts.fileB);
  const report = diff(a, b, aLabel, bLabel, opts.fileA, opts.fileB);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(textReport(report, opts));
  }
}

await main();
