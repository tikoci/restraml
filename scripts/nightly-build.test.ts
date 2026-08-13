import { describe, test, expect } from "bun:test";
import {
  buildOutputSuffix,
  compareAb,
  filterNpksByArch,
  getArgsTotalFloor,
  getExpectedMinPackageCount,
  getNpksForPhase,
  parseAb,
} from "./nightly-build.ts";

const fixture = await Bun.file("fixtures/nightly-dirent-list.json").json() as {
  dirent_list: Array<{ file_name: string }>;
};
const allFiles = fixture.dirent_list.map((d) => d.file_name);
// The fixture is a real 40-file capture of 7.25_ab434 (2026-08-13T16:34-16:44Z)
const VER = "7.25_ab434";

describe("filterNpksByArch (nightly duplicate gotcha)", () => {
  test("x86 is exactly 5 with one base NPK and no generic duplicate", () => {
    const x86 = filterNpksByArch(allFiles, VER, "x86");
    expect(x86).toHaveLength(5);
    expect(x86).toContain("routeros-x86-7.25_ab434.npk");
    expect(x86).not.toContain("routeros-7.25_ab434.npk"); // generic duplicate
    expect(x86).toContain("container-7.25_ab434.npk");
    expect(x86).toContain("wireless-7.25_ab434.npk");
    expect(x86).toContain("iot-7.25_ab434.npk");
    expect(x86).toContain("rose-storage-7.25_ab434.npk");
    expect(x86.filter((f) => f.startsWith("routeros-"))).toHaveLength(1);
    expect(x86.every((f) => !f.includes("-arm"))).toBe(true);
  });

  test("arm64 is exactly 9 with one base NPK", () => {
    const arm64 = filterNpksByArch(allFiles, VER, "arm64");
    expect(arm64).toHaveLength(9);
    expect(arm64.filter((f) => f.startsWith("routeros-"))).toHaveLength(1);
    expect(arm64).toContain("routeros-7.25_ab434-arm64.npk");
    expect(arm64).not.toContain("routeros-7.25_ab434.npk");
    expect(arm64).not.toContain("routeros-x86-7.25_ab434.npk");
    expect(arm64.every((f) => f.includes("-arm64"))).toBe(true);
    expect(arm64).toContain("container-7.25_ab434-arm64.npk");
    expect(arm64).toContain("wireless-7.25_ab434-arm64.npk");
    expect(arm64).toContain("zerotier-7.25_ab434-arm64.npk");
  });

  test("neither arch contains the generic routeros duplicate", () => {
    const x86 = filterNpksByArch(allFiles, VER, "x86");
    const arm64 = filterNpksByArch(allFiles, VER, "arm64");
    expect(x86).not.toContain("routeros-7.25_ab434.npk");
    expect(arm64).not.toContain("routeros-7.25_ab434.npk");
  });

  test("ab version filtering is exact", () => {
    const x86_434 = filterNpksByArch(allFiles, VER, "x86");
    expect(x86_434.every((f) => f.includes("ab434"))).toBe(true);
    // Non-existent version should yield empty
    const x86_none = filterNpksByArch(allFiles, "7.25_ab999", "x86");
    expect(x86_none).toHaveLength(0);
  });

  test("numeric ab sort picks highest ab, not lexicographic (uses production compareAb)", async () => {
    const versions = ["7.25_ab99", "7.25_ab433", "7.25_ab100"];
    const lex = [...versions].sort().at(-1);
    const numeric = [...versions].sort(compareAb).at(-1);
    expect(lex).toBe("7.25_ab99"); // lexicographic bug
    expect(numeric).toBe("7.25_ab433");
  });

  test("parseAb handles patch segment (7.25.1_ab99)", () => {
    expect(parseAb("7.25.1_ab99")).toEqual([7, 25, 1, 99]);
    expect(parseAb("7.25_ab433")).toEqual([7, 25, 0, 433]);
    expect(parseAb("7.25.1_ab100")).not.toBeNull();
    expect(compareAb("7.25.1_ab99", "7.25_ab99")).toBeGreaterThan(0);
    expect(compareAb("7.25_ab100", "7.25_ab99")).toBeGreaterThan(0);
  });
});

