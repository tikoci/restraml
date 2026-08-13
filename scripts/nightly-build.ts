#!/usr/bin/env bun
/**
 * nightly-build.ts — validate RouterOS nightly (ab) upgrade via quickchr
 *
 * Provisional "squeeze out unknowns before CI" step from #90.
 * Boots a stable CHR via @tikoci/quickchr, discovers the current nightly
 * (mt.lv Box), downloads arch-specific NPKs, uploads via quickchr SCP,
 * reboots, and validates the version moves to the nightly build.
 *
 * Now arch-aware and CI-hardened:
 *   - `--arch x86|arm64` — x86 uses HVF on Intel, arm64 uses TCG (slow but viable)
 *   - `--skip-collect` / `--skip-crawl` — skip heavy rest2raml+deep-inspect; do
 *     only shallow probes (version + packages + /console/inspect child count).
 *     Recommended for arm64/TCG where full enrichment is ~10 min under TCG.
 *   - Per-arch machine names, timeouts, and package filters so x86 and arm64
 *     runs can coexist and map directly to the eventual nightly.yaml workflow.
 *   - Always boots a fresh quickchr instance (never reuses a mikropkl Machine);
 *     the inspect crawl is the slow part, not CHR boot — this script proves that.
 *   - Pinned to `stable` by default (`--channel stable` / `--base-version` override).
 *   - Writes provenance `nightly.json` under the per-run tmp dir (mirrors the
 *     `docs/nightly/nightly.json` strawman from #90).
 *
 * Usage:
 *   bun scripts/nightly-build.ts
 *   bun scripts/nightly-build.ts --arch arm64 --skip-collect
 *   bun scripts/nightly-build.ts --arch arm64 --skip-collect --keep-running
 *   bun scripts/nightly-build.ts --base-version 7.23.3 --arch x86
 *   bun scripts/nightly-build.ts --dry-run --arch arm64   # discover only
 */

import { parseArgs } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QuickCHR } from "@tikoci/quickchr";

// Public share-link token for https://mt.lv/nightly-build → box.mikrotik.com/d/<token>/
// This is not a secret; it is embedded in the public redirect and the Box API URL.
const PINNED_TOKEN = "5ce46054d5d2487e8755";
const MT_LV_URL = "https://mt.lv/nightly-build";

async function resolveToken(): Promise<string> {
  try {
    const res = await fetch(MT_LV_URL, { redirect: "manual" });
    const loc = res.headers.get("location") ?? res.headers.get("Location") ?? "";
    const m = loc.match(/\/d\/([a-f0-9]+)/);
    if (m?.[1]) {
      console.log("→ mt.lv nightly-build resolved (302)");
      return m[1];
    }
  } catch (e) {
    console.warn(`  mt.lv resolve failed (${String(e).slice(0, 200)}), falling back to pinned token`);
  }
  return PINNED_TOKEN;
}

function boxApiUrl(token: string): string {
  return `https://box.mikrotik.com/api/v2.1/share-links/${token}/dirents/?path=/&thumbnail_size=48`;
}
function boxDlUrl(token: string, file: string): string {
  return `https://box.mikrotik.com/d/${token}/files/?p=/${encodeURIComponent(file)}&dl=1`;
}

type Arch = "x86" | "arm64";

