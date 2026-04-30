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
import { RosAPI, RosErrorCode, type RosError } from "./ros-api-protocol";

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
    /** Paths that timed out in the concurrent batch pass and were queued for sequential
     *  retry. A high value relative to argsTotal means the concurrent batch is
     *  overwhelming the router — with the native API, the router serializes
     *  /console/inspect internally, so ghost in-flight commands stall the queue. */
    argsTimedOut: number;
    /** Paths in the retry queue that returned an empty completion array (not an error).
     *  These are "silent misses" that should never differ from the REST transport. */
    argsBlankOnRetry: number;
  };
  /** Present only when native transport was used. Tracks TCP connection resets
   *  observed during enrichment — each reset rejects all in-flight commands on the
   *  shared connection. Non-zero values indicate a potential RouterOS or Bun bug
   *  worth reporting upstream. */
  nativeApiReconnects?: {
    count: number;
    /** First up to 20 arg paths that experienced a CONNRESET (for bug diagnosis) */
    firstPaths: string[];
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
 *  Tracked upstream as MikroTik support case SUP-127641 (originally filed 2023-09; reopened
 *  2026-04 against 7.20.8 long-term).
 *
 *  Investigation against live routers (April 2026, CHR with 256 MB RAM) found:
 *  - RouterOS 7.20.8 (long-term): `POST /rest/console/inspect {"request":"syntax","path":"do"}`
 *    hangs the entire HTTP server for ~30 seconds with no response. The same hang occurs with
 *    `request=completion`. Only `"do"` causes the hang; the others (where, else, rule, command,
 *    on-error) are safe on 7.20.8 — they just return an empty array [] instantly.
 *    Crucially: since testCrashPaths probes sequentially, any path tested AFTER "do" appears
 *    to crash too (the server is already hung). This was the cause of false CI failures on 7.20.8.
 *  - RouterOS 7.21.4, 7.22.1, 7.22.2, 7.23beta5, 7.23rc2: all 6 paths return HTTP 200 immediately
 *    — the bug is fixed. Fix landed between 7.20.8 and 7.21.4 (confirmed by per-version
 *    `crashPathsCrashed` data in `docs/<version>/deep-inspect.json`).
 *  - `"do"` with `request=child` is safe on all tested versions — returns its args immediately.
 *  - Nested paths (e.g. ["do","command"]) with any request type are safe on all versions.
 *
 *  RAM is NOT the cause of the "do" hang (confirmed April 2026): tested at both 128 MB and
 *  512 MB on 7.20.8 — the hang reproduces identically at both sizes (~63 s total wall time
 *  each, including 5 s timeout + server recovery). This is a pure code-level deadlock in
 *  RouterOS ≤7.20.8, not memory pressure.
 *  Reproducer: `bun scripts/test-crash-path-memory.ts --version 7.20.8`
 *
 *  Separate RAM observation: with 17 extra packages on 256 MB CHR, general /console/inspect
 *  REST calls inflate from ~70ms to >10s and the server eventually stops responding. This is a
 *  different, memory-pressure symptom resolved by 1024 MB (see deep-inspect-multi-arch.yaml,
 *  commit 7052106). MikroTik support case SUP-127641 initially suggested a RAM connection, but
 *  these are confirmed to be distinct issues.
 *
 *  These paths are skipped by crawlInspectTree (and rest2raml.js parseChildren) by default.
 *  testCrashPaths() probes them with fetchSyntax and waits for server recovery between probes.
 *
 *  MikroTik bug: /console/inspect with request=syntax or request=completion at bare path "do"
 *  deadlocks the REST scripting engine on RouterOS ≤7.20.8 (fixed by 7.21.4).
 */
// ── Client interface ──────────────────────────────────────────────────────

export interface IRouterOSClient {
  fetchVersion(): Promise<string>;
  fetchChild(path: string[], signal?: AbortSignal): Promise<InspectChildResponse[]>;
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
/** Timeout for the sequential retry pass — much longer than the concurrent
 *  batch timeout since each call runs alone without subsystem contention. */
const COMPLETION_RETRY_TIMEOUT_MS = 30_000;

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

  async fetchChild(path: string[], signal?: AbortSignal): Promise<InspectChildResponse[]> {
    return this.fetchPost<InspectChildResponse[]>(
      `${this.baseUrl}/console/inspect`,
      { request: "child", path: path.join(",") },
      signal,
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

// ── Native API Client ─────────────────────────────────────────────────────

/**
 * RouterOS native API (port 8728/8729) client implementing IRouterOSClient.
 * Uses `/console/inspect` via the wire protocol for each operation.
 * All values from the native API are strings — normalization happens downstream
 * in completionsToObject() exactly as it does for the REST client.
 *
 * ⚠️  NOT USED IN CI — RouterOS native API `/console/inspect` with request=completion
 * returns non-deterministic results: ~20-30% of entries are randomly dropped per call.
 * REST is 100% deterministic. Use `--transport rest` (the default) for all production work.
 * This code is retained for potential future use if MikroTik fixes the bug.
 * See docs/mikrotik-bug-native-api-inspect.md and docs/deep-inspect.md.
 */
export class NativeRouterOSClient implements IRouterOSClient {
  private api: RosAPI;
  /** Number of CONNRESET errors observed — each one means the TCP connection
   *  dropped and all in-flight commands on the shared connection were rejected.
   *  Tracked for bug diagnosis (MikroTik / Bun). */
  private connResetCount = 0;
  /** First N arg paths that experienced a CONNRESET (sampled for bug reports). */
  private connResetPaths: string[] = [];

  constructor(host: string, port: number, user: string, password: string) {
    this.api = new RosAPI(host, port, user, password);
  }

  async connect(): Promise<void> {
    await this.api.connect();
  }

  close(): void {
    this.api.close();
  }

  /** Returns reconnect diagnostics accumulated during this session.
   *  A non-zero count means the TCP connection dropped at least once.
   *  The next write() call after a drop auto-reconnects (RosAPI.write reconnects
   *  when !connected), so enrichment continues — but missed completions and
   *  slowdown are side-effects worth tracking and reporting. */
  getReconnectStats(): { count: number; firstPaths: string[] } {
    return { count: this.connResetCount, firstPaths: [...this.connResetPaths] };
  }

  /** Log a CONNRESET event. Call from catch blocks in fetch* methods.
   *  Only acts on CONNRESET; lets other errors (timeout, trap) pass silently. */
  private _logIfConnReset(method: string, path: string[], err: unknown): void {
    if ((err as RosError).code === RosErrorCode.CONNRESET) {
      this.connResetCount++;
      if (this.connResetPaths.length < 20) {
        this.connResetPaths.push(path.join("/"));
      }
      console.warn(
        `[native-api] CONNRESET #${this.connResetCount} in ${method}(${path.join("/")}) — ` +
        "RosAPI will auto-reconnect on next call",
      );
    }
  }

  async fetchVersion(): Promise<string> {
    const sentences = await this.api.write("/system/resource/print");
    const version = sentences[0]?.data.version;
    if (!version) throw new Error("Could not read RouterOS version from native API");
    return version.split(" ")[0];
  }

  async fetchChild(path: string[], _signal?: AbortSignal): Promise<InspectChildResponse[]> {
    try {
      const sentences = await this.api.write(
        "/console/inspect",
        "=request=child",
        `=path=${path.join(",")}`,
      );
      return sentences.map((s) => s.data as unknown as InspectChildResponse);
    } catch (err) {
      this._logIfConnReset("fetchChild", path, err);
      throw err;
    }
  }

  async fetchSyntax(path: string[], signal?: AbortSignal): Promise<InspectSyntaxResponse[]> {
    try {
      // writeAbortable sends /cancel to the router when signal fires,
      // preventing ghost in-flight commands from stalling the router.
      const sentences = await this.api.writeAbortable(
        signal,
        "/console/inspect", "=request=syntax", `=path=${path.join(",")}`
      );
      return sentences.map((s) => s.data as unknown as InspectSyntaxResponse);
    } catch (err) {
      this._logIfConnReset("fetchSyntax", path, err);
      throw err;
    }
  }

  async fetchCompletion(path: string[], signal?: AbortSignal): Promise<InspectCompletionResponse[]> {
    try {
      // writeAbortable sends /cancel to the router when signal fires,
      // preventing ghost in-flight commands from stalling the router.
      const sentences = await this.api.writeAbortable(
        signal,
        "/console/inspect", "=request=completion", `=path=${path.join(",")}`
      );
      // Native API returns strings for all fields. completionsToObject() normalises:
      // show (string "true"/"false"), preference (string→number), text→desc fallback.
      return sentences.map((s) => s.data as unknown as InspectCompletionResponse);
    } catch (err) {
      this._logIfConnReset("fetchCompletion", path, err);
      throw err;
    }
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
      const parsedPreference =
        typeof c.preference === "string" ? Number(c.preference) : c.preference;
      if (Number.isFinite(parsedPreference)) {
        entry.preference = parsedPreference;
      }
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
 *  leveraging native API tag multiplexing when available.
 *  Any path that times out under concurrent load is automatically retried
 *  sequentially (one at a time) with COMPLETION_RETRY_TIMEOUT_MS — ensuring
 *  0 missed paths in the final output. */
export async function enrichWithCompletions(
  tree: InspectNode,
  client: IRouterOSClient,
  path: string[] = [],
  stats = { argsTotal: 0, argsWithCompletion: 0, argsFailed: 0, argsTimedOut: 0, argsBlankOnRetry: 0 },
  onFailure?: (path: string[], error: Error) => void,
): Promise<typeof stats> {
  const args = collectArgNodes(tree, path);
  stats.argsTotal = args.length;

  // First pass: concurrent batches for throughput.
  // Collect failures rather than reporting them — some paths timeout under
  // concurrent load but respond instantly when retried sequentially.
  const retryQueue: Array<{ node: InspectNode; path: string[] }> = [];

  for (let i = 0; i < args.length; i += ENRICHMENT_BATCH_SIZE) {
    const batch = args.slice(i, i + ENRICHMENT_BATCH_SIZE);
    let batchHadConnReset = false;
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
      } catch (err) {
        // Track whether this batch had a CONNRESET — log batch composition once.
        if (!batchHadConnReset && (err as RosError)?.code === RosErrorCode.CONNRESET) {
          batchHadConnReset = true;
          const batchNum = Math.floor(i / ENRICHMENT_BATCH_SIZE) + 1;
          const batchPaths = batch.map(b => b.path.join("/"));
          console.warn(
            `[enrichment] CONNRESET during batch #${batchNum} (args ${i}–${i + batch.length - 1}). ` +
            `All ${batch.length} paths in this batch will be retried sequentially.\n` +
            `  Batch paths: ${batchPaths.join(", ")}`,
          );
        }
        // Queue for sequential retry — do NOT count as failure yet.
        retryQueue.push({ node, path: argPath });
      }
    }));
  }

  stats.argsTimedOut = retryQueue.length;
  if (retryQueue.length > 0) {
    const pct = ((retryQueue.length / args.length) * 100).toFixed(1);
    console.log(`Retry queue: ${retryQueue.length}/${args.length} paths (${pct}%) timed out in batch pass — retrying sequentially`);
  }

  // Second pass: sequential retry for any path that failed under concurrent load.
  // Test data shows these paths respond in 1–2ms when called one at a time.
  for (const { node, path: argPath } of retryQueue) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), COMPLETION_RETRY_TIMEOUT_MS);
      const completions = await client.fetchCompletion(argPath, controller.signal);
      clearTimeout(timeout);

      const shown = filterCompletions(completions);
      if (shown.length > 0) {
        node._completion = completionsToObject(shown);
        stats.argsWithCompletion++;
      } else {
        // Retry succeeded but returned no completions. This is a "silent miss" —
        // the batch-pass ghost commands may have consumed the completion data.
        stats.argsBlankOnRetry++;
      }
    } catch (err) {
      // Still failing after sequential retry — genuinely unresponsive path.
      stats.argsFailed++;
      onFailure?.(argPath, err instanceof Error ? err : new Error(String(err)));
    }
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

