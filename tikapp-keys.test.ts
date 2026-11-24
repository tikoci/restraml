import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Regression test for the tikapp.html Monaco providers (hover, inlay hints,
// completions, auto-suggest): RouterOS 7.25+ re-emits /app YAML with
// single-quoted keys ('code-server':) and quoted scalars, which the editor's
// key parsing must resolve exactly like bare keys. Unquoted-only matching
// dropped the inline help text for quoted keys AND for every unquoted child
// under a quoted parent (the parent-path walk skipped the quoted line).
//
// The helpers live inline in docs/tikapp.html (single-file page convention),
// so this test extracts them verbatim between marker comments — the shipped
// code itself is what's exercised, not a copy.

const repoRoot = import.meta.dir;
const html = await Bun.file(join(repoRoot, "docs/tikapp.html")).text();

const startMarker = "// --- YAML key parsing (quote-aware) ---";
const endMarker = "// --- end YAML key parsing ---";
const libStart = html.indexOf("function resolveRef(root, node) {");
const helpersStart = html.indexOf(startMarker);
const helpersEnd = html.indexOf(endMarker);

if (libStart < 0 || helpersStart < 0 || helpersEnd < 0 || !(libStart < helpersStart && helpersStart < helpersEnd)) {
  throw new Error("tikapp.html key-parsing block not found: expected resolveRef..helpers markers in order");
}

// resolveRef/schemaAtPath/mergeSchema sit immediately above the helpers and are
// pure, so one slice captures the whole lookup chain with no DOM dependency.
type SchemaNode = Record<string, unknown>;
interface KeyLine {
  prefix: string;
  key: string;
  token: string;
  rest: string;
}
interface KeyLib {
  schemaAtPath(root: SchemaNode, path: string[]): SchemaNode | null;
  mergeSchema(root: SchemaNode, node: SchemaNode | null): SchemaNode | null;
  matchKeyLine(line: string): KeyLine | null;
  matchKeyOnlyLine(trimmed: string): string | null;
  matchArrayKeyLine(trimmed: string): string | null;
  matchAnyKeyLine(trimmed: string): string | null;
  isAfterKeyColon(text: string): boolean;
}
const lib = new Function(
  `${html.slice(libStart, helpersEnd)}; return { schemaAtPath, mergeSchema, matchKeyLine, matchKeyOnlyLine, matchArrayKeyLine, matchAnyKeyLine, isAfterKeyColon };`,
)() as KeyLib;

const schema = (await Bun.file(join(repoRoot, "docs/routeros-app-yaml-schema.latest.json")).json()) as SchemaNode;

function resolved(path: string[]): SchemaNode | null {
  return lib.mergeSchema(schema, lib.schemaAtPath(schema, path));
}

describe("tikapp.html quote-aware key parsing", () => {
  test("matchKeyLine parses bare, quoted, and array-item keys", () => {
    expect(lib.matchKeyLine("    image: lscr.io/linuxserver/code-server:latest")).toMatchObject({
      prefix: "    ",
      key: "image",
    });
    expect(lib.matchKeyLine("  'code-server': ")).toMatchObject({
      prefix: "  ",
      key: "code-server",
      token: "'code-server'",
    });
    expect(lib.matchKeyLine('  "my key": 1')).toMatchObject({ key: "my key" });
    expect(lib.matchKeyLine("  - name: foo")).toMatchObject({ prefix: "  - ", key: "name" });
    expect(lib.matchKeyLine("  - 'name': foo")).toMatchObject({ prefix: "  - ", key: "name" });
  });

  test("matchKeyLine rejects non-key lines", () => {
    expect(lib.matchKeyLine("      - '8443:8443:web'")).toBeNull();
    expect(lib.matchKeyLine("    # a comment")).toBeNull();
    expect(lib.matchKeyLine("")).toBeNull();
  });

  test("matchKeyOnlyLine accepts quoted parent mappings, rejects valued lines", () => {
    expect(lib.matchKeyOnlyLine("services:")).toBe("services");
    expect(lib.matchKeyOnlyLine("'code-server':")).toBe("code-server");
    expect(lib.matchKeyOnlyLine('"a b":')).toBe("a b");
    expect(lib.matchKeyOnlyLine("key: value")).toBeNull();
    expect(lib.matchKeyOnlyLine("- item")).toBeNull();
  });

  test("matchArrayKeyLine accepts quoted '- key:' lines", () => {
    expect(lib.matchArrayKeyLine("- name: foo")).toBe("name");
    expect(lib.matchArrayKeyLine("- 'name': foo")).toBe("name");
    expect(lib.matchArrayKeyLine("name: foo")).toBeNull();
  });

  test("matchAnyKeyLine accepts both plain and array-item keys", () => {
    expect(lib.matchAnyKeyLine("'container_name': 'x'")).toBe("container_name");
    expect(lib.matchAnyKeyLine("- name: foo")).toBe("name");
    expect(lib.matchAnyKeyLine("- '8443:8443:web'")).toBeNull();
  });

  test("isAfterKeyColon detects value position for bare and quoted keys", () => {
    expect(lib.isAfterKeyColon("image: ")).toBe(true);
    expect(lib.isAfterKeyColon("'image': ")).toBe(true);
    expect(lib.isAfterKeyColon("image:")).toBe(false);
    expect(lib.isAfterKeyColon("image")).toBe(false);
  });
});

describe("tikapp.html schema resolution for re-emitted YAML", () => {
  // Excerpt shaped like RouterOS 7.25 re-emitted output: sorted keys, quoted
  // scalars, quoted keys wherever the emitter chose them.
  const excerpt: Array<{ line: string; path: string[] }> = [
    { line: "services:", path: ["services"] },
    { line: "  'code-server':", path: ["services", "code-server"] },
    { line: "    'container_name': 'code-server'", path: ["services", "code-server", "container_name"] },
    { line: "    environment:", path: ["services", "code-server", "environment"] },
    { line: "      PASSWORD: '[secret:x]'", path: ["services", "code-server", "environment", "PASSWORD"] },
    { line: "      'PWA_APPNAME': 'code-server'", path: ["services", "code-server", "environment", "PWA_APPNAME"] },
    { line: "    image: 'lscr.io/linuxserver/code-server:latest'", path: ["services", "code-server", "image"] },
    { line: "    ports:", path: ["services", "code-server", "ports"] },
  ];

  test("every key token extracts unquoted", () => {
    for (const { line, path } of excerpt) {
      expect(lib.matchKeyLine(line)?.key).toBe(path[path.length - 1]);
    }
  });

  test("quoted service name resolves to the service schema", () => {
    const node = resolved(["services", "code-server"]);
    expect(node).not.toBeNull();
    if (node) expect((node.properties as SchemaNode).image).toBeDefined();
  });

  test("documented service properties resolve with descriptions", () => {
    for (const key of ["container_name", "environment", "image", "ports"]) {
      const node = resolved(["services", "code-server", key]);
      expect(node).not.toBeNull();
      if (node) {
        expect(typeof node.description).toBe("string");
        expect((node.description as string).length).toBeGreaterThan(0);
      }
    }
  });

  test("quoted env vars resolve through additionalProperties", () => {
    for (const key of ["PASSWORD", "PWA_APPNAME"]) {
      expect(resolved(["services", "code-server", "environment", key])).not.toBeNull();
    }
  });

  test("bare-key (pre-7.25) YAML resolves identically", () => {
    const bare: Array<{ line: string; path: string[] }> = [
      { line: "services:", path: ["services"] },
      { line: "  code-server:", path: ["services", "code-server"] },
      { line: "    image: lscr.io/linuxserver/code-server:latest", path: ["services", "code-server", "image"] },
      { line: "    container_name: code-server", path: ["services", "code-server", "container_name"] },
    ];
    for (const { line, path } of bare) {
      expect(lib.matchKeyLine(line)?.key).toBe(path[path.length - 1]);
      expect(resolved(path)).not.toBeNull();
    }
  });
});
