/**
 * deep-inspect.ts — Enhanced RouterOS schema generation
 *
 * Takes an existing inspect.json (from rest2raml.js) and enriches it with
 * completion data from the RouterOS REST API. Outputs deep-inspect.json
 * (superset of inspect.json) and openapi.json (OpenAPI 3.0).
 *
 * Usage:
 *   bun deep-inspect.ts --inspect-file docs/7.22/inspect.json
 *   URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun deep-inspect.ts --inspect-file docs/7.22/inspect.json
 *   URLBASE=http://localhost:9180/rest BASICAUTH=admin: bun deep-inspect.ts --live
 */

import { parseArgs } from "util";
import { RosAPI, type RosError } from "./ros-api-protocol";

// ── Types ──────────────────────────────────────────────────────────────────

/** A node in the inspect tree (as produced by rest2raml.js / /console/inspect) */
export interface InspectNode {
  _type?: "cmd" | "arg" | "dir" | "path";
  desc?: string;
  _completion?: Record<string, CompletionEntry>;
  [key: string]: InspectNode | string | undefined | Record<string, CompletionEntry>;
}

export interface CompletionEntry {
  style: string;
  preference?: number;
  desc?: string;
}

export interface DeepInspectMeta {
  version: string;
  generatedAt: string;
  architecture?: string;
  apiTransport?: string;
  enrichmentDurationMs?: number;
  crashPathsTested: string[];
  crashPathsSafe: string[];
  crashPathsCrashed: string[];
  completionStats: {
    argsTotal: number;
    argsWithCompletion: number;
    argsFailed: number;
  };
  mergeStats?: {
    x86OnlyNodes: number;
    arm64OnlyNodes: number;
    sharedNodes: number;
  };
}

export interface DeepInspectOutput {
  _meta: DeepInspectMeta;
  [key: string]: InspectNode | DeepInspectMeta | string | undefined | Record<string, CompletionEntry>;
}

/** Raw response item from /console/inspect with request=child */
interface InspectChildResponse {
  type: string;
  name: string;
  "node-type": string;
}

/** Raw response item from /console/inspect with request=syntax */
interface InspectSyntaxResponse {
  text: string;
}

/** Raw response item from /console/inspect with request=completion */
interface InspectCompletionResponse {
  completion: string;
  show: boolean | string;
  style?: string;
  /** RouterOS REST API returns preference as a string (e.g. "80"), not a number */
  preference?: number | string;
  /** RouterOS REST API uses "text" for the description field; "desc" is the normalized form */
  text?: string;
  desc?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** RouterOS scripting keyword paths that may crash the REST server.
 *
 *  Investigation against live routers (April 2026) found:
 *  - RouterOS 7.20.8 (long-term): `POST /rest/console/inspect {"request":"syntax","path":"do"}`
 *    hangs the entire HTTP server for ~30 seconds with no response. The same hang occurs with
 *    `request=completion`. Only `"do"` causes the hang; the others (where, else, rule, command,
 *    on-error) are safe on 7.20.8 — they just return an empty array [] instantly.
 *    Crucially: since testCrashPaths probes sequentially, any path tested AFTER "do" appears
 *    to crash too (the server is already hung). This was the cause of false CI failures on 7.20.8.
 *  - RouterOS 7.22 and 7.23beta5: all paths return HTTP 200 immediately — the bug is fixed.
 *    (7.21 not tested; fix likely landed in 7.21 or 7.22 based on successful 7.22 builds.)
 *  - `"do"` with `request=child` is safe on all tested versions — returns its args immediately.
 *  - Nested paths (e.g. ["do","command"]) with any request type are safe on all versions.
 *
 *  These paths are skipped by crawlInspectTree (and rest2raml.js parseChildren) by default.
 *  testCrashPaths() probes them with fetchSyntax and waits for server recovery between probes.
 *
 *  MikroTik bug: /console/inspect with request=syntax or request=completion at bare path "do"
 *  deadlocks the REST scripting engine on RouterOS ≤7.21 (exact fix version unconfirmed).
 */
// ── Client interface ──────────────────────────────────────────────────────

export interface IRouterOSClient {
  fetchVersion(): Promise<string>;
  fetchChild(path: string[]): Promise<InspectChildResponse[]>;
  fetchSyntax(path: string[], signal?: AbortSignal): Promise<InspectSyntaxResponse[]>;
  fetchCompletion(path: string[], signal?: AbortSignal): Promise<InspectCompletionResponse[]>;
  close?(): void;
}

export const CRASH_PATHS = [
  "where",
  "do",
  "else",
  "rule",
  "command",
  "on-error",
] as const;

const CRASH_PATH_TIMEOUT_MS = 5_000;
const COMPLETION_TIMEOUT_MS = 5_000;

// ── RouterOS API Client ────────────────────────────────────────────────────

export class RouterOSClient implements IRouterOSClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(baseUrl: string, basicAuth: string) {
    this.baseUrl = baseUrl;
    this.authHeader = `Basic ${btoa(basicAuth)}`;
  }

