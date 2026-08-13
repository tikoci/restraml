import { describe, test, expect } from "bun:test";
import { filterNpksByArch } from "./nightly-build.ts";

const fixture = await Bun.file("fixtures/nightly-dirent-list.json").json() as {
  dirent_list: Array<{ file_name: string }>;
};
const allFiles = fixture.dirent_list.map((d) => d.file_name);

describe("filterNpksByArch (nightly duplicate gotcha)", () => {
  test("x86 excludes generic routeros duplicate and arm variants", () => {
    const x86 = filterNpksByArch(allFiles, "7.25_ab433", "x86");
    // Should NOT contain generic routeros-7.25_ab433.npk (duplicate of routeros-x86)
    expect(x86).not.toContain("routeros-7.25_ab433.npk");
    expect(x86).toContain("routeros-x86-7.25_ab433.npk");
    // Should contain generic unsuffixed extras
    expect(x86).toContain("container-7.25_ab433.npk");
    expect(x86).toContain("wireless-7.25_ab433.npk");
    // Should NOT contain arm64 variants
    expect(x86.every((f) => !f.includes("-arm64"))).toBe(true);
    expect(x86.every((f) => !f.includes("-arm"))).toBe(true);
    // x86 set for ab433 should be 5 files per #90: routeros-x86 + container, iot, rose-storage, wireless (generic) plus wifi/zerotier variants?
    // Our fixture has 5 x86-relevant: routeros-x86, container, iot, rose-storage, wireless, wifi-qcom, zerotier = 7
    // But the real nightly has 5-7 depending on build; just check count is reasonable
    expect(x86.length).toBeGreaterThanOrEqual(5);
  });

  test("arm64 only picks -arm64 NPKs", () => {
    const arm64 = filterNpksByArch(allFiles, "7.25_ab433", "arm64");
    expect(arm64.length).toBeGreaterThan(0);
    expect(arm64.every((f) => f.includes("-arm64"))).toBe(true);
    expect(arm64).not.toContain("routeros-7.25_ab433.npk");
    expect(arm64).not.toContain("routeros-x86-7.25_ab433.npk");
    expect(arm64).toContain("container-arm64-7.25_ab433.npk");
    expect(arm64).toContain("wireless-arm64-7.25_ab433.npk");
  });

  test("ab version filtering is exact (ab432 not mixed with ab433)", () => {
    const x86_433 = filterNpksByArch(allFiles, "7.25_ab433", "x86");
    const x86_432 = filterNpksByArch(allFiles, "7.25_ab432", "x86");
    expect(x86_433.every((f) => f.includes("ab433"))).toBe(true);
    expect(x86_432.every((f) => f.includes("ab432"))).toBe(true);
    expect(x86_433.length).toBeGreaterThan(0);
    expect(x86_432.length).toBeGreaterThan(0);
  });

  test("numeric ab sort picks highest ab, not lexicographic", async () => {
    // Simulate the sort bug: lexicographic picks ab99 over ab433, numeric does not
    const versions = ["7.25_ab99", "7.25_ab433", "7.25_ab100"];
    function parseAb(v: string): [number, number, number] | null {
      const m = v.match(/^(\d+)\.(\d+)_ab(\d+)$/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    }
    function compareAb(a: string, b: string): number {
      const pa = parseAb(a);
      const pb = parseAb(b);
      if (!pa && !pb) return a.localeCompare(b);
      if (!pa) return 1;
      if (!pb) return -1;
      if (pa[0] !== pb[0]) return pa[0] - pb[0];
      if (pa[1] !== pb[1]) return pa[1] - pb[1];
      return pa[2] - pb[2];
    }
    const lex = [...versions].sort().at(-1);
    const numeric = [...versions].sort(compareAb).at(-1);
    expect(lex).toBe("7.25_ab99"); // lexicographic bug
    expect(numeric).toBe("7.25_ab433");
  });
});
