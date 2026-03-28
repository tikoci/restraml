/**
 * enrich-openapi.ts — Enrich OpenAPI schema with documentation from rosetta DB
 *
 * Cross-references the rosetta SQLite database (ros-help.db) to add:
 * - externalDocs URLs (help.mikrotik.com) on operations
 * - Tag descriptions from page titles/URLs
 * - Property descriptions from the properties table
 *
 * The script does NOT generate any text — it only links existing data from the
 * rosetta database. All descriptions come directly from MikroTik's documentation.
 *
 * Usage:
 *   bun enrich-openapi.ts --openapi openapi.json --db ros-help.db
 *   bun enrich-openapi.ts --openapi openapi.json --db ros-help.db --output enriched.json
 *   bun enrich-openapi.ts --openapi openapi.json --db ros-help.db --dry-run
 *
 * Exit codes:
 *   0 — enrichment successful
 *   1 — error (missing files, invalid input)
 */

import { Database } from "bun:sqlite";

// ── Exported types ─────────────────────────────────────────────────────────

export interface PageInfo {
  page_id: number;
  title: string;
  url: string;
  confidence: "high" | "medium" | "low";
  source: string;
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  default_val: string | null;
  description: string;
  section: string | null;
}

export interface EnrichStats {
  totalPaths: number;
  pathsWithDocs: number;
  totalOperations: number;
  operationsWithDocs: number;
  totalArgs: number;
  argsEnriched: number;
  tagsWithDescription: number;
  totalTags: number;
  byConfidence: { high: number; medium: number; low: number };
}

// ── Exported constants ─────────────────────────────────────────────────────

/** Max dirs a page can be linked to before we consider it a noisy "hub" page */
export const HUB_PAGE_THRESHOLD = 12;

/**
 * RouterOS command names that appear as terminal OpenAPI path segments.
 * These are stripped to get the parent directory path for doc matching.
 * Only includes names verified as pure commands (never directories) in
 * /console/inspect — ambiguous names (ping, profile, ssh, etc.) are
 * intentionally excluded so their directory-level docs aren't lost.
 */
export const CMD_NAMES = new Set([
  "print", "export", "import", "reset", "monitor", "listen",
  "enable", "disable", "comment", "move", "unset", "upgrade",
  "reset-counters", "reset-counters-all", "flush", "scan",
  "make-supout", "check-for-updates", "refresh", "release",
  "renew", "cancel", "edit", "fetch", "find", "recursive-print",
]);

/** Known abbreviation mappings (RouterOS path segment → common page title) */
export const ABBREVIATIONS: Record<string, string[]> = {
  bgp: ["BGP"],
  ospf: ["OSPF"],
  rip: ["RIP"],
  dns: ["DNS"],
  dhcp: ["DHCP"],
  ntp: ["NTP"],
  nat: ["NAT"],
  vlan: ["VLAN"],
  vrrp: ["VRRP"],
  mpls: ["MPLS"],
  ldp: ["LDP"],
  vpls: ["VPLS"],
  ppp: ["PPP"],
  pppoe: ["PPPoE"],
  ipsec: ["IPsec"],
  ipv6: ["IPv6"],
  eoip: ["EoIP"],
  gre: ["GRE"],
  sstp: ["SSTP"],
  snmp: ["SNMP"],
  ssh: ["SSH"],
  smb: ["SMB"],
  upnp: ["UPnP"],
  bfd: ["BFD"],
  lte: ["LTE"],
  wifi: ["WiFi"],
  arp: ["ARP"],
  igmp: ["IGMP Proxy"],
  pim: ["PIM-SM"],
  "is-is": ["IS-IS"],
  zerotier: ["ZeroTier"],
  "caps-man": ["CAPsMAN", "AP Controller (CAPsMAN)"],
  capsman: ["CAPsMAN", "AP Controller (CAPsMAN)"],
  certificate: ["Certificates"],
  hotspot: ["HotSpot - Captive portal", "HotSpot"],
  wireguard: ["WireGuard"],
  radius: ["RADIUS"],
  "dhcp-server": ["DHCP"],
  "dhcp-client": ["DHCP"],
  "dhcp-relay": ["DHCP"],
  firewall: ["Firewall"],
  address: ["IP Addressing"],
  route: ["IP Routing"],
  neighbor: ["Neighbor discovery"],
  settings: ["IP Settings"],
  pool: ["IP Pools"],
  socks: ["SOCKS"],
  proxy: ["Web Proxy"],
  ethernet: ["Ethernet"],
};