  private async fetchPost<T>(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
    }
    return response.json() as Promise<T>;
  }

  async fetchVersion(): Promise<string> {
    const resp = await this.fetchPost<{ ret: string }>(
      `${this.baseUrl}/system/resource/get`,
      { "value-name": "version" },
    );
    return resp.ret.split(" ")[0];
  }

  async fetchChild(path: string[]): Promise<InspectChildResponse[]> {
    return this.fetchPost<InspectChildResponse[]>(
      `${this.baseUrl}/console/inspect`,
      { request: "child", path: path.join(",") },
    );
  }

  async fetchSyntax(path: string[], signal?: AbortSignal): Promise<InspectSyntaxResponse[]> {
    return this.fetchPost<InspectSyntaxResponse[]>(
      `${this.baseUrl}/console/inspect`,
      { request: "syntax", path: path.join(",") },
      signal,
    );
  }

  async fetchCompletion(path: string[], signal?: AbortSignal): Promise<InspectCompletionResponse[]> {
    return this.fetchPost<InspectCompletionResponse[]>(
      `${this.baseUrl}/console/inspect`,
      { request: "completion", path: path.join(",") },
      signal,
    );
  }
}

// ── Abort signal helper ───────────────────────────────────────────────────

/** Race a promise against an AbortSignal. If signal is absent or never fires,
 *  the original promise is returned unmodified (zero overhead). */
function withAbortSignal<T>(signal: AbortSignal | undefined, promise: Promise<T>): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }),
  ]);
}

// ── Native API Client ─────────────────────────────────────────────────────

/** RouterOS native API (port 8728/8729) client implementing IRouterOSClient.
 *  Uses `/console/inspect` via the wire protocol for each operation.
 *  All values from the native API are strings — normalization happens downstream
 *  in completionsToObject() exactly as it does for the REST client.
 */
export class NativeRouterOSClient implements IRouterOSClient {
  private api: RosAPI;

  constructor(host: string, port: number, user: string, password: string) {
    this.api = new RosAPI(host, port, user, password);
  }

  async connect(): Promise<void> {
    await this.api.connect();
  }

  close(): void {
    this.api.close();
  }

  async fetchVersion(): Promise<string> {
    const sentences = await this.api.write("/system/resource/print");
    const version = sentences[0]?.data.version;
    if (!version) throw new Error("Could not read RouterOS version from native API");
    return version.split(" ")[0];
  }

  async fetchChild(path: string[]): Promise<InspectChildResponse[]> {
    const sentences = await this.api.write(
      "/console/inspect",
      "=request=child",
      `=path=${path.join(",")}`,
    );
    return sentences.map((s) => s.data as unknown as InspectChildResponse);
  }

  async fetchSyntax(path: string[], signal?: AbortSignal): Promise<InspectSyntaxResponse[]> {
    const sentences = await withAbortSignal(
      signal,
      this.api.write("/console/inspect", "=request=syntax", `=path=${path.join(",")}`),
    );
    return sentences.map((s) => s.data as unknown as InspectSyntaxResponse);
  }

  async fetchCompletion(path: string[], signal?: AbortSignal): Promise<InspectCompletionResponse[]> {
    const sentences = await withAbortSignal(
      signal,
      this.api.write("/console/inspect", "=request=completion", `=path=${path.join(",")}`),
    );
    // Native API returns strings for all fields. completionsToObject() normalises:
    // show (string "true"/"false"), preference (string→number), text→desc fallback.
    return sentences.map((s) => s.data as unknown as InspectCompletionResponse);
  }
}

// ── Completion Enrichment ──────────────────────────────────────────────────

/** Filter completion responses to only those that should be shown */
export function filterCompletions(completions: InspectCompletionResponse[]): InspectCompletionResponse[] {
  return completions.filter(
    (c) => c.show === true || c.show === "true" || c.show === "yes",
  );
}

/** Convert filtered completion responses to the _completion object format.
 *  Normalizes API inconsistencies at the boundary:
 *  - preference: REST API returns a string (e.g. "80"); convert to number
 *  - desc: REST API uses the field name "text"; fall back to "text" if "desc" is absent
 */
export function completionsToObject(completions: InspectCompletionResponse[]): Record<string, CompletionEntry> {
  const result: Record<string, CompletionEntry> = {};
  for (const c of completions) {
    const entry: CompletionEntry = { style: c.style || "none" };
    if (c.preference !== undefined) {
      entry.preference = typeof c.preference === "string" ? Number(c.preference) : c.preference;
    }
    const description = c.desc || c.text;
    if (description) entry.desc = description;
    result[c.completion] = entry;
  }
  return result;
}

