import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const repoRoot = import.meta.dir;
const currentSchemaPath = join(repoRoot, "docs/deep-inspect.schema.json");
const futureSchemaPath = join(repoRoot, "docs/deep-inspect.future.schema.json");

const currentSchema = await Bun.file(currentSchemaPath).json();
const futureSchema = await Bun.file(futureSchemaPath).json();

function makeAjv() {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

function collectDeepInspectArtifacts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...collectDeepInspectArtifacts(path));
      continue;
    }
    if (/^deep-inspect(?:\.(?:x86|arm64))?\.json$/.test(entry)) {
      out.push(path);
    }
  }
  return out.sort();
}

function expectValid(validate: ValidateFunction<unknown>, data: unknown, label: string) {
  if (validate(data)) return;
  const errors = validate.errors
    ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("\n");
  throw new Error(`${label} failed schema validation:\n${errors}`);
}

function futureShapeExample() {
  return {
    _meta: {
      version: "7.23",
      generatedAt: "2026-05-29T19:11:08.121Z",
      architecture: "arm64",
      apiTransport: "rest",
      enrichmentDurationMs: 345371,
      crashPathsTested: [],
      crashPathsSafe: [],
      crashPathsCrashed: [],
      completionStats: {
        argsTotal: 3,
        argsWithCompletion: 1,
        argsFailed: 0,
        argsTimedOut: 0,
        argsBlankOnRetry: 0,
      },
      mergeStats: {
        sharedNodes: 2,
        x86OnlyNodes: 0,
        arm64OnlyNodes: 1,
        completionEnumDriftArgs: 1,
        completionPayloadDriftArgs: 0,
        typeMismatchNodes: 0,
        conflictsTotal: 1,
      },
      mergePolicy: {
        sourcePrecedence: ["arm64", "x86"],
        archUniqueNodeSource: "annotate-_source",
        completionConflict: "union",
        typeMismatch: "fail",
      },
      packageProvenance: {
        strategy: "node-_package",
        packages: ["zerotier"],
      },
    },
    zerotier: {
      _type: "dir",
      _source: "arm64",
      _package: "zerotier",
      interface: {
        _type: "dir",
        get: {
          _type: "cmd",
          disabled: {
            _type: "arg",
            desc: "yes | no",
            _completion: {
              "": { style: "none", preference: 96 },
              no: { style: "none", preference: 96 },
              yes: { style: "none", preference: 96 },
            },
          },
        },
      },
    },
  };
}

describe("deep-inspect JSON Schemas", () => {
  const currentAjv = makeAjv();
  const currentValidate = currentAjv.compile(currentSchema);
  const futureAjv = makeAjv();
  const futureValidate = futureAjv.compile(futureSchema);

  test("current schema validates every checked-in deep-inspect artifact", async () => {
    const artifacts = collectDeepInspectArtifacts(join(repoRoot, "docs"));
    expect(artifacts.length).toBeGreaterThan(0);

    for (const artifact of artifacts) {
      const data = await Bun.file(artifact).json();
      expectValid(currentValidate, data, relative(repoRoot, artifact));
    }
  }, 120_000);

  test("future schema remains a superset of current checked-in artifacts", async () => {
    const artifacts = collectDeepInspectArtifacts(join(repoRoot, "docs"));
    expect(artifacts.length).toBeGreaterThan(0);

    for (const artifact of artifacts) {
      const data = await Bun.file(artifact).json();
      expectValid(futureValidate, data, relative(repoRoot, artifact));
    }
  }, 120_000);

  test("current schema rejects future-only merge/provenance fields", () => {
    expect(currentValidate(futureShapeExample())).toBe(false);
  });

  test("future schema accepts planned merge/source/provenance fields", () => {
    expectValid(futureValidate, futureShapeExample(), "future-shape example");
  });
});