// ── Exported pure functions ────────────────────────────────────────────────

/**
 * Convert an OpenAPI path like "/ip/address/{id}" or "/ip/address/set"
 * to the RouterOS dir path "/ip/address".
 */
export function oaPathToRouterOsDir(oaPath: string): string {
  let p = oaPath.replace(/\/\{id\}$/, "");
  const lastSeg = p.split("/").pop() || "";
  if (CMD_NAMES.has(lastSeg)) {
    p = p.split("/").slice(0, -1).join("/");
  }
  return p || "/";
}

/**
 * Check if a page title is relevant to a RouterOS path by looking for
 * word overlap between the title and path segments. Guards against false links
 * like /ip/dhcp-server → "Switch Chip Features".
 */
export function isTitleRelevantToPath(title: string, routerOsPath: string): boolean {
  const titleWords = new Set(
    title.toLowerCase().split(/[\s\-_/()]+/).filter((w) => w.length >= 2),
  );
  const pathSegments = routerOsPath.split("/").filter(Boolean);

  for (const seg of pathSegments) {
    const segWords = seg.toLowerCase().split("-");
    for (const w of segWords) {
      if (w.length < 2) continue;
      for (const tw of titleWords) {
        if (tw.startsWith(w) || w.startsWith(tw)) return true;
      }
    }
  }

  // Also check known abbreviation → title mappings
  for (const seg of pathSegments) {
    const guesses = segmentToTitleGuesses(seg.toLowerCase());
    for (const g of guesses) {
      if (g.toLowerCase() === title.toLowerCase()) return true;
    }
  }

  return false;
}

/**
 * Get only abbreviation-sourced guesses for a segment (for prefix matching).
 * Does NOT include generic title-cased transformations.
 */
export function getAbbreviationGuesses(segment: string): string[] {
  const guesses: string[] = [];
  const lower = segment.toLowerCase();
  if (ABBREVIATIONS[lower]) {
    guesses.push(...ABBREVIATIONS[lower]);
  }
  const parts = segment.split("-");
  if (parts.length > 1) {
    for (const part of parts) {
      if (ABBREVIATIONS[part.toLowerCase()]) {
        guesses.push(...ABBREVIATIONS[part.toLowerCase()]);
      }
    }
  }
  return guesses;
}

/**
 * Generate plausible page title guesses from a RouterOS path segment.
 */
export function segmentToTitleGuesses(segment: string): string[] {
  const guesses: string[] = [];
  const lower = segment.toLowerCase();
  if (ABBREVIATIONS[lower]) {
    guesses.push(...ABBREVIATIONS[lower]);
  }
  const titleCased = segment
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  guesses.push(titleCased);
  const parts = segment.split("-");
  if (parts.length > 1) {
    for (const part of parts) {
      if (ABBREVIATIONS[part.toLowerCase()]) {
        guesses.push(...ABBREVIATIONS[part.toLowerCase()]);
      }
    }
  }
  guesses.push(segment);
  return guesses;
}

/**
 * Merge a rosetta documentation description with the existing structural description.
 * Keep the structural info (type ranges, etc.) in parentheses after the doc text.
 */
export function mergeDescription(rosettaDesc: string, existingDesc: string): string {
  if (!existingDesc) return rosettaDesc;
  if (rosettaDesc.toLowerCase() === existingDesc.toLowerCase()) return rosettaDesc;
  return `${rosettaDesc} (${existingDesc})`;
}

// ── CLI entry point ────────────────────────────────────────────────────────

if (import.meta.main) {
  await main();
}