function log(s: string) {
  console.log(s);
}
function fail(msg: string): never {
  throw new Error(`\n✖ ${msg}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    arch: { type: "string", default: "x86" },
    "base-version": { type: "string" },
    channel: { type: "string", default: "stable" },
    "keep-running": { type: "boolean", default: false },
    "skip-collect": { type: "boolean", default: false },
    "skip-crawl": { type: "boolean", default: false },
    "skip-deep-inspect": { type: "boolean", default: false },
    "output-dir": { type: "string" },
    "machine-name": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowNegative: true,
});

if (values.help) {
  console.log(
    `
nightly-build — nightly upgrade probe via quickchr

Usage:
  bun scripts/nightly-build.ts [options]

Options:
  --arch <x86|arm64>        Target architecture (default: x86). arm64 on Intel
                            uses TCG (slow emulation) — pair with --skip-collect.
  --channel <name>          Base channel to boot before upgrade (default: stable).
                            Pinned to stable for nightly promotion; overridden by
                            --base-version.
  --base-version <ver>      Pin to an explicit RouterOS version instead of channel.
  --skip-collect            Skip heavy collection (rest2raml crawl + deep-inspect).
                            Does only shallow probes: /system/resource, /system/package,
                            /console/inspect child count. Aliases: --skip-crawl,
                            --skip-deep-inspect. Recommended for arm64/TCG.
  --output-dir <dir>        Where to write deep-inspect outputs when not skipped
                            (default: /tmp/nightly-quickchr-<ver>-<arch>).
  --machine-name <name>     Override quickchr machine name (default:
                            restraml-nightly-quickchr-<arch>).
  --keep-running            Leave CHR running after the run (for manual inspection).
  --dry-run                 Discover nightly + filter per-arch NPKs and exit (no QEMU).
  --help                    Show this help.

Examples:
  bun scripts/nightly-build.ts --arch x86
  bun scripts/nightly-build.ts --arch arm64 --skip-collect
  bun scripts/nightly-build.ts --arch arm64 --skip-collect --keep-running
`.trim(),
  );
  process.exit(0);
}

const ARCH = (() => {
  const raw = (values.arch as string) ?? "x86";
  if (raw !== "x86" && raw !== "arm64") fail(`--arch must be x86 or arm64; got "${raw}"`);
  return raw as Arch;
})();

const BASE_VERSION: string | undefined = values["base-version"] as string | undefined;
const CHANNEL = (values.channel as string) ?? "stable";
const KEEP_RUNNING = Boolean(values["keep-running"]);
const SKIP_COLLECT =
  Boolean(values["skip-collect"] || values["skip-crawl"] || values["skip-deep-inspect"]);
// cross-arch on this host = TCG = slower reboot/probe windows
const NATIVE_HOST_ARCH: Record<Arch, string> = { x86: "x64", arm64: "arm64" };
const IS_CROSS_ARCH = process.arch !== NATIVE_HOST_ARCH[ARCH];
const MACHINE_NAME = (values["machine-name"] as string | undefined) ?? `restraml-nightly-quickchr-${ARCH}`;
const EXTRA_TIMEOUT_MS = IS_CROSS_ARCH ? 120_000 : 0; // extra headroom for TCG reboots

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// ── Nightly discovery (arch-aware) ───────────────────────────────────────────

export function filterNpksByArch(files: string[], nightlyVer: string, arch: Arch): string[] {
  const nightlyFiles = files.filter((f) => f.includes(nightlyVer) && f.endsWith(".npk"));
  if (arch === "arm64") {
    // arm64: only -arm64 NPKs. The nightly share also contains generic (x86)
    // unsuffixed files (e.g. container-7.25_ab431.npk) that must not be mixed.
    return nightlyFiles.filter((f) => f.toLowerCase().includes("-arm64")).sort();
  }
  // x86: generic unsuffixed packages (container, wireless, etc.) plus
  // routeros-x86-*.npk for the base system. The nightly share added a byte-
  // identical generic routeros-7.25_ab431.npk duplicate of routeros-x86 in
  // ab431 — uploading both causes RouterOS to see a duplicate identity and
  // silently skip the upgrade, so we exclude generic routeros for x86.
  const X86_REJECT = ["-arm", "-arm64", "-mipsbe", "-mmips", "-ppc", "-tile", "-smips"];
  return nightlyFiles
    .filter((f) => {
      const lower = f.toLowerCase();
      if (lower.startsWith("routeros-") && !lower.startsWith("routeros-x86-")) return false;
      if (lower.includes("-x86")) return true;
      return !X86_REJECT.some((tag) => lower.includes(tag));
    })
    .sort();
}

export function parseAb(v: string): [number, number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?_ab(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), Number(m[4])];
}

export function compareAb(a: string, b: string): number {
  const pa = parseAb(a);
  const pb = parseAb(b);
  if (!pa && !pb) return a.localeCompare(b);
  if (!pa) return 1;
  if (!pb) return -1;
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  if (pa[2] !== pb[2]) return pa[2] - pb[2];
  return pa[3] - pb[3];
}

async function discoverNightly(arch: Arch): Promise<{ version: string; files: string[]; allFiles: string[]; token: string }> {
  const token = await resolveToken();
  const apiUrl = boxApiUrl(token);
  log(`→ discovering nightly via Box API ${apiUrl} (arch=${arch})`);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(apiUrl, { headers: { Accept: "application/json" }, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) fail(`Box API ${res.status} ${await res.text().then((t) => t.slice(0, 500))}`);
  const data = (await res.json()) as { dirent_list: Array<{ file_name: string; size?: number }> };
  const allFiles: string[] = (data.dirent_list ?? []).map((d) => d.file_name);
  const nightlyRe = /(\d+\.\d+(?:\.\d+)?_ab\d+)/;
  const versions = [...new Set(allFiles.map((f) => f.match(nightlyRe)?.[1]).filter(Boolean))] as string[];
  if (versions.length === 0) fail("no nightly version found in Box dirent list");
  const nightlyVer = [...versions].sort(compareAb).at(-1);
  if (!nightlyVer) fail("no nightly version found in Box dirent list");
  log(`  Box dirents: ${allFiles.length} files; nightly versions: ${versions.join(", ")} → latest ${nightlyVer}`);
  const files = filterNpksByArch(allFiles, nightlyVer, arch);
  if (files.length === 0) fail(`no ${arch} NPKs for ${nightlyVer} (arch filter rejected all ${allFiles.filter((f) => f.includes(nightlyVer)).length} nightly files)`);
  log(`  ${arch} NPKs (${files.length}): ${files.join(", ")}`);
  return { version: nightlyVer, files, allFiles, token };
}

async function downloadNpks(files: string[], dir: string, token: string) {
  mkdirSync(dir, { recursive: true });
  log(`→ downloading ${files.length} NPKs to ${dir}`);
  for (const file of files) {
    const url = boxDlUrl(token, file);
    const dest = join(dir, file);
    if (existsSync(dest)) {
      const sz = statSync(dest).size;
      log(`  · ${file} (cached, ${formatBytes(sz)})`);
      continue;
    }
    log(`  · ${file} <- ${url}`);
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) fail(`download ${file} failed: ${r.status} ${await r.text().then((t) => t.slice(0, 200))}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await Bun.write(dest, buf);
    log(`    ${formatBytes(buf.length)}`);
  }
  let bytes = 0;
  for (const f of readdirSync(dir)) {
    try {
      bytes += statSync(join(dir, f)).size;
    } catch (e) {
      log(`  ignored error: ${String(e).slice(0, 200)}`);
    }
  }
  log(`  downloaded ${formatBytes(bytes)} total`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { version: nightlyVer, files: archFiles, token: nightlyToken } = await discoverNightly(ARCH);
  const tmpDir = (() => {
    const custom = values["output-dir"] as string | undefined;
    if (custom) {
      mkdirSync(custom, { recursive: true });
      return custom;
    }
    return mkdtempSync(join(tmpdir(), `nightly-quickchr-${nightlyVer}-${ARCH}-`));
  })();

  if (values["dry-run"]) {
    log(`\n--dry-run: would download ${archFiles.length} ${ARCH} NPK(s) for ${nightlyVer} to ${join(tmpDir, "npks")}`);
    for (const f of archFiles) log(`  ${f}`);
    log(`\n✓ dry-run done — no CHR started (arch=${ARCH} ${IS_CROSS_ARCH ? "[cross-arch TCG on x64]" : "[native]"})`);
    return;
  }

  if (IS_CROSS_ARCH) {
    log(`\nNote: ${ARCH} on x64 host → TCG (software emulation). Boot and post-reboot REST probes are slower than x86/HVF; timeouts are relaxed. Pair with --skip-collect to avoid the multi-minute enrichment crawl.`);
  }

  // ── ensure no stale machine with the same name ──
  // QuickCHR.list() is sync (refreshes PID status), get() is sync — no await needed.
  const all = QuickCHR.list();
  const stale = all.find((m) => m.name === MACHINE_NAME);
  if (stale) {
    log(`→ removing stale machine ${MACHINE_NAME} (${stale.status})`);
    const inst = QuickCHR.get(MACHINE_NAME);
    if (inst) {
      try {
        await inst.stop();
      } catch (e) {
        log(`  ignored error: ${String(e).slice(0, 200)}`);
      }
      try {
        await inst.remove();
      } catch (e) {
        log(`  ignored error: ${String(e).slice(0, 200)}`);
      }
    } else {
      await Bun.spawn(["bunx", "--bun", "quickchr", "remove", MACHINE_NAME, "--force"], {
        stdout: "inherit",
        stderr: "inherit",
      }).exited;
    }
  }

  await downloadNpks(archFiles, join(tmpDir, "npks"), nightlyToken);

  // ── boot stable CHR via quickchr — pinned to stable (the nightly.yaml shape) ──
  // Fresh instance every run; the inspect crawl is the slow part, not bring-up.
  // Explicit 1024 MiB for both arches: extra-package installs need it (see CLAUDE.md
  // CI anti-patterns / docs/deep-inspect.md ARM64 postmortem), and nightly upgrades
  // carry extra packages.
  const startOpts = {
    name: MACHINE_NAME,
    arch: ARCH,
    mem: 1024,
    secureLogin: false,
    background: true,
    ...(BASE_VERSION ? { version: BASE_VERSION } : { channel: CHANNEL }),
  } as Parameters<typeof QuickCHR.start>[0];

  log(`\n→ QuickCHR.start ${JSON.stringify(startOpts)} — downloads CHR image if needed and boots under ${IS_CROSS_ARCH ? "TCG (arm64 on x64)" : "HVF/KVM"}`);

  const t0 = Date.now();
  let chr: Awaited<ReturnType<typeof QuickCHR.start>> | null = null;
  chr = await QuickCHR.start(startOpts);
  const bootMs = Date.now() - t0;
  log(`  CHR ready in ${(bootMs / 1000).toFixed(1)}s at ${chr.restUrl} (http=${chr.ports.http} ssh=${chr.ports.ssh} api=${chr.ports.api})`);
  log(`  pid=${chr.state.pid} version=${chr.state.version} status=${chr.state.status} arch=${chr.state.arch}`);

  // Wrap the remainder so we always clean up the fresh machine (unless --keep-running).
  let runError: unknown;
  let nightlyProvenance: Record<string, unknown> | null = null;
  try {
    const preResource: unknown = await chr.rest("/system/resource");
    const preVer = (preResource as Record<string, unknown>)?.version as string | undefined ?? "(unknown)";
    const preBoard = (preResource as Record<string, unknown>)?.["board-name"] as string | undefined ?? (preResource as Record<string, unknown>)?.boardName as string | undefined ?? "?";
    log(`  pre-upgrade /system/resource version=${preVer} board-name=${preBoard}`);

    try {
      const pkgs: unknown = await chr.rest("/system/package");
      if (Array.isArray(pkgs)) {
        log(`  pre-upgrade packages: ${pkgs.length} (${(pkgs as Array<{ name?: string }>).map((p) => p.name ?? String(p)).join(", ")})`);
      }
    } catch (e) {
      log(`  pre-upgrade packages: (query failed: ${String(e).slice(0, 200)})`);
      throw e;
    }

    // ── upload nightly NPKs via quickchr SCP ──
    const npkDir = join(tmpDir, "npks");
    const npkPaths = archFiles.map((f) => join(npkDir, f));
    log(`\n→ uploading ${npkPaths.length} ${ARCH} NPK(s) via instance.upload (SCP)`);
    for (const p of npkPaths) {
      log(`  · ${p}`);
      await chr.upload(p);
      log(`    uploaded`);
    }
    // RouterOS can lose a reboot issued immediately after the last SCP without
    // an fsync window — give the guest a moment to flush.
    await Bun.sleep(2000);
    try {
      const fileList = (await chr.exec("/file print")) as { output: string };
      const out = fileList.output ?? String(fileList);
      log(`  /file after upload:\n${out.slice(0, 1200)}`);
    } catch (e) {
      log(`  ignored error: ${String(e).slice(0, 200)}`);
    }
    try {
      const restFiles: unknown = await chr.rest("/file/print");
      log(`  REST /file/print count=${Array.isArray(restFiles) ? (restFiles as unknown[]).length : "?"}`);
    } catch (e) {
      log(`  REST /file/print failed: ${String(e).slice(0, 200)}`);
    }

    // ── reboot to activate ──
    log(`\n→ rebooting CHR to activate nightly ${nightlyVer} (${ARCH})`);
    try {
      await chr.rest("/system/reboot", { method: "POST", body: JSON.stringify({}) });
      log(`  reboot POST accepted`);
    } catch (e) {
      log(`  reboot POST result: ${String(e).slice(0, 300)} (expected if connection dropped)`);
    }

    const waitMs = (ARCH === "arm64" ? 300_000 : 180_000) + EXTRA_TIMEOUT_MS;
    log(`→ waiting for CHR to come back (waitForBoot ${Math.round(waitMs / 1000)}s, arch=${ARCH}${IS_CROSS_ARCH ? " TCG" : ""})`);
    const ok = await chr.waitForBoot(waitMs);
    if (!ok) {
      log(`  waitForBoot timed out after ${Math.round(waitMs / 1000)}s — probing chr.rest`);
      try {
        const r: unknown = await chr.rest("/system/resource");
        log(`  still reachable: ${JSON.stringify(r).slice(0, 500)}`);
      } catch (e) {
        log(`  not reachable: ${String(e).slice(0, 500)}`);
      }
      fail("CHR did not become REST-ready after reboot");
    }
    log(`  CHR back up`);

    // ── verify version moved ──
    let postVer: string | undefined;
    let postResource: unknown;
    for (let i = 0; i < 8; i++) {
      try {
        postResource = await chr.rest("/system/resource");
        postVer = (postResource as Record<string, unknown>)?.version as string | undefined;
        log(`  /system/resource version=${postVer} (attempt ${i + 1})`);
        if (postVer === nightlyVer) break;
        if (postVer && postVer !== preVer) log(`  version changed but not matching nightlyVer — postVer=${postVer} nightlyVer=${nightlyVer}`);
        await Bun.sleep(2000);
      } catch (e) {
        log(`  /system/resource retry ${i + 1}: ${String(e).slice(0, 300)}`);
        await Bun.sleep(3000);
      }
    }
    if (postVer !== nightlyVer) {
      try {
        const er = (await chr.exec("/system resource print")) as { via: string; output: string };
        log(`  /system resource print via exec (${er.via}): ${er.output.slice(0, 500)}`);
      } catch (e) {
        log(`  exec print failed: ${String(e).slice(0, 300)}`);
      }
      fail(`Version mismatch after upgrade: expected nightly ${nightlyVer}, got ${postVer ?? "(unknown)"} (pre=${preVer})`);
    } else {
      log(`  ✓ upgraded: ${preVer} → ${postVer}`);
    }

    let postPkgCount = 0;
    let postPkgNames: string[] = [];
    try {
      const pkgs: unknown = await chr.rest("/system/package");
      if (Array.isArray(pkgs)) {
        const list = pkgs as Array<{ name?: string; version?: string; "build-time"?: string }>;
        postPkgCount = list.length;
        postPkgNames = list.map((p) => p.name ?? "?");
        log(`  post-upgrade packages: ${postPkgCount} names=${postPkgNames.join(", ")}`);
        for (const p of list) if (p.version) log(`    ${p.name} ${p.version} build-time=${p["build-time"] ?? "?"}`);
        const expectedMin = ARCH === "arm64" ? 9 : 5;
        if (postPkgCount < expectedMin) fail(`Package count ${postPkgCount} < expected ${expectedMin} for ${ARCH} — extra-package set incomplete after upgrade`);
        else log(`  ✓ package count ${postPkgCount} ≥ ${expectedMin} for ${ARCH}`);
        if (postPkgNames.length !== archFiles.length) {
          log(`  ⚠ uploaded ${archFiles.length} NPKs but RouterOS reports ${postPkgCount} packages — possible duplicate/filter mismatch`);
        }
      } else log(`  packages raw=${JSON.stringify(pkgs).slice(0, 800)}`);
    } catch (e) {
      log(`  package query failed: ${String(e).slice(0, 400)}`);
      throw e;
    }

    // ── shallow probes (always, even when skipping heavy collection) ──
    log(`\n→ shallow probes (REST smoke)`);
    try {
      const root: unknown = await chr.rest("/console/inspect", {
        method: "POST",
        body: JSON.stringify({ request: "child", path: "" }),
      });
      const count = Array.isArray(root) ? root.length : Object.keys((root as object) ?? {}).length;
      const sample: string[] = Array.isArray(root)
        ? (root as Array<{ name?: string }>).map((r) => r.name ?? String(r)).slice(0, 12)
        : Object.keys((root as object) ?? {}).slice(0, 12);
      log(`  /console/inspect root children: ${count} sample=${sample.join(", ")}`);
      if (count < 70) log(`  ⚠ root child count ${count} is below typical (~79-83) — inspect tree may be incomplete`);
    } catch (e) {
      log(`  /console/inspect probe failed: ${String(e).slice(0, 500)}`);
    }

    // Provenance artifact — mirrors docs/nightly/nightly.json strawman from #90
    nightlyProvenance = {
      nightlyVersion: nightlyVer,
      arch: ARCH,
      baseVersion: preVer,
      postVersion: postVer ?? null,
      machineName: MACHINE_NAME,
      builtAt: new Date().toISOString(),
      tmpDir,
      bootMs,
      packageCount: postPkgCount,
      packageNames: postPkgNames,
      channel: BASE_VERSION ? null : CHANNEL,
      hostArch: process.arch,
      crossArchTcg: IS_CROSS_ARCH,
      skipCollect: SKIP_COLLECT,
    };
    try {
      writeFileSync(join(tmpDir, "nightly.json"), JSON.stringify(nightlyProvenance, null, 2) + "\n");
      log(`  provenance → ${join(tmpDir, "nightly.json")}`);
    } catch (e) {
      log(`  ignored error: ${String(e).slice(0, 200)}`);
    }

    if (SKIP_COLLECT) {
      log(`\n→ --skip-collect: skipping rest2raml + deep-inspect (use without flag to run full collection — slow under TCG)`);
      if (postVer !== nightlyVer) {
        log(`\n⚠ completed with version mismatch — inspect packages/provenance above`);
      } else {
        log(`\n✓ nightly upgrade validated (shallow) — nightly ${nightlyVer} (${ARCH}) via quickchr${IS_CROSS_ARCH ? " [TCG]" : ""}`);
      }
      return;
    }

    // ── schema generation smoke (only when not skipped) ──
    log(`\n→ running rest2raml.js --version against upgraded CHR`);
    const env = await chr.subprocessEnv();
    {
      const repoRoot = join(import.meta.dir, "..");
      const proc = Bun.spawn(["bun", "rest2raml.js", "--version"], {
        cwd: repoRoot,
        env: { ...(process.env as Record<string, string>), ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      log(`  rest2raml --version stdout: ${out.trim().slice(0, 500)}`);
      if (err) log(`  stderr: ${err.slice(0, 500)}`);
      if (code !== 0) throw new Error(`rest2raml --version failed with exit code ${code}: ${err.slice(0, 500)}`);
    }

    try {
      const root: unknown = await chr.rest("/console/inspect", {
        method: "POST",
        body: JSON.stringify({ request: "child", path: "" }),
      });
      const keys = Array.isArray(root)
        ? (root as Array<{ name?: string }>).map((r) => r.name ?? String(r)).slice(0, 12)
        : Object.keys((root as object) ?? {}).slice(0, 12);
      log(`  root child count=${Array.isArray(root) ? root.length : Object.keys((root as object) ?? {}).length} sample=${keys.join(", ")}`);
    } catch (e) {
      log(`  inspect failed: ${String(e).slice(0, 500)}`);
    }

    log(`\n→ running full rest2raml crawl`);
    {
      const repoRootCrawl = join(import.meta.dir, "..");
      const proc = Bun.spawn(["bun", "rest2raml.js"], {
        cwd: repoRootCrawl,
        env: { ...(process.env as Record<string, string>), ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      log(`  rest2raml exit=${code} stdout ${out.length} chars, stderr ${err.length} chars`);
      if (err) log(`  stderr preview: ${err.slice(0, 800)}`);
      if (code !== 0) throw new Error(`rest2raml crawl failed with exit code ${code}: ${err.slice(0, 800)}`);
      const repoRootArtifacts = join(import.meta.dir, "..");
      const arts = readdirSync(repoRootArtifacts).filter((f) => f.startsWith("ros-"));
      log(`  artifacts: ${arts.join(", ")}`);
      for (const a of arts.slice(0, 4)) {
        try {
          const st = statSync(join(repoRootArtifacts, a));
          log(`    ${a} ${(st.size / 1024 / 1024).toFixed(2)} MiB`);
        } catch (e) {
          log(`    stat ${a} failed: ${String(e).slice(0, 200)}`);
        }
      }
    }

    log(`\n→ running deep-inspect (enrichment) — can take minutes${IS_CROSS_ARCH ? " [longer under TCG]" : ""}`);
    {
      const deepArgs = [
        "deep-inspect.ts",
        "--live",
        "--arch",
        ARCH,
        "--transport",
        "rest",
        "--output-suffix",
        `nightly-quickchr-${ARCH}`,
        "--output-dir",
        tmpDir,
        "--ros-version",
        nightlyVer,
      ];
      log(`  bun ${deepArgs.join(" ")}`);
      const repoRootDeep = join(import.meta.dir, "..");
      const proc = Bun.spawn(["bun", ...deepArgs], {
        cwd: repoRootDeep,
        env: { ...(process.env as Record<string, string>), ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const tD0 = Date.now();
      const code = await proc.exited;
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      log(`  deep-inspect exit=${code} in ${((Date.now() - tD0) / 1000).toFixed(1)}s`);
      log(`  stdout tail:\n${out.slice(-2000)}`);
      if (err) log(`  stderr tail:\n${err.slice(-1500)}`);
      if (code !== 0) throw new Error(`deep-inspect failed with exit code ${code}: ${err.slice(-1500)}`);
      else {
        const outs = readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
        for (const f of outs) {
          try {
            const s = statSync(join(tmpDir, f));
            log(`    ${f} ${(s.size / 1024 / 1024).toFixed(2)} MiB`);
          } catch (e) {
            log(`  ignored error: ${String(e).slice(0, 200)}`);
          }
        }
      }
    }
  } catch (e) {
    runError = e;
    throw e;
  } finally {
    if (!KEEP_RUNNING) {
      log(`\n→ cleaning up: stopping and removing ${MACHINE_NAME}`);
      try {
        const inst = (chr ?? QuickCHR.get(MACHINE_NAME));
        if (inst) {
          try {
            await inst.stop();
          } catch (ex) {
            log(`  stop: ${String(ex).slice(0, 200)}`);
          }
          try {
            await inst.remove();
          } catch (ex) {
            log(`  remove: ${String(ex).slice(0, 200)}`);
          }
        } else {
          log(`  no machine handle for ${MACHINE_NAME} — nothing to clean`);
        }
      } catch (ex) {
        log(`  cleanup failed: ${String(ex).slice(0, 400)}`);
      }
    } else {
      try {
        const inst = (chr ?? QuickCHR.get(MACHINE_NAME));
        const url = inst ? (inst as { restUrl?: string }).restUrl ?? "(no url)" : "(not started)";
        log(`\n→ --keep-running: left CHR ${MACHINE_NAME} running at ${url}`);
        log(`   quickchr list; quickchr stop ${MACHINE_NAME}; quickchr remove ${MACHINE_NAME} to clean up`);
        if (nightlyProvenance) log(`   provenance: ${join(tmpDir, "nightly.json")}`);
      } catch (e) {
        log(`  ignored error: ${String(e).slice(0, 200)}`);
      }
    }
    if (!runError && nightlyProvenance) {
      const pv = nightlyProvenance as Record<string, unknown>;
      const nv = pv.nightlyVersion as string;
      log(`\n✓ nightly-build done — nightly ${nv} (${ARCH}) via quickchr${IS_CROSS_ARCH ? " [TCG]" : " [HVF/KVM]"} validated${SKIP_COLLECT ? " (shallow)" : ""}`);
      log(`  tmp: ${tmpDir}  provenance: ${join(tmpDir, "nightly.json")}`);
    }
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
