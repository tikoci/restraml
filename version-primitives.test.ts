import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Parity harness: extracted from Opus review — locks the mirrored primitives
// and the latestVersion/versions[] contract. Both files must agree.

function loadMjsPrimitives(src: string) {
  // Extract SYNTHETIC_VERSIONS, parseVersion, compareVersions, isPreRelease, isVersionDir
  // by evaluating the relevant slice in an isolated Function.
  const slice = src.slice(src.indexOf("const VERSION_RE"), src.indexOf("function scanDir"));
  // Build a function that returns the primitives
  const fn = new Function(`${slice}\nreturn { SYNTHETIC_VERSIONS, parseVersion, compareVersions, isPreRelease, isVersionDir };`);
  return fn() as {
    SYNTHETIC_VERSIONS: Set<string>;
    parseVersion: (s: string) => unknown;
    compareVersions: (a: string, b: string) => number;
    isPreRelease: (s: string) => boolean;
    isVersionDir: (s: string) => boolean;
  };
}

function loadSharedPrimitives(src: string) {
  const slice = src.slice(src.indexOf("const SYNTHETIC_VERSIONS"), src.indexOf("function rebuildSelect"));
  const fn = new Function(`${slice}\nreturn { SYNTHETIC_VERSIONS, parseVersion, compareVersions, isPreRelease };`);
  return fn() as {
    SYNTHETIC_VERSIONS: Set<string>;
    parseVersion: (s: string) => unknown;
    compareVersions: (a: string, b: string) => number;
    isPreRelease: (s: string) => boolean;
  };
}

describe("version primitives parity (N2)", () => {
  test("shared.js and build-docs-index.mjs agree on all pairs", async () => {
    const mjsSrc = await Bun.file("scripts/build-docs-index.mjs").text();
    const sharedSrc = await Bun.file("docs/restraml-shared.js").text();
    const mjs = loadMjsPrimitives(mjsSrc);
    const shared = loadSharedPrimitives(sharedSrc);

    const versions = ["nightly", "7.25", "7.24rc4", "7.23.3", "7.22beta4", "7.21.5", "7.25_ab433", "unknown", "7.25.1"];
    for (const a of versions) {
      for (const b of versions) {
        const r1 = mjs.compareVersions(a, b);
        const r2 = shared.compareVersions(a, b);
        // sign must match (both negative, both positive, or both zero)
        expect(Math.sign(r1), `compareVersions(${a},${b}) sign drift: mjs=${r1} shared=${r2}`).toBe(Math.sign(r2));
      }
      expect(mjs.isPreRelease(a), `mjs isPreRelease(${a})`).toBe(shared.isPreRelease(a));
      expect(mjs.parseVersion(a), `mjs parseVersion(${a})`).toEqual(shared.parseVersion(a));
    }
    // Explicit sentinel checks
    expect(shared.parseVersion("nightly")).toBeNull();
    expect(mjs.parseVersion("nightly")).toBeNull();
    expect(shared.compareVersions("nightly", "nightly")).toBe(0);
    expect(mjs.compareVersions("nightly", "nightly")).toBe(0);
    expect(shared.compareVersions("nightly", "7.24rc4")).toBe(-1);
    expect(mjs.compareVersions("nightly", "7.24rc4")).toBe(-1);
    // isVersionDir only in mjs
    expect(mjs.isVersionDir("nightly")).toBe(true);
    expect(mjs.isVersionDir("7.24rc4")).toBe(true);
    expect(mjs.isVersionDir("unknown")).toBe(false);
  });

  test("build-docs-index: versions[] includes nightly, latestVersion stays real, and openapi discovery works", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "restraml-n2-"));
    try {
      const docs = join(tmp, "docs");
      mkdirSync(docs, { recursive: true });
      // minimal version dirs
      for (const v of ["7.23.3", "7.24rc4"]) {
        mkdirSync(join(docs, v), { recursive: true });
        writeFileSync(join(docs, v, "schema.raml"), "#%RAML 1.0\n");
      }
      // nightly slot with files/dirs
      mkdirSync(join(docs, "nightly"), { recursive: true });
      writeFileSync(join(docs, "nightly", "nightly.json"), JSON.stringify({ nightlyVersion: "7.25_ab433", builtAt: "2026-08-13T15:58:02.000Z" }));
      writeFileSync(join(docs, "nightly", "inspect.json"), "{}");
      writeFileSync(join(docs, "nightly", "openapi.json"), "{}");
      mkdirSync(join(docs, "nightly", "extra"), { recursive: true });
      writeFileSync(join(docs, "nightly", "extra", "openapi.json"), "{}");

      // Run the generator against this tmp tree by temporarily swapping cwd?
      // Instead, invoke the script with a custom DOCS_ROOT via env override:
      // The script uses path.resolve("docs") — so we run it with cwd=tmp.
      const proc = Bun.spawn(["bun", join(import.meta.dir, "scripts/build-docs-index.mjs")], {
        cwd: tmp,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      expect(exit).toBe(0);
      const out = JSON.parse(await Bun.file(join(docs, "docs-index.json")).text());
      expect(out.latestVersion).toBe("7.24rc4");
      expect(out.latestStableVersion).toBe("7.23.3");
      expect(out.versions.map((v: { name: string }) => v.name)).toEqual(["nightly", "7.24rc4", "7.23.3"]);
      const nightlyEntry = out.versions.find((v: { name: string }) => v.name === "nightly");
      expect(nightlyEntry).toBeDefined();
      expect(nightlyEntry.files.map((f: { name: string }) => f.name).sort()).toEqual(["inspect.json", "nightly.json", "openapi.json"]);
      expect(nightlyEntry.dirs.map((d: { name: string }) => d.name)).toEqual(["extra"]);
      expect(out.nightly).toEqual({ name: "nightly", nightlyVersion: "7.25_ab433", builtAt: "2026-08-13T15:58:02.000Z" });

      // Without nightly.json, versions[] omits nightly and sibling is absent (checked via rebuild)
      writeFileSync(join(docs, "nightly", "nightly.json"), "{ malformed");
      const proc2 = Bun.spawn(["bun", join(import.meta.dir, "scripts/build-docs-index.mjs")], { cwd: tmp, stdout: "pipe", stderr: "pipe" });
      await proc2.exited;
      const errText = await new Response(proc2.stderr).text();
      expect(errText).toMatch(/Warning: malformed/);
      const out2 = JSON.parse(await Bun.file(join(docs, "docs-index.json")).text());
      // versions[] still includes nightly dir, but nightly sibling is not populated due to malformed JSON — still present as dir, but sibling absent
      expect(out2.versions.map((v: { name: string }) => v.name)).toContain("nightly");
      expect(out2.nightly).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