/** Collect all arg nodes with their paths from the inspect tree */
function collectArgNodes(tree: InspectNode, path: string[] = []): Array<{ node: InspectNode; path: string[] }> {
  const result: Array<{ node: InspectNode; path: string[] }> = [];
  for (const [key, value] of Object.entries(tree)) {
    if (key.startsWith("_") || typeof value !== "object" || value === null) continue;
    const node = value as InspectNode;
    const currentPath = [...path, key];
    if (node._type === "arg") result.push({ node, path: currentPath });
    result.push(...collectArgNodes(node, currentPath));
  }
  return result;
}

/** Default batch size for multiplexed enrichment.
 *  Native API supports tag-multiplexed concurrent commands on one connection.
 *  REST uses HTTP keep-alive but processes sequentially. Batching still helps
 *  native API significantly (~5-14x vs sequential) while being harmless for REST. */
const ENRICHMENT_BATCH_SIZE = 50;

/** Walk the inspect tree and fetch completions for all arg nodes.
 *  Uses batched concurrency: up to ENRICHMENT_BATCH_SIZE calls in flight at once,
 *  leveraging native API tag multiplexing when available. */
export async function enrichWithCompletions(
  tree: InspectNode,
  client: IRouterOSClient,
  path: string[] = [],
  stats = { argsTotal: 0, argsWithCompletion: 0, argsFailed: 0 },
): Promise<typeof stats> {
  const args = collectArgNodes(tree, path);
  stats.argsTotal = args.length;

  for (let i = 0; i < args.length; i += ENRICHMENT_BATCH_SIZE) {
    const batch = args.slice(i, i + ENRICHMENT_BATCH_SIZE);
    await Promise.all(batch.map(async ({ node, path: argPath }) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), COMPLETION_TIMEOUT_MS);
        const completions = await client.fetchCompletion(argPath, controller.signal);
        clearTimeout(timeout);

        const shown = filterCompletions(completions);
        if (shown.length > 0) {
          node._completion = completionsToObject(shown);
          stats.argsWithCompletion++;
        }
      } catch {
        stats.argsFailed++;
      }
    }));
  }
  return stats;
}

// ── CRASH_PATHS Testing ────────────────────────────────────────────────────

export interface CrashPathResult {
  path: string;
  safe: boolean;
  error?: string;
}

/** Wait for the REST server to recover (e.g. after a crash path probe).
 *  Uses /system/resource/get (not /console/inspect which may still be hung).
 *  Tries up to maxAttempts times with delays between attempts. */
async function waitForServerRecovery(client: IRouterOSClient, maxAttempts = 8): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.fetchVersion();
      return true;
    } catch {
      // Server still recovering — wait with increasing delay (3s each)
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    }
  }
  return false;
}

/** Test each CRASH_PATH to see if it still crashes the router.
 *  Includes a health check between probes so that a crash from one path
 *  doesn't cause all subsequent paths to be falsely reported as crashed. */
