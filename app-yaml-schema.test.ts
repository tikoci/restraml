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

// Service `dns` and `privileged`, checked on CHR 7.25.2 and 7.26beta7 by enabling each app and
// reading the resulting /container entry. RouterOS accepts any /app YAML at add time (even an
// unknown key), so "honored"/"ignored" below is what reached the container, not add-time acceptance.
function serviceWith(fragment: string) {
  return YAML.load(`name: x\nservices:\n  svc:\n    image: alpine:latest\n    ${fragment}\n`);
}

const dnsHonored: [string, string][] = [
  ["block list", "dns:\n      - 8.8.8.8"],
  ["block list of two", "dns:\n      - 8.8.8.8\n      - 1.1.1.1"],
  ["plain string", "dns: 8.8.8.8"],
  ["flow list", "dns: [9.9.9.9, 1.0.0.1]"],
  ["IPv6", "dns:\n      - 2001:4860:4860::8888"],
  ["link-local IPv6", "dns:\n      - fe80::1"],
  ["IPv4-mapped IPv6", "dns: '::ffff:8.8.8.8'"],
];

// All silently dropped from /container dns= (8.8.8 is rewritten to 8.8.0.8 instead)
const dnsIgnored: [string, string][] = [
  ["comma-joined string", "dns: 8.8.8.8,1.1.1.1"],
  ["hostname", "dns:\n      - not-an-ip"],
  ["placeholder", 'dns:\n      - "[routerIP]"'],
  ["leading-zero octets", "dns: 010.000.000.001"],
  ["out-of-range octets", "dns: 999.999.999.999"],
  ["three octets", "dns: 8.8.8"],
  ["scoped IPv6 in a list", "dns:\n      - fe80::1%ether1"],
  ["scoped IPv6 string", "dns: 'fe80::1%ether1'"],
  ["0.0.0.0", "dns: 0.0.0.0"],
  ["::", "dns: '::'"],
  ["0.0.0.0 alongside a valid entry", "dns:\n      - 0.0.0.0\n      - 1.1.1.1"],
];

const privilegedHonored: [string, string][] = [
  ["true", "privileged: true"],
  ["quoted 'true'", "privileged: 'true'"],
  ["false", "privileged: false"],
  ["quoted 'false'", "privileged: 'false'"],
];

const privilegedIgnored: [string, string][] = [
  ["yes", "privileged: yes"],
  ["maybe", "privileged: maybe"],
  ["an object", "privileged: {}"],
];

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

    test.each(dnsHonored)("accepts dns %s (RouterOS sets /container dns=)", (_label, fragment) => {
      const ok = validate(serviceWith(fragment));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    test.each(privilegedHonored)("accepts privileged %s", (_label, fragment) => {
      const ok = validate(serviceWith(fragment));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
    });

    test.each(privilegedIgnored)("rejects privileged %s (RouterOS silently leaves it unprivileged)", (_label, fragment) => {
      expect(validate(serviceWith(fragment))).toBe(false);
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

  // Formats differ by validator: CI uses ajv-formats, tikapp.html uses Ajv 6.12.6's built-in
  // ipv4/ipv6 (which accepts leading-zero octets), and some editors skip formats entirely.
  // The pattern alone must still reject every form RouterOS was seen to drop.
  for (const [mode, validateFormats] of [["with formats", true], ["without formats", false]] as const) {
    test.each(dnsIgnored)(`rejects dns %s (${mode})`, (_label, fragment) => {
      const ajv = new Ajv({ allErrors: true, strict: false, validateFormats });
      if (validateFormats) addFormats(ajv);
      expect(ajv.compile(schemas.strict)(serviceWith(fragment))).toBe(false);
    });
  }

  // Not CHR-tested. Malformed colon strings get past the pattern and are rejected only by the
  // ipv6 format, which both CI (ajv-formats) and tikapp.html (Ajv 6 built-in) apply.
  test.each(["::::", "1:2:3:4:5:6:7:8:9", "8.8.8.8:"])("rejects malformed IPv6 dns %p (with formats)", (dns) => {
    expect(validatorFor(schemas.strict)(serviceWith(`dns: '${dns}'`))).toBe(false);
  });
});

describe("routeros-app-yaml-schema (editor only)", () => {
  // The editor schema keeps dns loose so autocompletion is not blocked; its description warns instead
  test.each(dnsIgnored)("accepts dns %s", (_label, fragment) => {
    expect(validatorFor(schemas.editor)(serviceWith(fragment))).toBe(true);
  });
});

// Published per-version schemas from the current long-term on were backfilled with dns and
// privileged. appyamlvalidate.js leaves privileged out below 7.25 (7.24.7 ignores it on CHR).
describe("published per-version schemas (backfilled to long-term)", () => {
  const serviceKeys = async (version: string) => {
    const s = await Bun.file(join(repoRoot, "docs", version, "routeros-app-yaml-schema.json")).json();
    return Object.keys(s.properties.services.patternProperties["^[a-zA-Z0-9_-]+$"].properties);
  };

  test.each(["7.24", "7.24.5", "7.24.7"])("%s has dns but not privileged", async (version) => {
    const keys = await serviceKeys(version);
    expect(keys).toContain("dns");
    expect(keys).not.toContain("privileged");
  });

  test.each(["7.25", "7.25.2", "7.26beta7"])("%s has dns and privileged", async (version) => {
    const keys = await serviceKeys(version);
    expect(keys).toContain("dns");
    expect(keys).toContain("privileged");
  });
});
