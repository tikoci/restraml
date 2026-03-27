import { describe, test, expect } from "bun:test";
import {
  filterCompletions,
  completionsToObject,
  generateOpenAPI,
  CRASH_PATHS,
  type InspectNode,
  type DeepInspectOutput,
  type OpenAPIRef,
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
    expect(openapi.servers).toHaveLength(2);
    expect(openapi.servers[0].url).toContain("https");
    expect(openapi.servers[0].variables?.host.default).toBe("192.168.88.1");
    expect(openapi.servers[1].url).toContain("http");
    expect(openapi.servers[1].variables?.port.default).toBe("80");
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
    expect(getOp?.operationId).toBe("get_ip_address");
    expect(getOp?.tags).toEqual(["ip"]);
    expect(getOp?.parameters?.length).toBeGreaterThan(0);
    const addressParam = getOp?.parameters?.find((p) => "name" in p && p.name === "address");
    expect(addressParam).toBeDefined();
    expect(addressParam && "in" in addressParam && addressParam.in).toBe("query");
  });

  test("PUT /ip/address for add command", () => {
    const putOp = openapi.paths["/ip/address"]?.put;
    expect(putOp).toBeDefined();
    expect(putOp?.operationId).toBe("put_ip_address");
    expect(putOp?.tags).toEqual(["ip"]);
    // requestBody uses allOf with command properties + $ref to QueryOptions
    const schema = putOp?.requestBody?.content["application/json"]?.schema;
    expect(schema?.allOf).toBeDefined();
    const propsSchema = schema?.allOf?.find((s) => "properties" in s);
    expect(propsSchema && "properties" in propsSchema && propsSchema.properties?.address).toBeDefined();
  });

  test("PATCH /ip/address/{id} uses $ref for id parameter", () => {
    const patchOp = openapi.paths["/ip/address/{id}"]?.patch;
    expect(patchOp).toBeDefined();
    expect(patchOp?.operationId).toBe("patch_ip_address_id");
    const idRef = patchOp?.parameters?.[0] as OpenAPIRef;
    expect(idRef.$ref).toBe("#/components/parameters/itemId");
  });

  test("DELETE /ip/address/{id} uses $ref for id parameter", () => {
    const deleteOp = openapi.paths["/ip/address/{id}"]?.delete;
    expect(deleteOp).toBeDefined();
    expect(deleteOp?.operationId).toBe("delete_ip_address_id");
    const idRef = deleteOp?.parameters?.[0] as OpenAPIRef;
    expect(idRef.$ref).toBe("#/components/parameters/itemId");
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
    const protocolParam = getOp?.parameters?.find((p) => "name" in p && p.name === "protocol");
    expect(protocolParam && "schema" in protocolParam && protocolParam.schema.enum).toEqual(["tcp", "udp", "icmp"]);
  });

  test("components/parameters/itemId has pattern for RouterOS identifiers", () => {
    expect(openapi.components.parameters?.itemId).toBeDefined();
    const itemId = openapi.components.parameters?.itemId;
    expect(itemId?.name).toBe("id");
    expect(itemId?.in).toBe("path");
    expect(itemId?.required).toBe(true);
    expect(itemId?.schema.pattern).toBe("^\\*[0-9A-Fa-f]+$");
  });

  test("components/responses has error responses", () => {
    expect(openapi.components.responses?.BadRequest).toBeDefined();
    expect(openapi.components.responses?.Unauthorized).toBeDefined();
    expect(openapi.components.responses?.NotFound).toBeDefined();
    expect(openapi.components.responses?.NotAcceptable).toBeDefined();
  });

  test("components/schemas has shared schemas", () => {
    expect(openapi.components.schemas?.RouterOSItem).toBeDefined();
    expect(openapi.components.schemas?.RouterOSItemList).toBeDefined();
    expect(openapi.components.schemas?.QueryOptions).toBeDefined();
    expect(openapi.components.schemas?.ProplistParam).toBeDefined();
    const qo = openapi.components.schemas?.QueryOptions;
    expect(qo?.properties?.[".proplist"]).toBeDefined();
    expect(qo?.properties?.[".query"]).toBeDefined();
  });

  test("ProplistParam uses oneOf for string and array", () => {
    const pl = openapi.components.schemas?.ProplistParam;
    expect(pl?.oneOf).toHaveLength(2);
    expect(pl?.oneOf?.[0]).toEqual({ type: "string" });
    expect(pl?.oneOf?.[1]).toEqual({ type: "array", items: { type: "string" } });
  });

  test("GET operations include .proplist query parameter", () => {
    const getOp = openapi.paths["/ip/address"]?.get;
    const proplistParam = getOp?.parameters?.find((p) => "name" in p && p.name === ".proplist");
    expect(proplistParam).toBeDefined();
    expect(proplistParam && "in" in proplistParam && proplistParam.in).toBe("query");
  });

  test("GET response includes .id and arg properties", () => {
    const getOp = openapi.paths["/ip/address"]?.get;
    const responseSchema = getOp?.responses["200"];
    expect(responseSchema && "content" in responseSchema).toBe(true);
    const schema = responseSchema && "content" in responseSchema
      ? responseSchema.content?.["application/json"]?.schema : undefined;
    // List response is array of objects with properties
    expect(schema && "items" in schema && schema.items).toBeDefined();
    const itemSchema = schema && "items" in schema ? schema.items : undefined;
    expect(itemSchema && "properties" in itemSchema && itemSchema.properties?.[".id"]).toBeDefined();
    expect(itemSchema && "properties" in itemSchema && itemSchema.properties?.address).toBeDefined();
  });

  test("single-item GET at {id} has .proplist param and rich response", () => {
    const getOp = openapi.paths["/ip/address/{id}"]?.get;
    expect(getOp).toBeDefined();
    // Has both itemId ref and .proplist query param
    expect(getOp?.parameters).toHaveLength(2);
    const proplistParam = getOp?.parameters?.find((p) => "name" in p && p.name === ".proplist");
    expect(proplistParam).toBeDefined();
    // Response has object with properties
    const resp200 = getOp?.responses["200"];
    expect(resp200 && "content" in resp200).toBe(true);
    const schema = resp200 && "content" in resp200 ? resp200.content?.["application/json"]?.schema : undefined;
    expect(schema && "properties" in schema && schema.properties?.[".id"]).toBeDefined();
  });

  test("{id} operations include 404 response", () => {
    const patchOp = openapi.paths["/ip/address/{id}"]?.patch;
    expect(patchOp?.responses["404"]).toBeDefined();
    const deleteOp = openapi.paths["/ip/address/{id}"]?.delete;
    expect(deleteOp?.responses["404"]).toBeDefined();
    const getIdOp = openapi.paths["/ip/address/{id}"]?.get;
    expect(getIdOp?.responses["404"]).toBeDefined();
  });

  test("all operations include 406 response", () => {
    const getOp = openapi.paths["/ip/address"]?.get;
    expect(getOp?.responses["406"]).toBeDefined();
    const putOp = openapi.paths["/ip/address"]?.put;
    expect(putOp?.responses["406"]).toBeDefined();
  });

  test("integer range desc produces type integer with min/max", () => {
    const enriched: InspectNode = {
      test: {
        _type: "dir",
        get: {
          _type: "cmd",
          mtu: { _type: "arg", desc: "0..4294967295" },
        },
      },
    };
    const oapi = generateOpenAPI(enriched, "7.22");
    const mtuParam = oapi.paths["/test"]?.get?.parameters?.find((p) => "name" in p && p.name === "mtu");
    expect(mtuParam && "schema" in mtuParam && mtuParam.schema.type).toBe("integer");
    expect(mtuParam && "schema" in mtuParam && mtuParam.schema.minimum).toBe(0);
    expect(mtuParam && "schema" in mtuParam && mtuParam.schema.maximum).toBe(4294967295);
  });

  test("IP address desc produces format ipv4", () => {
    const enriched: InspectNode = {
      test: {
        _type: "dir",
        get: {
          _type: "cmd",
          address: { _type: "arg", desc: "A.B.C.D    (IP address)" },
        },
      },
    };
    const oapi = generateOpenAPI(enriched, "7.22");
    const param = oapi.paths["/test"]?.get?.parameters?.find((p) => "name" in p && p.name === "address");
    expect(param && "schema" in param && param.schema.type).toBe("string");
    expect(param && "schema" in param && param.schema.format).toBe("ipv4");
  });

  test("time interval desc stays type string", () => {
    const enriched: InspectNode = {
      test: {
        _type: "dir",
        get: {
          _type: "cmd",
          timeout: { _type: "arg", desc: "0s..1w    (time interval)" },
        },
      },
    };
    const oapi = generateOpenAPI(enriched, "7.22");
    const param = oapi.paths["/test"]?.get?.parameters?.find((p) => "name" in p && p.name === "timeout");
    expect(param && "schema" in param && param.schema.type).toBe("string");
    expect(param && "schema" in param && param.schema.format).toBeUndefined();
  });

  test("string value with length constraints sets maxLength", () => {
    const enriched: InspectNode = {
      test: {
        _type: "dir",
        get: {
          _type: "cmd",
          name: { _type: "arg", desc: "string value, max length 255" },
        },
      },
    };
    const oapi = generateOpenAPI(enriched, "7.22");
    const param = oapi.paths["/test"]?.get?.parameters?.find((p) => "name" in p && p.name === "name");
    expect(param && "schema" in param && param.schema.type).toBe("string");
    expect(param && "schema" in param && param.schema.maxLength).toBe(255);
  });

  test("IPv6 prefix desc produces format ipv6", () => {
    const enriched: InspectNode = {
      test: {
        _type: "dir",
        get: {
          _type: "cmd",
          prefix: { _type: "arg", desc: "IPv6/0..128    (IPv6 prefix)" },
        },
      },
    };
    const oapi = generateOpenAPI(enriched, "7.22");
    const param = oapi.paths["/test"]?.get?.parameters?.find((p) => "name" in p && p.name === "prefix");
    expect(param && "schema" in param && param.schema.type).toBe("string");
    expect(param && "schema" in param && param.schema.format).toBe("ipv6");
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