/** Per-request timeout for tree crawl — generous default, overridable via --request-timeout
 *  for slow emulation (TCG arm64). Unset = no per-request abort signal. */
let CRAWL_REQUEST_TIMEOUT_MS: number | undefined;

/** Set the per-request timeout used by crawlInspectTree (called from main). */
export function setCrawlRequestTimeout(ms: number | undefined) {
  CRAWL_REQUEST_TIMEOUT_MS = ms;
}

/** Crawl the inspect tree from scratch via the live router (mirrors rest2raml.js parseChildren) */
export async function crawlInspectTree(
  client: IRouterOSClient,
  rpath: string[] = [],
  skipPaths: Set<string> = new Set(CRASH_PATHS as unknown as string[]),
  _depth = 0,
): Promise<InspectNode> {
  const memo: InspectNode = {};
  const signal = CRAWL_REQUEST_TIMEOUT_MS ? AbortSignal.timeout(CRAWL_REQUEST_TIMEOUT_MS) : undefined;
  let children: InspectChildResponse[];
  try {
    children = await client.fetchChild(rpath, signal);
  } catch (err) {
    const pathStr = `/${rpath.join("/")}`;
    console.error(`  ⚠ fetchChild failed for ${pathStr}: ${err instanceof Error ? err.message : err}`);
    return memo;
  }

  // Progress logging at top two levels
  if (_depth <= 1 && rpath.length > 0) {
    console.log(`  crawl: /${rpath.join("/")} (${children.filter(c => c.type === "child").length} children)`);
  }

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
          const syntaxSignal = CRAWL_REQUEST_TIMEOUT_MS ? AbortSignal.timeout(CRAWL_REQUEST_TIMEOUT_MS) : undefined;
          const syntax = await client.fetchSyntax(newpath, syntaxSignal);
          if (syntax.length === 1 && syntax[0].text.length > 0) {
            node.desc = syntax[0].text;
          }
        } catch {
          // Syntax fetch failed — skip desc
        }
      }
    }

    try {
      const childTree = await crawlInspectTree(client, newpath, skipPaths, _depth + 1);
      Object.assign(node, childTree);
    } catch (err) {
      const pathStr = `/${newpath.join("/")}`;
      console.error(`  ⚠ crawl failed for ${pathStr}: ${err instanceof Error ? err.message : err}`);
    }
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
  outputSuffix?: string;
  arch?: "x86" | "arm64";
  skipOpenapi: boolean;
  skipCompletion: boolean;
  testCrashPaths: boolean;
  version: boolean;
  help: boolean;
  transport: "auto" | "rest" | "native";
  apiHost?: string;
  apiPort: number;
  requestTimeout?: number;
}

