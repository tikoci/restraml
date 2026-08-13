import { describe, test, expect } from "bun:test";
import { compareAb, filterNpksByArch, parseAb } from "./nightly-build.ts";

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
