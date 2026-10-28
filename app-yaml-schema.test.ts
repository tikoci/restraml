import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// js-yaml ships no types; load it the same way appyamlvalidate.js does
const YAML: { load(src: string): unknown } = require("js-yaml");

// Anchor tests for the /app YAML schemas against RouterOS's re-serialized YAML.
// From 7.25, apps loaded from app-store-urls (and the built-in collection) come back
// from GET /rest/app re-emitted: sorted keys, every non-letters-only scalar quoted,
// letters-only strings bare. The fixtures below are verbatim RouterOS 7.25 output
// (CHR x86, store-loaded); RouterOS itself read each one back as the authored strings.

const repoRoot = import.meta.dir;
const schemas = {
  strict: await Bun.file(join(repoRoot, "docs/routeros-app-yaml-schema.latest.json")).json(),
  editor: await Bun.file(join(repoRoot, "docs/routeros-app-yaml-schema.editor.json")).json(),
};

// One authored-YAML collection per minor before the 7.25 re-emitter, and the re-emitted 7.25+ ones
const builtinCollections = ["7.22", "7.23.8", "7.24.5", "7.25", "7.26beta1", "7.26beta3"];

function validatorFor(schema: object) {
  // Same Ajv options as appyamlvalidate.js
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

// Authored: command ["--dashboard", "true", "false", "5", "null", "yes", "", "two words"]
// Container argv on 7.25: --dashboard, true, false, 5, null, yes, (empty), two words
const reemittedCommand = `
category: networking
descr: 'argv probe'
name: 'rt-echo'
services:
  svc:
    command:
      - '--dashboard'
      - true
      - false
      - '5'
      - null
      - yes
      -
      - 'two words'
    entrypoint:
      - '/bin/sh'
      - '-c'
      - 'for a in "$@"; do echo "ARG=[$a]"; done; sleep 3600'
      - 'argv0'
    environment:
      FLAG: true
      NOTHING: null
    image: 'docker.io/library/alpine:latest'
`;

// Authored: test ["CMD", "true"], retries: 5
// Container on 7.25: healthcheck-cmd=CMD,true healthcheck-retries=5, healthy
const reemittedHealthcheck = `
category: networking
descr: 'healthcheck probe'
name: 'rt-hc'
services:
  svc:
    command:
      - sleep
      - '3600'
    healthcheck:
      interval: '10s'
      retries: '5'
      'start_period': '2s'
      test:
        - CMD
        - true
    image: 'docker.io/library/alpine:latest'
`;

const badRetries = `
name: rt-badretries
services:
  svc:
    image: docker.io/library/alpine:latest
    healthcheck:
      test: ["CMD", "true"]
      retries: abc
`;

for (const [variant, schema] of Object.entries(schemas)) {
  describe(`routeros-app-yaml-schema (${variant})`, () => {
    const validate = validatorFor(schema);

    test("accepts re-emitted command/entrypoint lists with bare boolean, null and empty items", () => {
      const ok = validate(YAML.load(reemittedCommand));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    test("accepts re-emitted healthcheck with quoted retries and bare boolean in test", () => {
      const ok = validate(YAML.load(reemittedHealthcheck));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    // The manual's own category examples are not among the built-in categories
    test.each(["network", "system", "utilities", "networking"])("accepts category %p", (category) => {
      const ok = validate({ name: "x", category, services: { app: { image: "alpine" } } });
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    test("rejects a non-string category", () => {
      expect(validate({ name: "x", category: 5, services: { app: { image: "alpine" } } })).toBe(false);
    });

    // Built-in collections captured from live CHRs. Each must be non-empty and carry YAML,
    // so an empty app.json ([]) cannot pass as green.
    test.each(builtinCollections)("validates every built-in app in docs/%s/app.json", (version) => {
      const apps: { name?: string; yaml?: unknown }[] = require(join(repoRoot, "docs", version, "app.json"));
      expect(apps.length).toBeGreaterThan(0);
      const failures: string[] = [];
      for (const app of apps) {
        expect(typeof app.yaml).toBe("string");
        if (!validate(YAML.load(app.yaml as string))) {
          failures.push(`${app.name}: ${(validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join("; ")}`);
        }
      }
      expect(failures).toEqual([]);
    });
  });
}

describe("routeros-app-yaml-schema (strict only)", () => {
  test("rejects non-numeric healthcheck.retries", () => {
    const validate = validatorFor(schemas.strict);
    expect(validate(YAML.load(badRetries))).toBe(false);
  });
});