describe("phase-aware helpers (N3.5 — per-phase gates)", () => {
  test("getNpksForPhase splits base vs extra", () => {
    const x86 = filterNpksByArch(allFiles, VER, "x86");
    expect(x86).toHaveLength(5);
    expect(getNpksForPhase(x86, "base")).toEqual(["routeros-x86-7.25_ab434.npk"]);
    expect(getNpksForPhase(x86, "extra")).toHaveLength(5);
    expect(getNpksForPhase(x86, "all")).toHaveLength(5);
    expect(getNpksForPhase(x86, "all")).toEqual(x86);
    const arm64 = filterNpksByArch(allFiles, VER, "arm64");
    expect(getNpksForPhase(arm64, "base")).toEqual(["routeros-7.25_ab434-arm64.npk"]);
    expect(getNpksForPhase(arm64, "extra")).toHaveLength(9);
    expect(getNpksForPhase(arm64, "all")).toHaveLength(9);
  });

  test("getExpectedMinPackageCount is phase-aware", () => {
    expect(getExpectedMinPackageCount("x86", "base")).toBe(1);
    expect(getExpectedMinPackageCount("x86", "extra")).toBe(5);
    expect(getExpectedMinPackageCount("x86", "all")).toBe(5);
    expect(getExpectedMinPackageCount("arm64", "base")).toBe(1);
    expect(getExpectedMinPackageCount("arm64", "extra")).toBe(9);
    expect(getExpectedMinPackageCount("arm64", "all")).toBe(9);
  });

  test("getArgsTotalFloor is phase-aware — base low enough for 28079, extra high", () => {
    // Stable 7.24rc4 base 28079 must pass base floor; extra 35656 must pass extra floor.
    // Nightly ab431 full extra x86 33685 / arm64 34735 must pass extra floor.
    expect(getArgsTotalFloor("x86", "base")).toBeLessThan(28079);
    expect(getArgsTotalFloor("arm64", "base")).toBeLessThan(28079);
    expect(getArgsTotalFloor("x86", "extra")).toBeGreaterThan(25000);
    expect(getArgsTotalFloor("arm64", "extra")).toBeGreaterThan(26000);
    // Extra floors are ~33k/34k as calibrated; base floors ~25k/26k.
    expect(getArgsTotalFloor("x86", "base")).toBe(25000);
    expect(getArgsTotalFloor("arm64", "base")).toBe(26000);
    expect(getArgsTotalFloor("x86", "extra")).toBe(33000);
    expect(getArgsTotalFloor("x86", "all")).toBe(33000);
    expect(getArgsTotalFloor("arm64", "extra")).toBe(34000);
    expect(getArgsTotalFloor("arm64", "all")).toBe(34000);
    // The old phase-blind floor 33000 would have failed the base crawl:
    expect(28079).toBeLessThan(33000);
    expect(28079).toBeGreaterThan(getArgsTotalFloor("x86", "base"));
  });

  test("buildOutputSuffix is arch+phase aware and overridable", () => {
    expect(buildOutputSuffix("x86", "all")).toBe("nightly-quickchr-x86");
    expect(buildOutputSuffix("x86", "extra")).toBe("nightly-quickchr-x86");
    expect(buildOutputSuffix("x86", "base")).toBe("nightly-quickchr-x86-base");
    expect(buildOutputSuffix("arm64", "base")).toBe("nightly-quickchr-arm64-base");
    expect(buildOutputSuffix("arm64", "all")).toBe("nightly-quickchr-arm64");
    expect(buildOutputSuffix("x86", "base", "custom")).toBe("custom");
    expect(buildOutputSuffix("x86", "extra", "deep-inspect.x86")).toBe("deep-inspect.x86");
  });

  test("outs.find fix — phase suffix prevents collision when tmpDir holds two crawls", () => {
    // Simulates N4's one-boot/two-crawl tmpDir holding both files.
    const outs = ["deep-inspect.nightly-quickchr-x86-base.json", "deep-inspect.nightly-quickchr-x86.json", "nightly.json"];
    const baseSuffix = buildOutputSuffix("x86", "base");
    const extraSuffix = buildOutputSuffix("x86", "extra");
    const expectedBase = `deep-inspect.${baseSuffix}.json`;
    const expectedExtra = `deep-inspect.${extraSuffix}.json`;
    expect(expectedBase).toBe("deep-inspect.nightly-quickchr-x86-base.json");
    expect(expectedExtra).toBe("deep-inspect.nightly-quickchr-x86.json");
    expect(outs.includes(expectedBase)).toBe(true);
    expect(outs.includes(expectedExtra)).toBe(true);
    // Old code: outs.find(f => f.startsWith("deep-inspect.")) → ambiguous (always picks first)
    expect(outs.find((f) => f.startsWith("deep-inspect."))).toBe("deep-inspect.nightly-quickchr-x86-base.json");
    // New logic: select by expectedFile first
    expect(outs.includes(expectedBase) ? expectedBase : outs.find((f) => f.startsWith(`deep-inspect.${baseSuffix}`))).toBe(expectedBase);
    expect(outs.includes(expectedExtra) ? expectedExtra : outs.find((f) => f.startsWith(`deep-inspect.${extraSuffix}`))).toBe(expectedExtra);
  });
});