function parseCliArgs(): { opts: CliOptions; pathArgs: string[] } {
  const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
      "inspect-file": { type: "string" },
      "ros-version": { type: "string" },
      live: { type: "boolean", default: false },
      "output-dir": { type: "string", default: "." },
      "output-suffix": { type: "string" },
      arch: { type: "string" },
      "skip-openapi": { type: "boolean", default: false },
      "skip-completion": { type: "boolean", default: false },
      "test-crash-paths": { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      transport: { type: "string", default: "rest" },
      "api-host": { type: "string" },
      "api-port": { type: "string", default: "8728" },
      "request-timeout": { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const transportRaw = values.transport ?? "rest";
  if (transportRaw !== "auto" && transportRaw !== "rest" && transportRaw !== "native") {
    throw new Error(`--transport must be auto, rest, or native; got "${transportRaw}"`);
  }

  const archRaw = values.arch;
  if (archRaw !== undefined && archRaw !== "x86" && archRaw !== "arm64") {
    throw new Error(`--arch must be x86 or arm64; got "${archRaw}"`);
  }

  const validatePositiveInteger = (
    rawValue: string | undefined,
    optionName: string,
    min: number,
    max?: number,
  ): number | undefined => {
    if (rawValue === undefined) {
      return undefined;
    }
    if (!/^\d+$/.test(rawValue)) {
      if (max !== undefined) {
        throw new Error(`--${optionName} must be a valid integer between ${min} and ${max}; got "${rawValue}"`);
      }
      throw new Error(`--${optionName} must be a valid integer greater than 0; got "${rawValue}"`);
    }
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
      if (max !== undefined) {
        throw new Error(`--${optionName} must be a valid integer between ${min} and ${max}; got "${rawValue}"`);
      }
      throw new Error(`--${optionName} must be a valid integer greater than 0; got "${rawValue}"`);
    }
    return parsed;
  };

  const apiPortRaw = values["api-port"] ?? "8728";
  const apiPort = validatePositiveInteger(apiPortRaw, "api-port", 1, 65535) as number;

  const requestTimeoutParsed = validatePositiveInteger(values["request-timeout"], "request-timeout", 1);

  const [, , ...pathArgs] = positionals;

  return {
    opts: {
      inspectFile: values["inspect-file"],
      rosVersion: values["ros-version"],
      live: values.live ?? false,
      outputDir: values["output-dir"] ?? ".",
      outputSuffix: values["output-suffix"],
      arch: archRaw,
      skipOpenapi: values["skip-openapi"] ?? false,
      skipCompletion: values["skip-completion"] ?? false,
      testCrashPaths: values["test-crash-paths"] ?? false,
      version: values.version ?? false,
      help: values.help ?? false,
      transport: transportRaw,
      apiHost: values["api-host"],
      apiPort,
      requestTimeout: requestTimeoutParsed,
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
  --inspect-file <path>   Input inspect.json file (offline enrichment, dev only — see docs/deep-inspect.md "Deep-inspect production builds run their own crawl")
  --ros-version <ver>     Override RouterOS version (e.g. 7.23beta4)
  --live                  Query live router (URLBASE/BASICAUTH env vars)
  --arch <x86|arm64>      Record architecture in _meta.architecture (set by orchestrator)
  --output-dir <dir>      Output directory (default: .)
  --output-suffix <str>   Filename suffix, e.g. "arm64" → deep-inspect.arm64.json
  --skip-openapi          Skip OpenAPI 3.0 generation
  --skip-completion       Skip completion data fetching
  --test-crash-paths      Test CRASH_PATHS for safety (requires live router)
  --request-timeout <ms>  Per-request timeout in ms (e.g. 120000 for slow TCG emulation)
  --transport <mode>      Transport: rest (default), auto, or native
  --api-host <host>       Native API host (default: derived from URLBASE)
  --api-port <port>       Native API port (default: 8728)
  --version               Print RouterOS version and exit
  --help                  Show this help

Environment:
  URLBASE     RouterOS REST base URL (e.g. http://localhost:9180/rest)
  BASICAUTH   Credentials as user:pass (e.g. admin:)

Transport selection (--transport):
  rest   Use REST API only — deterministic, production-safe (default)
  auto   Try native API (port 8728) first; fall back to REST if not reachable
  native Use native API only (port 8728); NOTE: non-deterministic for completions (RouterOS bug)

Examples:
  # Offline enrichment (no completion data, just structure + OpenAPI)
  # Note: Bun auto-loads .env — add --skip-completion if URLBASE is set in .env
  bun deep-inspect.ts --inspect-file docs/7.22/inspect.json --output-dir /tmp --skip-completion

  # Live enrichment with completions via REST (default transport — deterministic)
  URLBASE=http://localhost:9180/rest BASICAUTH=admin: \\
    bun deep-inspect.ts --inspect-file docs/7.22/inspect.json

  # Full live crawl and enrichment (REST transport)
  URLBASE=http://localhost:9180/rest BASICAUTH=admin: \\
    bun deep-inspect.ts --live --output-dir docs/7.22
`.trim());
}

async function main() {
  const { opts, pathArgs } = parseCliArgs();

  if (opts.help) {
    printUsage();
    return;
  }

  // Apply per-request timeout (for slow TCG arm64 emulation)
  if (opts.requestTimeout) {
    setCrawlRequestTimeout(opts.requestTimeout);
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
  let completionStats = { argsTotal: 0, argsWithCompletion: 0, argsFailed: 0, argsTimedOut: 0, argsBlankOnRetry: 0 };
  let enrichmentDurationMs: number | undefined;
  if (!opts.skipCompletion && client) {
    console.log("Enriching with completion data...");
    const enrichStart = performance.now();
    completionStats = await enrichWithCompletions(inspectTree, client);
    enrichmentDurationMs = Math.round(performance.now() - enrichStart);
    console.log(
      `Completions: ${completionStats.argsWithCompletion}/${completionStats.argsTotal} args enriched` +
      (completionStats.argsFailed > 0 ? `, ${completionStats.argsFailed} failed` : "") +
      (completionStats.argsTimedOut > 0 ? `, ${completionStats.argsTimedOut} retried` : "") +
      (completionStats.argsBlankOnRetry > 0 ? `, ${completionStats.argsBlankOnRetry} blank-on-retry` : "") +
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
    architecture: opts.arch,
    apiTransport: (!opts.skipCompletion && client !== null) ? activeTransport : undefined,
    enrichmentDurationMs,
    crashPathsTested: crashPathResults.map((r) => r.path),
    crashPathsSafe: crashPathResults.filter((r) => r.safe).map((r) => r.path),
    crashPathsCrashed: crashPathResults.filter((r) => !r.safe).map((r) => r.path),
    completionStats,
  };

  // Attach native API reconnect diagnostics when present.
  // A non-zero count signals potential RouterOS or Bun TCP bug — see docs/mikrotik-bug-native-api-inspect.md.
  if (activeTransport === "native" && client instanceof NativeRouterOSClient) {
    const rcStats = client.getReconnectStats();
    if (rcStats.count > 0) {
      meta.nativeApiReconnects = rcStats;
      console.warn(
        `[native-api] ${rcStats.count} CONNRESET event(s) observed during enrichment. ` +
        "This indicates the RouterOS TCP connection dropped under concurrent load. " +
        "See _meta.nativeApiReconnects for affected paths. " +
        "This may be a MikroTik RouterOS or Bun TCP socket bug — please report.",
      );
    }
  }

  // Write deep-inspect.json (or deep-inspect.{suffix}.json if --output-suffix is set)
  const deepInspect: DeepInspectOutput = { _meta: meta, ...inspectTree };
  const suffix = opts.outputSuffix ? `.${opts.outputSuffix}` : "";
  const deepInspectPath = `${opts.outputDir}/deep-inspect${suffix}.json`;
  await Bun.write(deepInspectPath, JSON.stringify(deepInspect));
  console.log(`Written: ${deepInspectPath}`);

  // Write openapi.json (or openapi.{suffix}.json if --output-suffix is set)
  if (!opts.skipOpenapi) {
    const openapi = generateOpenAPI(inspectTree, version);
    const openapiPath = `${opts.outputDir}/openapi${suffix}.json`;
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