async function main() {
  const { parseArgs } = await import("util");

  const { values: args } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      openapi: { type: "string" },
      db: { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "min-confidence": { type: "string", default: "medium" },
    },
  });

  if (!args.openapi || !args.db) {
    console.error("Usage: bun enrich-openapi.ts --openapi <openapi.json> --db <ros-help.db> [--output <out.json>] [--dry-run]");
    process.exit(1);
  }

  const openapiPath = args.openapi;
  const dbPath = args.db;
  const outputPath = args.output || openapiPath;
  const dryRun = args["dry-run"] ?? false;
  const minConfidence = args["min-confidence"] as "high" | "medium" | "low";

  const openapiFile = Bun.file(openapiPath);
  if (!(await openapiFile.exists())) {
    console.error(`OpenAPI file not found: ${openapiPath}`);
    process.exit(1);
  }

  const dbFile = Bun.file(dbPath);
  if (!(await dbFile.exists())) {
    console.error(`Database file not found: ${dbPath}`);
    process.exit(1);
  }

  const schema = await openapiFile.json();
  const db = new Database(dbPath, { readonly: true });

  // ── Prepared statements ────────────────────────────────────────────────

  const stmtCmdPage = db.prepare(`
    SELECT c.page_id, p.title, p.url
    FROM commands c
    JOIN pages p ON c.page_id = p.id
    WHERE c.path = ? AND c.type = 'dir'
  `);

  const stmtPageLinkCount = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM commands
    WHERE page_id = ? AND type = 'dir'
  `);

  const stmtPageByPathTitle = db.prepare(`
    SELECT id as page_id, title, url
    FROM pages
    WHERE title = ?
  `);

  const stmtPageByTitle = db.prepare(`
    SELECT id as page_id, title, url
    FROM pages
    WHERE LOWER(title) = LOWER(?)
    LIMIT 1
  `);

  const stmtPageByTitlePrefix = db.prepare(`
    SELECT id as page_id, title, url
    FROM pages
    WHERE LOWER(title) LIKE (LOWER(?) || '%')
    ORDER BY LENGTH(title)
    LIMIT 1
  `);

  const stmtProperty = db.prepare(`
    SELECT name, type, default_val, description, section
    FROM properties
    WHERE page_id = ? AND LOWER(name) = LOWER(?)
    ORDER BY sort_order
    LIMIT 1
  `);

  // ── Page resolution ──────────────────────────────────────────────────

  function findPageForPath(routerOsPath: string): PageInfo | null {
    // Strategy 1: Pages with path-like titles (e.g., "/routing/bgp")
    const pathTitleResult = stmtPageByPathTitle.get(routerOsPath) as { page_id: number; title: string; url: string } | null;
    if (pathTitleResult) {
      return { ...pathTitleResult, confidence: "high", source: "path-title" };
    }

    // Strategy 2: rosetta commands.page_id, but only if the page isn't a hub
    // AND the page title is relevant to the path
    const cmdResult = stmtCmdPage.get(routerOsPath) as { page_id: number; title: string; url: string } | null;
    if (cmdResult) {
      const linkCount = stmtPageLinkCount.get(cmdResult.page_id) as { cnt: number };
      const isHub = linkCount.cnt > HUB_PAGE_THRESHOLD;
      const isRelevant = isTitleRelevantToPath(cmdResult.title, routerOsPath);
      if (!isHub && isRelevant) {
        return { ...cmdResult, confidence: "high", source: "cmd-link" };
      }
    }

    // Strategy 3: Match page title to meaningful path segments
    const segments = routerOsPath.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i];
      const titleGuesses = segmentToTitleGuesses(segment);
      for (const guess of titleGuesses) {
        const result = stmtPageByTitle.get(guess) as { page_id: number; title: string; url: string } | null;
        if (result) {
          const confidence = i === segments.length - 1 ? "medium" : "low";
          return { ...result, confidence, source: "title-match" };
        }
      }
      // Prefix match only for abbreviation-sourced guesses
      const abbrevGuesses = getAbbreviationGuesses(segment);
      for (const guess of abbrevGuesses) {
        if (guess.length < 3) continue;
        const prefixResult = stmtPageByTitlePrefix.get(guess) as { page_id: number; title: string; url: string } | null;
        if (prefixResult && isTitleRelevantToPath(prefixResult.title, routerOsPath)) {
          const confidence = i === segments.length - 1 ? "medium" : "low";
          return { ...prefixResult, confidence, source: "title-prefix" };
        }
      }
    }

    // Strategy 4: Walk up parent paths using commands.page_id
    const parentSegments = routerOsPath.split("/").filter(Boolean);
    for (let i = parentSegments.length - 1; i >= 1; i--) {
      const parentPath = `/${parentSegments.slice(0, i).join("/")}`;
      const parentResult = stmtCmdPage.get(parentPath) as { page_id: number; title: string; url: string } | null;
      if (parentResult) {
        const linkCount = stmtPageLinkCount.get(parentResult.page_id) as { cnt: number };
        const isRelevant = isTitleRelevantToPath(parentResult.title, parentPath);
        if (linkCount.cnt <= HUB_PAGE_THRESHOLD && isRelevant) {
          return { ...parentResult, confidence: "low", source: "parent-cmd" };
        }
      }
    }

    // Strategy 5: Fall back to rosetta's cmd link even if hub, but only if relevant
    if (cmdResult && isTitleRelevantToPath(cmdResult.title, routerOsPath)) {
      return { ...cmdResult, confidence: "low", source: "cmd-link-hub" };
    }

    return null;
  }

  // ── Confidence filter ──────────────────────────────────────────────────

  const confidenceLevels: Record<string, number> = { high: 3, medium: 2, low: 1 };

  function meetsConfidence(pageInfo: PageInfo): boolean {
    return confidenceLevels[pageInfo.confidence] >= confidenceLevels[minConfidence];
  }

  // ── Enrichment ─────────────────────────────────────────────────────────

  const stats: EnrichStats = {
    totalPaths: 0,
    pathsWithDocs: 0,
    totalOperations: 0,
    operationsWithDocs: 0,
    totalArgs: 0,
    argsEnriched: 0,
    tagsWithDescription: 0,
    totalTags: 0,
    byConfidence: { high: 0, medium: 0, low: 0 },
  };

  const pageCache = new Map<string, PageInfo | null>();

  function getPageCached(routerOsDir: string): PageInfo | null {
    const cached = pageCache.get(routerOsDir);
    if (cached !== undefined) return cached;
    const result = findPageForPath(routerOsDir);
    pageCache.set(routerOsDir, result);
    return result;
  }

  // Enrich each path's operations
  const paths = schema.paths as Record<string, Record<string, unknown>>;

  for (const [oaPath, pathItem] of Object.entries(paths)) {
    stats.totalPaths++;
    const routerOsDir = oaPathToRouterOsDir(oaPath);
    const pageInfo = getPageCached(routerOsDir);

    for (const [_method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== "object" || operation === null) continue;
      const op = operation as Record<string, unknown>;
      stats.totalOperations++;

      if (pageInfo && meetsConfidence(pageInfo)) {
        op.externalDocs = {
          url: pageInfo.url,
          description: `RouterOS Manual — ${pageInfo.title}`,
        };
        stats.operationsWithDocs++;
      }

      if (pageInfo && meetsConfidence(pageInfo)) {
        enrichOperationArgs(op, pageInfo);
      }
    }

    if (pageInfo && meetsConfidence(pageInfo)) {
      stats.pathsWithDocs++;
      stats.byConfidence[pageInfo.confidence]++;
    }
  }

  // ── Arg enrichment ───────────────────────────────────────────────────

  function enrichOperationArgs(op: Record<string, unknown>, pageInfo: PageInfo) {
    if (Array.isArray(op.parameters)) {
      for (const param of op.parameters) {
        if (typeof param !== "object" || param === null || "$ref" in param) continue;
        const p = param as Record<string, unknown>;
        const name = p.name as string;
        if (!name || name.startsWith(".")) continue;
        stats.totalArgs++;

        const prop = stmtProperty.get(pageInfo.page_id, name) as PropertyInfo | null;
        if (prop?.description) {
          const existingDesc = (p.description as string) || "";
          p.description = mergeDescription(prop.description, existingDesc);
          stats.argsEnriched++;
        }
      }
    }

    const requestBody = op.requestBody as Record<string, unknown> | undefined;
    if (requestBody?.content) {
      const content = requestBody.content as Record<string, unknown>;
      const jsonContent = content["application/json"] as Record<string, unknown> | undefined;
      if (jsonContent?.schema) {
        enrichSchemaProperties(jsonContent.schema as Record<string, unknown>, pageInfo);
      }
    }

    const responses = op.responses as Record<string, unknown> | undefined;
    if (responses?.["200"]) {
      const resp200 = responses["200"] as Record<string, unknown>;
      if (resp200.content) {
        const respContent = resp200.content as Record<string, unknown>;
        const jsonResp = respContent["application/json"] as Record<string, unknown> | undefined;
        if (jsonResp?.schema) {
          enrichSchemaProperties(jsonResp.schema as Record<string, unknown>, pageInfo);
        }
      }
    }
  }

  function enrichSchemaProperties(schemaObj: Record<string, unknown>, pageInfo: PageInfo) {
    if (schemaObj.properties) {
      const props = schemaObj.properties as Record<string, Record<string, unknown>>;
      for (const [name, propSchema] of Object.entries(props)) {
        if (name.startsWith(".")) continue;
        stats.totalArgs++;

        const prop = stmtProperty.get(pageInfo.page_id, name) as PropertyInfo | null;
        if (prop?.description) {
          const existingDesc = (propSchema.description as string) || "";
          propSchema.description = mergeDescription(prop.description, existingDesc);
          stats.argsEnriched++;
        }
      }
    }

    if (Array.isArray(schemaObj.allOf)) {
      for (const item of schemaObj.allOf) {
        if (typeof item === "object" && item !== null && !("$ref" in item)) {
          enrichSchemaProperties(item as Record<string, unknown>, pageInfo);
        }
      }
    }

    if (schemaObj.items && typeof schemaObj.items === "object" && !("$ref" in schemaObj.items)) {
      enrichSchemaProperties(schemaObj.items as Record<string, unknown>, pageInfo);
    }
  }

  // ── Tag enrichment ───────────────────────────────────────────────────

  function enrichTags() {
    const tagSet = new Set<string>();
    for (const pathItem of Object.values(paths)) {
      for (const operation of Object.values(pathItem)) {
        if (typeof operation !== "object" || operation === null) continue;
        const op = operation as Record<string, unknown>;
        if (Array.isArray(op.tags)) {
          for (const t of op.tags) tagSet.add(t as string);
        }
      }
    }

    const tagObjects: Array<Record<string, unknown>> = [];

    for (const tagName of tagSet) {
      stats.totalTags++;
      const tagPath = `/${tagName}`;
      const pageInfo = getPageCached(tagPath);

      if (pageInfo && meetsConfidence(pageInfo)) {
        tagObjects.push({
          name: tagName,
          description: pageInfo.title,
          externalDocs: {
            url: pageInfo.url,
            description: `RouterOS Manual — ${pageInfo.title}`,
          },
        });
        stats.tagsWithDescription++;
      } else {
        tagObjects.push({ name: tagName });
      }
    }

    if (tagObjects.length > 0) {
      tagObjects.sort((a, b) => (a.name as string).localeCompare(b.name as string));
      schema.tags = tagObjects;
    }
  }

  enrichTags();

  // ── Output ─────────────────────────────────────────────────────────────

  function pct(a: number, b: number): string {
    return b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "0%";
  }

  console.log("\n=== OpenAPI Documentation Enrichment ===\n");
  console.log(`Input:  ${openapiPath}`);
  console.log(`DB:     ${dbPath}`);
  console.log(`Output: ${dryRun ? "(dry run)" : outputPath}`);
  console.log(`Min confidence: ${minConfidence}\n`);

  console.log("Paths:");
  console.log(`  ${stats.pathsWithDocs}/${stats.totalPaths} paths got externalDocs (${pct(stats.pathsWithDocs, stats.totalPaths)})`);
  console.log(`  Confidence: ${stats.byConfidence.high} high, ${stats.byConfidence.medium} medium, ${stats.byConfidence.low} low`);
  console.log("\nOperations:");
  console.log(`  ${stats.operationsWithDocs}/${stats.totalOperations} operations got externalDocs (${pct(stats.operationsWithDocs, stats.totalOperations)})`);
  console.log("\nProperties:");
  console.log(`  ${stats.argsEnriched}/${stats.totalArgs} args enriched with descriptions (${pct(stats.argsEnriched, stats.totalArgs)})`);
  console.log("\nTags:");
  console.log(`  ${stats.tagsWithDescription}/${stats.totalTags} tags got descriptions (${pct(stats.tagsWithDescription, stats.totalTags)})`);

  if (!dryRun) {
    await Bun.write(outputPath, JSON.stringify(schema, null, 2) + "\n");
    console.log(`\nWrote enriched schema to: ${outputPath}`);
  }

  db.close();
}
