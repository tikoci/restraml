import { describe, test, expect } from "bun:test";
import {
  filterCompletions,
  completionsToObject,
  generateOpenAPI,
  CRASH_PATHS,
  type InspectNode,
  type DeepInspectOutput,
} from "./deep-inspect";

// ── Test Fixtures ──────────────────────────────────────────────────────────

const sampleInspect: InspectNode = JSON.parse(
  await Bun.file("fixtures/sample-inspect.json").text(),
);

// ── filterCompletions ──────────────────────────────────────────────────────

describe("filterCompletions", () => {
  test("keeps entries with show=true", () => {
    const result = filterCompletions([
      { completion: "tcp", show: true, style: "none" },
      { completion: "udp", show: true, style: "none" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].completion).toBe("tcp");
  });

  test("keeps entries with show='yes'", () => {
    const result = filterCompletions([
      { completion: "base64", show: "yes", style: "none", preference: 96 },
    ]);
    expect(result).toHaveLength(1);
  });

  test("filters out show=false", () => {
    const result = filterCompletions([
      { completion: "hidden", show: false, style: "none" },
      { completion: "visible", show: true, style: "none" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].completion).toBe("visible");
  });

  test("filters out show='no'", () => {
    const result = filterCompletions([
      { completion: "hidden", show: "no", style: "none" },
    ]);
    expect(result).toHaveLength(0);
  });

  test("handles empty array", () => {
    expect(filterCompletions([])).toHaveLength(0);
  });

  test("handles mixed show values", () => {
    const result = filterCompletions([
      { completion: "a", show: true, style: "none" },
      { completion: "b", show: false, style: "none" },
      { completion: "c", show: "yes", style: "none" },
      { completion: "d", show: "no", style: "none" },
      { completion: "e", show: true, style: "none", preference: 50 },
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.completion)).toEqual(["a", "c", "e"]);
  });
});

// ── completionsToObject ────────────────────────────────────────────────────

describe("completionsToObject", () => {
  test("converts completion list to keyed object", () => {
    const result = completionsToObject([
      { completion: "tcp", show: true, style: "none", preference: 80 },
      { completion: "udp", show: true, style: "none", preference: 60, desc: "User Datagram Protocol" },
    ]);
    expect(result).toEqual({
      tcp: { style: "none", preference: 80 },
      udp: { style: "none", preference: 60, desc: "User Datagram Protocol" },
    });
  });

  test("omits undefined preference", () => {
    const result = completionsToObject([
      { completion: "base64", show: true, style: "none" },
    ]);
    expect(result.base64).toEqual({ style: "none" });
    expect("preference" in result.base64).toBe(false);
  });

  test("handles empty desc", () => {
    const result = completionsToObject([
      { completion: "test", show: true, style: "none", desc: "" },
    ]);
    // Empty string is falsy, so desc should be omitted
    expect("desc" in result.test).toBe(false);
  });

  test("handles empty input", () => {
    expect(completionsToObject([])).toEqual({});
  });
});

// ── CRASH_PATHS constant ──────────────────────────────────────────────────

describe("CRASH_PATHS", () => {
  test("contains the known crash paths", () => {
    expect(CRASH_PATHS).toContain("where");
    expect(CRASH_PATHS).toContain("do");
    expect(CRASH_PATHS).toContain("else");
    expect(CRASH_PATHS).toContain("rule");
    expect(CRASH_PATHS).toContain("command");
    expect(CRASH_PATHS).toContain("on-error");
  });

  test("has exactly 6 entries", () => {
    expect(CRASH_PATHS).toHaveLength(6);
  });
});

// ── Tree Structure ─────────────────────────────────────────────────────────

describe("sample inspect.json structure", () => {
  test("has expected top-level keys", () => {
    const keys = Object.keys(sampleInspect);
    expect(keys).toContain("convert");
    expect(keys).toContain("certificate");
    expect(keys).toContain("ip");
    expect(keys).toContain("interface");
    expect(keys).toContain("system");
  });

  test("convert is a cmd with args", () => {
    const convert = sampleInspect.convert as InspectNode;
    expect(convert._type).toBe("cmd");
    const from = convert.from as InspectNode;
    expect(from._type).toBe("arg");
    expect(from.desc).toBe("value to convert from");
  });

  test("ip is a path with nested dirs", () => {
    const ip = sampleInspect.ip as InspectNode;
    expect(ip._type).toBe("path");
    const address = ip.address as InspectNode;
    expect(address._type).toBe("dir");
  });

  test("fixture contains CRASH_PATH examples (where, do)", () => {
    const filter = (sampleInspect.ip as InspectNode).firewall as InspectNode;
    const filterDir = filter.filter as InspectNode;
    const add = filterDir.add as InspectNode;
    expect((add.where as InspectNode)._type).toBe("arg");
    expect((add.do as InspectNode)._type).toBe("arg");
  });
});

// ── OpenAPI Generation ─────────────────────────────────────────────────────

describe("generateOpenAPI", () => {
  const openapi = generateOpenAPI(sampleInspect, "7.22");

  test("has correct OpenAPI version", () => {
    expect(openapi.openapi).toBe("3.0.3");
  });

  test("has correct info block", () => {
    expect(openapi.info.version).toBe("7.22");
    expect(openapi.info.title).toContain("RouterOS");
  });

  test("has server with variables", () => {
    expect(openapi.servers).toHaveLength(1);
    expect(openapi.servers[0].variables?.host.default).toBe("192.168.88.1");
  });

  test("has basicAuth security scheme", () => {
    expect(openapi.components.securitySchemes.basicAuth).toBeDefined();
  });

  test("generates paths for cmd nodes", () => {
    const paths = Object.keys(openapi.paths);
    // ip/address has get, set, add, remove commands
    expect(paths).toContain("/ip/address");
    expect(paths).toContain("/ip/address/{id}");
  });

  test("GET /ip/address has parameters", () => {
    const getOp = openapi.paths["/ip/address"]?.get;
    expect(getOp).toBeDefined();
    expect(getOp?.parameters?.length).toBeGreaterThan(0);
    const addressParam = getOp?.parameters?.find((p) => p.name === "address");
    expect(addressParam).toBeDefined();
    expect(addressParam?.in).toBe("query");
  });

  test("PUT /ip/address for add command", () => {
    const putOp = openapi.paths["/ip/address"]?.put;
    expect(putOp).toBeDefined();
    expect(putOp?.requestBody?.content["application/json"]?.schema.properties?.address).toBeDefined();
  });

  test("PATCH /ip/address/{id} for set command", () => {
    const patchOp = openapi.paths["/ip/address/{id}"]?.patch;
    expect(patchOp).toBeDefined();
  });

  test("DELETE /ip/address/{id} for remove command", () => {
    const deleteOp = openapi.paths["/ip/address/{id}"]?.delete;
    expect(deleteOp).toBeDefined();
  });

  test("nested paths are generated", () => {
    const paths = Object.keys(openapi.paths);
    // certificate/crl should produce paths
    expect(paths.some((p) => p.includes("/certificate/crl"))).toBe(true);
    // ip/firewall/filter should too
    expect(paths.some((p) => p.includes("/ip/firewall/filter"))).toBe(true);
  });

  test("completion data produces enum in schema", () => {
    // Enrich a node with _completion, then generate
    const enriched: InspectNode = {
      test: {
        _type: "dir",
        get: {
          _type: "cmd",
          protocol: {
            _type: "arg",
            desc: "protocol name",
            _completion: {
              tcp: { style: "none" },
              udp: { style: "none" },
              icmp: { style: "none" },
            },
          },
        },
      },
    };
    const oapi = generateOpenAPI(enriched, "7.22");
    const getOp = oapi.paths["/test"]?.get;
    expect(getOp).toBeDefined();
    const protocolParam = getOp?.parameters?.find((p) => p.name === "protocol");
    expect(protocolParam?.schema.enum).toEqual(["tcp", "udp", "icmp"]);
  });
});

// ── deep-inspect.json Output Shape ─────────────────────────────────────────

describe("deep-inspect.json output structure", () => {
  test("_meta has required fields", () => {
    const meta = {
      version: "7.22",
      generatedAt: new Date().toISOString(),
      crashPathsTested: [],
      crashPathsSafe: [],
      crashPathsCrashed: [],
      completionStats: { argsTotal: 100, argsWithCompletion: 50, argsFailed: 2 },
    };

    const output: DeepInspectOutput = { _meta: meta, ...sampleInspect };

    expect(output._meta.version).toBe("7.22");
    expect(output._meta.generatedAt).toBeDefined();
    expect(output._meta.completionStats.argsTotal).toBe(100);
    // Tree data is preserved alongside _meta
    expect((output.convert as InspectNode)._type).toBe("cmd");
  });
});
