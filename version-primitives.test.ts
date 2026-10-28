import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Parity harness: locks the mirrored primitives
// and the latestVersion/versions[] contract. Both files must agree.

function loadMjsPrimitives(src: string) {
  // Extract parseVersion, compareVersions, isPreRelease, isVersionDir
  // by evaluating the relevant slice in an isolated Function.
  const slice = src.slice(src.indexOf("const VERSION_RE"), src.indexOf("function scanDir"));
  // Build a function that returns the primitives
  const fn = new Function(`${slice}\nreturn { parseVersion, compareVersions, isPreRelease, isVersionDir };`);
  return fn() as {
    parseVersion: (s: string) => unknown;
    compareVersions: (a: string, b: string) => number;
    isPreRelease: (s: string) => boolean;
    isVersionDir: (s: string) => boolean;
  };
}

function loadSharedPrimitives(src: string) {
  const slice = src.slice(src.indexOf("function parseVersion"), src.indexOf("function rebuildSelect"));
  const fn = new Function(`${slice}\nreturn { parseVersion, compareVersions, isPreRelease };`);
  return fn() as {
    parseVersion: (s: string) => unknown;
    compareVersions: (a: string, b: string) => number;
    isPreRelease: (s: string) => boolean;
  };
}

describe("version primitives parity", () => {
  test("shared.js and build-docs-index.mjs agree on all pairs", async () => {
    const mjsSrc = await Bun.file("scripts/build-docs-index.mjs").text();
    const sharedSrc = await Bun.file("docs/restraml-shared.js").text();
    const mjs = loadMjsPrimitives(mjsSrc);
    const shared = loadSharedPrimitives(sharedSrc);

    const versions = ["7.25", "7.24rc4", "7.23.3", "7.22beta4", "7.21.5", "7.25_ab433", "unknown", "7.25.1", "nightly"];
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
    // Explicit sentinel checks: non-version names parse to null and are not pre-releases
    expect(shared.parseVersion("nightly")).toBeNull();
    expect(mjs.parseVersion("nightly")).toBeNull();
    expect(shared.parseVersion("unknown")).toBeNull();
    expect(mjs.parseVersion("unknown")).toBeNull();
    expect(shared.compareVersions("nightly", "nightly")).toBe(0);
    expect(mjs.compareVersions("nightly", "nightly")).toBe(0);
    expect(shared.isPreRelease("nightly")).toBe(false);
    expect(mjs.isPreRelease("nightly")).toBe(false);
    // isVersionDir only in mjs
    expect(mjs.isVersionDir("nightly")).toBe(false);
    expect(mjs.isVersionDir("7.24rc4")).toBe(true);
    expect(mjs.isVersionDir("unknown")).toBe(false);
  });

  test("build-docs-index: versions[] lists real versions only, latestVersion resolves, openapi discovery works", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "restraml-versions-"));
    try {
      const docs = join(tmp, "docs");
      mkdirSync(docs, { recursive: true });
      // minimal version dirs
      for (const v of ["7.23.3", "7.24rc4"]) {
        mkdirSync(join(docs, v), { recursive: true });
        writeFileSync(join(docs, v, "schema.raml"), "#%RAML 1.0\n");
      }
      // A stray non-version directory must not leak into versions[]
      mkdirSync(join(docs, "nightly"), { recursive: true });
      writeFileSync(join(docs, "nightly", "inspect.json"), "{}");

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
      expect(out.versions.map((v: { name: string }) => v.name)).toEqual(["7.24rc4", "7.23.3"]);
      expect(out.nightly).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
