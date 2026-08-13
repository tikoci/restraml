import fs from "node:fs";
import path from "node:path";

const DOCS_ROOT = path.resolve("docs");
const OUTPUT_PATH = path.join(DOCS_ROOT, "docs-index.json");
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?(?:beta|rc)?\d*$/;
const SYNTHETIC_VERSIONS = new Set(["nightly"]);
const EXCLUDED_PATHS = new Set();

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function parseVersion(str) {
  const match = str.match(/^(\d+)\.(\d+)(?:\.(\d+))?(beta|rc)?(\d+)?$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3] || "0", 10),
    pre: match[4] || "",
    preNum: match[5] ? Number.parseInt(match[5], 10) : (match[4] ? 0 : Number.POSITIVE_INFINITY),
  };
}

function compareVersions(a, b) {
  if (a === b) return 0;
  if (SYNTHETIC_VERSIONS.has(a)) return -1;
  if (SYNTHETIC_VERSIONS.has(b)) return 1;
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va && !vb) return a.localeCompare(b);
  if (!va) return 1;
  if (!vb) return -1;
  if (va.major !== vb.major) return vb.major - va.major;
  if (va.minor !== vb.minor) return vb.minor - va.minor;
  if (va.patch !== vb.patch) return vb.patch - va.patch;
  if (va.preNum !== vb.preNum) return vb.preNum - va.preNum;
  return 0;
}

function isPreRelease(version) {
  return SYNTHETIC_VERSIONS.has(version) || /(?:beta|rc)\d*$/.test(version);
}

function scanDir(absDir, relDir, name) {
  const children = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = [];
  const dirs = [];

  for (const child of children) {
    const absChild = path.join(absDir, child.name);
    const relChild = toPosix(path.join(relDir, child.name));
    if (EXCLUDED_PATHS.has(relChild)) continue;

    if (child.isFile()) {
      files.push({
        name: child.name,
        path: relChild,
        type: "file",
      });
      continue;
    }

    if (child.isDirectory()) {
      dirs.push(scanDir(absChild, relChild, child.name));
    }
  }

  return {
    name,
    path: relDir,
    type: "dir",
    files,
    dirs,
  };
}

function scanRootFiles() {
  const files = fs
    .readdirSync(DOCS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .filter((entry) => !EXCLUDED_PATHS.has(toPosix(path.join("docs", entry.name))))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      path: toPosix(path.join("docs", entry.name)),
      type: "file",
    }));

  if (
    !EXCLUDED_PATHS.has("docs/docs-index.json") &&
    !files.some((entry) => entry.name === "docs-index.json")
  ) {
    files.push({
      name: "docs-index.json",
      path: "docs/docs-index.json",
      type: "file",
    });
    files.sort((a, b) => a.name.localeCompare(b.name));
  }

  return files;
}

function scanVersionDirs() {
  return fs
    .readdirSync(DOCS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_RE.test(entry.name))
    .sort((a, b) => compareVersions(a.name, b.name))
    .map((entry) =>
      scanDir(
        path.join(DOCS_ROOT, entry.name),
        toPosix(path.join("docs", entry.name)),
        entry.name,
      ),
    );
}

if (!fs.existsSync(DOCS_ROOT) || !fs.statSync(DOCS_ROOT).isDirectory()) {
  throw new Error(`docs/ directory not found at ${DOCS_ROOT}`);
}

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--exclude") {
    const value = process.argv[i + 1];
    if (!value) throw new Error("--exclude requires a relative docs/ path");
    EXCLUDED_PATHS.add(toPosix(value.replace(/^\.?\//, "")));
    i++;
  }
}

const versions = scanVersionDirs();
const stableVersions = versions.filter((version) => !isPreRelease(version.name));

let nightly = null;
try {
  const nightlyPath = path.join(DOCS_ROOT, "nightly", "nightly.json");
  if (fs.existsSync(nightlyPath)) {
    const raw = fs.readFileSync(nightlyPath, "utf-8");
    const data = JSON.parse(raw);
    if (data && typeof data.nightlyVersion === "string" && typeof data.builtAt === "string") {
      nightly = { name: "nightly", nightlyVersion: data.nightlyVersion, builtAt: data.builtAt };
    }
  }
} catch {
  // ignore malformed nightly.json — nightly stays null
}

const payload = {
  format: "restraml-docs-index@1",
  generatedAt: new Date().toISOString(),
  rootPath: "docs",
  latestVersion: versions[0]?.name || null,
  latestStableVersion: stableVersions[0]?.name || null,
  ...(nightly ? { nightly } : {}),
  files: scanRootFiles(),
  versions,
};

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Written ${OUTPUT_PATH} (${versions.length} version directories)${nightly ? ` + nightly ${nightly.nightlyVersion}` : ""}`);