export async function testCrashPaths(client: IRouterOSClient): Promise<CrashPathResult[]> {
  const results: CrashPathResult[] = [];

  for (const crashPath of CRASH_PATHS) {
    // Health check: ensure server is responsive before probing the next path
    if (results.length > 0 && results[results.length - 1].safe === false) {
      console.log(`  ⏳ Waiting for server recovery after "${results[results.length - 1].path}"...`);
      const recovered = await waitForServerRecovery(client);
      if (!recovered) {
        // Server is still down — mark remaining paths as unknown/skipped
        results.push({ path: crashPath, safe: false, error: "server unresponsive (previous path crashed it)" });
        console.log(`  ⚠ "${crashPath}" skipped — server still unresponsive`);
        continue;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CRASH_PATH_TIMEOUT_MS);

    try {
      await client.fetchSyntax([crashPath], controller.signal);
      results.push({ path: crashPath, safe: true });
      console.log(`  ✓ "${crashPath}" is safe`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ path: crashPath, safe: false, error: message });
      console.log(`  ✗ "${crashPath}" still crashes/times out: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return results;
}

// ── Full Crawl (--live mode) ───────────────────────────────────────────────

/** Crawl the inspect tree from scratch via the live router (mirrors rest2raml.js parseChildren) */
export async function crawlInspectTree(
  client: IRouterOSClient,
  rpath: string[] = [],
  skipPaths: Set<string> = new Set(CRASH_PATHS as unknown as string[]),
): Promise<InspectNode> {
  const memo: InspectNode = {};
  const children = await client.fetchChild(rpath);

  for (const child of children) {
    if (child.type !== "child") continue;
    const newpath = [...rpath, child.name];
    const node: InspectNode = { _type: child["node-type"] as InspectNode["_type"] };
    memo[child.name] = node;

    if (child["node-type"] === "arg") {
      // Check if any segment of the path is in the skip set
      const shouldSkip = newpath.some((segment) => skipPaths.has(segment));
      if (!shouldSkip) {
        try {
          const syntax = await client.fetchSyntax(newpath);
          if (syntax.length === 1 && syntax[0].text.length > 0) {
            node.desc = syntax[0].text;
          }
        } catch {
          // Syntax fetch failed — skip desc
        }
      }
    }

    const childTree = await crawlInspectTree(client, newpath, skipPaths);
    Object.assign(node, childTree);
  }

  return memo;
}

// ── OpenAPI 3.0 Generation ─────────────────────────────────────────────────

interface OpenAPISchema {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description: string; variables?: Record<string, { default: string; description: string }> }>;
  paths: Record<string, OpenAPIPathItem>;
  components: {
    securitySchemes: Record<string, unknown>;
    parameters?: Record<string, OpenAPIParameter>;
    responses?: Record<string, OpenAPIResponseObject>;
    schemas?: Record<string, OpenAPISchemaObject>;
  };
  security: Array<Record<string, string[]>>;
}

interface OpenAPIPathItem {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  patch?: OpenAPIOperation;
  delete?: OpenAPIOperation;
}

export type OpenAPIRef = { $ref: string };

interface OpenAPIResponseObject {
  description: string;
  content?: Record<string, { schema: OpenAPISchemaObject | OpenAPIRef }>;
}

interface OpenAPIOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Array<OpenAPIParameter | OpenAPIRef>;
  requestBody?: {
    content: { "application/json": { schema: OpenAPISchemaObject } };
  };
  responses: Record<string, OpenAPIResponseObject | OpenAPIRef>;
}

interface OpenAPIParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema: OpenAPISchemaObject;
}

interface OpenAPISchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, OpenAPISchemaObject | OpenAPIRef>;
  items?: OpenAPISchemaObject | OpenAPIRef;
  allOf?: Array<OpenAPISchemaObject | OpenAPIRef>;
  oneOf?: Array<OpenAPISchemaObject | OpenAPIRef>;
  enum?: string[];
  description?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  $ref?: string;
}

/** Generate OpenAPI 3.0 schema from the enriched inspect tree */
export function generateOpenAPI(tree: InspectNode, version: string): OpenAPISchema {
  const paths: Record<string, OpenAPIPathItem> = {};

  function walkTree(node: InspectNode, restPath: string) {
    // Collect args and cmds at this level
    const args: Array<[string, InspectNode]> = [];
    const cmds: Array<[string, InspectNode]> = [];
    const childDirs: Array<[string, InspectNode]> = [];

    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("_") || typeof value !== "object" || value === null) continue;
      const child = value as InspectNode;
      if (child._type === "arg") args.push([key, child]);
      else if (child._type === "cmd") cmds.push([key, child]);
      else if (child._type === "dir" || child._type === "path") childDirs.push([key, child]);
    }

    // Process cmd nodes → REST endpoints
    for (const [cmdName, cmdNode] of cmds) {
      const cmdArgs = collectArgs(cmdNode);

      const tag = restPath.split("/").filter(Boolean)[0] || "root";

      if (cmdName === "get") {
        // Build response properties from get args
        const responseProperties: Record<string, OpenAPISchemaObject> = {
          ".id": { type: "string", description: "Item identifier" },
        };
        for (const [name, arg] of cmdArgs) {
          responseProperties[name] = argToSchema(arg);
        }
        const itemSchema: OpenAPISchemaObject = { type: "object", properties: responseProperties };

        // GET /path → list, GET /path/{id} → single item
        ensurePath(paths, restPath);
        paths[restPath].get = {
          ...makeGetOperation(cmdArgs),
          operationId: makeOperationId("get", restPath),
          tags: [tag],
        };
        const idPath = `${restPath}/{id}`;
        ensurePath(paths, idPath);
        paths[idPath].get = {
          summary: "get",
          operationId: makeOperationId("get", idPath),
          tags: [tag],
          parameters: [
            { $ref: "#/components/parameters/itemId" },
            { name: ".proplist", in: "query", required: false, description: "Comma-separated list of properties to return", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Success",
              content: { "application/json": { schema: itemSchema } },
            },
            ...errorResponses(),
            ...notFoundResponse(),
          },
        };
      } else if (cmdName === "set") {
        const idPath = `${restPath}/{id}`;
        ensurePath(paths, idPath);
        paths[idPath].patch = {
          ...makeBodyOperation("set", cmdArgs),
          operationId: makeOperationId("patch", idPath),
          tags: [tag],
          parameters: [{ $ref: "#/components/parameters/itemId" }],
        };
      } else if (cmdName === "add") {
        ensurePath(paths, restPath);
        paths[restPath].put = {
          ...makeBodyOperation("add", cmdArgs),
          operationId: makeOperationId("put", restPath),
          tags: [tag],
        };
      } else if (cmdName === "remove") {
        const idPath = `${restPath}/{id}`;
        ensurePath(paths, idPath);
        paths[idPath].delete = {
          summary: "remove",
          operationId: makeOperationId("delete", idPath),
          tags: [tag],
          parameters: [{ $ref: "#/components/parameters/itemId" }],
          responses: {
            "204": { description: "No Content — item deleted successfully" },
            ...errorResponses(),
            ...notFoundResponse(),
          },
        };
      } else {
        // Other commands (print, export, etc.) → POST /path/{cmdName}
        const cmdPath = `${restPath}/${cmdName}`;
        ensurePath(paths, cmdPath);
        paths[cmdPath].post = {
          ...makeBodyOperation(cmdNode.desc || cmdName, cmdArgs),
          operationId: makeOperationId("post", cmdPath),
          tags: [tag],
        };
      }
    }

    // Recurse into child dirs/paths
    for (const [dirName, dirNode] of childDirs) {
      walkTree(dirNode, `${restPath}/${dirName}`);
    }
  }

  walkTree(tree, "");

  return {
    openapi: "3.0.3",
    info: {
      title: `RouterOS REST API v${version}`,
      version,
      description:
        "Auto-generated OpenAPI schema from RouterOS /console/inspect. " +
        "See https://tikoci.github.io/restraml for details.",
    },
    servers: [
      {
        url: "https://{host}:{port}/rest",
        description: "RouterOS device (HTTPS)",
        variables: {
          host: { default: "192.168.88.1", description: "RouterOS IP or hostname" },
          port: { default: "443", description: "HTTPS port" },
        },
      },
      {
        url: "http://{host}:{port}/rest",
        description: "RouterOS device (HTTP)",
        variables: {
          host: { default: "192.168.88.1", description: "RouterOS IP or hostname" },
          port: { default: "80", description: "HTTP port" },
        },
      },
    ],
    paths,
    components: {
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" },
      },
      parameters: {
        itemId: idPathParam(),
      },
      responses: {
        BadRequest: {
          description: "Bad command or error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        Unauthorized: { description: "Unauthorized" },
        NotFound: {
          description: "Item not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        NotAcceptable: {
          description: "Not Acceptable — no such command or directory",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            error: { type: "integer", description: "HTTP status code" },
            message: { type: "string", description: "Error message" },
            detail: { type: "string", description: "Detailed error description" },
          },
        },
        RouterOSItem: { type: "object" },
        RouterOSItemList: { type: "array", items: { $ref: "#/components/schemas/RouterOSItem" } },
        ProplistParam: {
          description: "Comma-separated property names, or an array of strings in POST bodies",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        QueryOptions: {
          type: "object",
          properties: {
            ".proplist": { $ref: "#/components/schemas/ProplistParam" },
            ".query": { type: "array", items: { type: "string" }, description: "Query filter" },
          },
        },
      },
    },
    security: [{ basicAuth: [] }],
  };
}

function idPathParam(): OpenAPIParameter {
  return { name: "id", in: "path", required: true, schema: { type: "string" }, description: "RouterOS item identifier (*hex) or name (e.g. *1, ether1)" };
}

function makeOperationId(method: string, path: string): string {
  const segments = path.split("/").filter(Boolean).map((s) => s.replace(/[{}]/g, ""));
  return `${method}_${segments.join("_") || "root"}`;
}

function ensurePath(paths: Record<string, OpenAPIPathItem>, path: string) {
  if (!paths[path]) paths[path] = {};
}

function collectArgs(node: InspectNode): Array<[string, InspectNode]> {
  return Object.entries(node).filter(
    ([k, v]) => !k.startsWith("_") && typeof v === "object" && v !== null && (v as InspectNode)._type === "arg",
  ) as Array<[string, InspectNode]>;
}

function parseDescType(desc: string): OpenAPISchemaObject {
  // Integer range: "0..4294967295" (pure digits, no time suffixes)
  const intRange = desc.match(/^(\d+)\.\.(\d+)$/);
  if (intRange) {
    const min = Number(intRange[1]);
    const max = Number(intRange[2]);
    if (max <= Number.MAX_SAFE_INTEGER) {
      return { type: "integer", minimum: min, maximum: max };
    }
    return { type: "integer" };
  }

  // Time interval (various range formats or bare "time interval")
  if (desc.includes("(time interval)") || desc === "time interval") {
    return { type: "string" };
  }

  // IP address: "A.B.C.D    (IP address)" or "none | A.B.C.D" / "unspecified | A.B.C.D"
  if (desc.includes("(IP address)")) {
    return { type: "string", format: "ipv4" };
  }

  // IP prefix: "A.B.C.D/M    (IP prefix)"
  if (desc.includes("(IP prefix)")) {
    return { type: "string" };
  }

  // IPv6 prefix
  if (desc.includes("(IPv6 prefix)") || desc.startsWith("IPv6")) {
    return { type: "string", format: "ipv6" };
  }

  // MAC address: "AB[:|-|.]CD..."
  if (desc.includes("(MAC address)")) {
    return { type: "string" };
  }

  // String with length constraints: "string value, max length N", "string value, min length N"
  const strLenMatch = desc.match(/^string value(?:,\s*min length (\d+))?(?:,\s*max length (\d+))?$/);
  if (strLenMatch) {
    const schema: OpenAPISchemaObject = { type: "string" };
    if (strLenMatch[1]) schema.minLength = Number(strLenMatch[1]);
    if (strLenMatch[2]) schema.maxLength = Number(strLenMatch[2]);
    return schema;
  }
  // Also handle "string value, min length N, max length M"
  const strMinMax = desc.match(/^string value,\s*min length (\d+),\s*max length (\d+)$/);
  if (strMinMax) {
    return { type: "string", minLength: Number(strMinMax[1]), maxLength: Number(strMinMax[2]) };
  }

  // Hexadecimal string: "hexadecimal string value[, max/min length N]"
  if (desc.startsWith("hexadecimal string value")) {
    return { type: "string" };
  }

  // Fallback
  return { type: "string" };
}

function argToSchema(arg: InspectNode): OpenAPISchemaObject {
  const desc = arg.desc as string | undefined;
  const schema: OpenAPISchemaObject = desc ? parseDescType(desc) : { type: "string" };
  if (desc) schema.description = desc;
  if (arg._completion && Object.keys(arg._completion).length > 0) {
    schema.enum = Object.keys(arg._completion);
  }
  return schema;
}

function makeGetOperation(args: Array<[string, InspectNode]>): OpenAPIOperation {
  // Build response schema with actual properties from get cmd args
  const responseProperties: Record<string, OpenAPISchemaObject> = {
    ".id": { type: "string", description: "Item identifier" },
  };
  for (const [name, arg] of args) {
    responseProperties[name] = argToSchema(arg);
  }

  const params: Array<OpenAPIParameter> = args.map(([name, arg]) => ({
    name,
    in: "query",
    required: false,
    description: (arg.desc as string) || undefined,
    schema: argToSchema(arg),
  }));
  // .proplist filtering on GET via query string: GET /path?.proplist=address,disabled
  params.push({
    name: ".proplist",
    in: "query",
    required: false,
    description: "Comma-separated list of properties to return",
    schema: { type: "string" },
  });

  return {
    summary: "print",
    parameters: params,
    responses: {
      "200": {
        description: "Success",
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: { type: "object", properties: responseProperties },
            },
          },
        },
      },
      ...errorResponses(),
    },
  };
}

function makeBodyOperation(summary: string, args: Array<[string, InspectNode]>): OpenAPIOperation {
  const properties: Record<string, OpenAPISchemaObject | OpenAPIRef> = {};
  for (const [name, arg] of args) {
    properties[name] = argToSchema(arg);
  }

  // Compose command-specific properties with shared QueryOptions via allOf
  const schema: OpenAPISchemaObject = Object.keys(properties).length > 0
    ? {
      allOf: [
        { type: "object", properties },
        { $ref: "#/components/schemas/QueryOptions" },
      ],
    }
    : { $ref: "#/components/schemas/QueryOptions" };

  return {
    summary,
    requestBody: {
      content: {
        "application/json": { schema },
      },
    },
    responses: standardResponses(),
  };
}

function standardResponses() {
  return {
    "200": {
      description: "Success",
      content: { "application/json": { schema: { $ref: "#/components/schemas/RouterOSItem" } } },
    },
    ...errorResponses(),
    ...notFoundResponse(),
  };
}

function errorResponses() {
  return {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "406": { $ref: "#/components/responses/NotAcceptable" },
  };
}

function notFoundResponse() {
  return { "404": { $ref: "#/components/responses/NotFound" } };
}

// ── CLI Entry Point ────────────────────────────────────────────────────────

interface CliOptions {
  inspectFile?: string;
  rosVersion?: string;
  live: boolean;
  outputDir: string;
  skipOpenapi: boolean;
  skipCompletion: boolean;
  testCrashPaths: boolean;
  version: boolean;
  help: boolean;
  transport: "auto" | "rest" | "native";
  apiHost?: string;
  apiPort: number;
}

function parseCliArgs(): { opts: CliOptions; pathArgs: string[] } {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      "inspect-file": { type: "string" },
      "ros-version": { type: "string" },
      live: { type: "boolean", default: false },
      "output-dir": { type: "string", default: "." },
      "skip-openapi": { type: "boolean", default: false },
      "skip-completion": { type: "boolean", default: false },
      "test-crash-paths": { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      transport: { type: "string", default: "auto" },
      "api-host": { type: "string" },
      "api-port": { type: "string", default: "8728" },
    },
    strict: true,
    allowPositionals: true,
  });

  const transportRaw = values.transport ?? "auto";
  if (transportRaw !== "auto" && transportRaw !== "rest" && transportRaw !== "native") {
    throw new Error(`--transport must be auto, rest, or native; got "${transportRaw}"`);
  }

  const [, , ...pathArgs] = positionals;

  return {
    opts: {
      inspectFile: values["inspect-file"],
      rosVersion: values["ros-version"],
      live: values.live ?? false,
      outputDir: values["output-dir"] ?? ".",
      skipOpenapi: values["skip-openapi"] ?? false,
      skipCompletion: values["skip-completion"] ?? false,
      testCrashPaths: values["test-crash-paths"] ?? false,
      version: values.version ?? false,
      help: values.help ?? false,
      transport: transportRaw,
      apiHost: values["api-host"],
      apiPort: parseInt(values["api-port"] ?? "8728", 10),
    },
    pathArgs,
  };
}

function printUsage() {
  console.log(`
deep-inspect.ts — Enhanced RouterOS schema generation

Usage:
  bun deep-inspect.ts [options] [path...]

Options:
  --inspect-file <path>   Input inspect.json file (offline enrichment)
  --ros-version <ver>     Override RouterOS version (e.g. 7.23beta4)
  --live                  Query live router (URLBASE/BASICAUTH env vars)
  --output-dir <dir>      Output directory (default: .)
  --skip-openapi          Skip OpenAPI 3.0 generation
  --skip-completion       Skip completion data fetching
  --test-crash-paths      Test CRASH_PATHS for safety (requires live router)
  --transport <mode>      Transport: auto (default), rest, or native
  --api-host <host>       Native API host (default: derived from URLBASE)
  --api-port <port>       Native API port (default: 8728)
  --version               Print RouterOS version and exit
  --help                  Show this help

Environment:
  URLBASE     RouterOS REST base URL (e.g. http://localhost:9180/rest)
  BASICAUTH   Credentials as user:pass (e.g. admin:)

Transport selection (--transport):
  auto   Try native API (port 8728) first; fall back to REST if not reachable (default)
  rest   Use REST API only (port 80 via URLBASE)
  native Use native API only (port 8728); fails if not reachable

Examples:
  # Offline enrichment (no completion data, just structure + OpenAPI)
  # Note: Bun auto-loads .env — add --skip-completion if URLBASE is set in .env
  bun deep-inspect.ts --inspect-file docs/7.22/inspect.json --output-dir /tmp --skip-completion

  # Live enrichment with completions (auto-selects native API if port 8728 is open)
  URLBASE=http://localhost:9180/rest BASICAUTH=admin: \\
    bun deep-inspect.ts --inspect-file docs/7.22/inspect.json

  # Full live crawl via native API (fastest)
  URLBASE=http://localhost:9180/rest BASICAUTH=admin: \\
    bun deep-inspect.ts --live --transport native --output-dir docs/7.22
`.trim());
}

async function main() {
  const { opts, pathArgs } = parseCliArgs();

  if (opts.help) {
    printUsage();
    return;
  }

  // Build client if we have connection info
  const urlBase = process.env.URLBASE;
  const basicAuth = process.env.BASICAUTH;
  let client: IRouterOSClient | null = null;
  let activeTransport: string | undefined;

  if (urlBase && basicAuth) {
    const colonIdx = basicAuth.indexOf(":");
    const user = basicAuth.substring(0, colonIdx);
    const password = basicAuth.substring(colonIdx + 1);
    const apiHost = opts.apiHost ?? new URL(urlBase).hostname;
    const apiPort = opts.apiPort;

    if (opts.transport === "native") {
      const nc = new NativeRouterOSClient(apiHost, apiPort, user, password);
      await nc.connect();
      client = nc;
      activeTransport = "native";
    } else if (opts.transport === "rest") {
      client = new RouterOSClient(urlBase, basicAuth);
      activeTransport = "rest";
    } else {
      // auto: try native API first, fall back to REST
      try {
        const nc = new NativeRouterOSClient(apiHost, apiPort, user, password);
        await nc.connect();
        client = nc;
        activeTransport = "native";
        console.log(`Transport: native API (${apiHost}:${apiPort})`);
      } catch (err) {
        const code = (err as RosError).code ?? (err as NodeJS.ErrnoException).code ?? "";
        console.log(`Transport: REST (native API unavailable: ${code || (err as Error).message})`);
        client = new RouterOSClient(urlBase, basicAuth);
        activeTransport = "rest";
      }
    }
  }

  // --version: print version and exit
  if (opts.version) {
    if (!client) {
      console.error("Error: --version requires URLBASE and BASICAUTH env vars");
      process.exit(1);
    }
    const ver = await client.fetchVersion();
    console.log(ver);
    return;
  }

  // Load or crawl the inspect tree
  let inspectTree: InspectNode;
  let version = "unknown";

  if (opts.live) {
    if (!client) {
      console.error("Error: --live requires URLBASE and BASICAUTH env vars");
      process.exit(1);
    }
    version = await client.fetchVersion();
    console.log(`Crawling live router v${version}...`);

    // Determine which CRASH_PATHS to skip in the crawl
    const skipPaths = new Set<string>(CRASH_PATHS as unknown as string[]);

    if (opts.testCrashPaths) {
      console.log("Testing CRASH_PATHS...");
      const crashResults = await testCrashPaths(client);
      // Remove safe paths from the skip set
      for (const r of crashResults) {
        if (r.safe) skipPaths.delete(r.path);
      }
    }

    inspectTree = await crawlInspectTree(client, pathArgs, skipPaths);
  } else if (opts.inspectFile) {
    const file = Bun.file(opts.inspectFile);
    if (!(await file.exists())) {
      console.error(`Error: inspect file not found: ${opts.inspectFile}`);
      process.exit(1);
    }
    inspectTree = await file.json();
    console.log(`Loaded inspect tree from ${opts.inspectFile}`);

    // Use explicit --ros-version if provided, otherwise try path extraction
    if (opts.rosVersion) {
      version = opts.rosVersion;
    } else {
      const versionMatch = opts.inspectFile.match(/(\d+\.\d+(?:\.\d+)?(?:(?:beta|rc)\d+)?)\//);
      if (versionMatch) {
        version = versionMatch[1];
      }
    }
  } else {
    console.error("Error: specify --inspect-file <path> or --live");
    printUsage();
    process.exit(1);
  }

  console.log(`Version: ${version}`);

  // Test CRASH_PATHS (if requested and not already done in --live mode)
  let crashPathResults: CrashPathResult[] = [];
  if (opts.testCrashPaths && !opts.live) {
    if (!client) {
      console.error("Warning: --test-crash-paths requires a live router (URLBASE/BASICAUTH)");
    } else {
      console.log("Testing CRASH_PATHS...");
      crashPathResults = await testCrashPaths(client);
    }
  }

  // Enrich with completion data
  let completionStats = { argsTotal: 0, argsWithCompletion: 0, argsFailed: 0 };
  let enrichmentDurationMs: number | undefined;
  if (!opts.skipCompletion && client) {
    console.log("Enriching with completion data...");
    const enrichStart = performance.now();
    completionStats = await enrichWithCompletions(inspectTree, client);
    enrichmentDurationMs = Math.round(performance.now() - enrichStart);
    console.log(
      `Completions: ${completionStats.argsWithCompletion}/${completionStats.argsTotal} args enriched` +
      (completionStats.argsFailed > 0 ? `, ${completionStats.argsFailed} failed` : "") +
      ` (${(enrichmentDurationMs / 1000).toFixed(1)}s)`,
    );
  } else if (!opts.skipCompletion && !client) {
    console.log("Skipping completions (no live router connection)");
  }

  // Build _meta
  // apiTransport is only set when completion enrichment was actually performed.
  // It reflects the transport that was used ("rest" or "native"), or undefined when
  // --skip-completion was passed or no client was configured.
  const meta: DeepInspectMeta = {
    version,
    generatedAt: new Date().toISOString(),
    apiTransport: (!opts.skipCompletion && client !== null) ? activeTransport : undefined,
    enrichmentDurationMs,
    crashPathsTested: crashPathResults.map((r) => r.path),
    crashPathsSafe: crashPathResults.filter((r) => r.safe).map((r) => r.path),
    crashPathsCrashed: crashPathResults.filter((r) => !r.safe).map((r) => r.path),
    completionStats,
  };

  // Write deep-inspect.json
  const deepInspect: DeepInspectOutput = { _meta: meta, ...inspectTree };
  const deepInspectPath = `${opts.outputDir}/deep-inspect.json`;
  await Bun.write(deepInspectPath, JSON.stringify(deepInspect));
  console.log(`Written: ${deepInspectPath}`);

  // Write openapi.json
  if (!opts.skipOpenapi) {
    const openapi = generateOpenAPI(inspectTree, version);
    const openapiPath = `${opts.outputDir}/openapi.json`;
    await Bun.write(openapiPath, JSON.stringify(openapi, null, 2));
    console.log(`Written: ${openapiPath}`);
  }

  console.log("Done.");

  // Close native API connection if open
  client?.close?.();
}

// Only run main when executed directly (not imported in tests)
const isMainModule = import.meta.path === Bun.main;
if (isMainModule) {
  await main();
}
