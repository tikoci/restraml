// analyze_appports.js
// Analyzes host port mappings from RouterOS /app built-in apps (docs/<version>/app.json).
// Reports:
//   - Conflicts between apps on the same host port (per TCP/UDP)
//   - Conflicts with IANA registered service names
//   - Whether ports fall inside candidate "community app" ranges
//
// Usage:
//   bun scripts/analyze_appports.js [--version 7.23beta4] [--format yaml|text] [--ranges] [--all-versions]
//
// Options:
//   --version <ver>    RouterOS version to analyze (default: latest available)
//   --format <fmt>     Output format: "yaml" or "text" (default: text)
//   --ranges           Only show ports inside candidate community ranges
//   --all-versions     Analyze all versions that have app.json and show a comparison
//   --help             Show this help
//
// Exit codes:
//   0  No inter-app port conflicts detected
//   1  One or more inter-app port conflicts detected
//   2  Usage error
//
// The script can also be imported as a module; call analyzeAppPorts(version?) and it returns
// a structured result object (see PortReport typedef at the bottom of this file).

// ─── Imports ────────────────────────────────────────────────────────────────

const fs = require("fs")
const path = require("path")
const YAML = require("js-yaml")

// ─── IANA Service Data ───────────────────────────────────────────────────────
// Source: IANA Service Name and Transport Protocol Port Number Registry
// https://www.iana.org/assignments/service-names-port-numbers/service-names-port-numbers.xhtml
// Curated to cover: ports used by MikroTik built-in apps plus the four candidate
// community ranges (6717-6766, 8504-8553, 8810-8872, 9803-9874).
// Format: [port, protocols[], service_name, description]
// Where protocols is an array of "tcp", "udp", or both.
// "both" shorthand is expanded at load time.
const IANA_SERVICES_RAW = [
  // Well-known app ports used by MikroTik apps
  [21,    ["tcp"],       "ftp",          "File Transfer Protocol"],
  [22,    ["tcp"],       "ssh",          "Secure Shell"],
  [25,    ["tcp"],       "smtp",         "Simple Mail Transfer"],
  [53,    ["tcp","udp"], "domain",       "Domain Name Server"],
  [80,    ["tcp"],       "http",         "World Wide Web HTTP"],
  [110,   ["tcp"],       "pop3",         "Post Office Protocol v3"],
  [143,   ["tcp"],       "imap",         "Internet Message Access Protocol"],
  [222,   ["tcp"],       "rsh-spx",      "Berkeley rshd with SPX auth"],
  [443,   ["tcp"],       "https",        "HTTP over TLS/SSL"],
  [465,   ["tcp"],       "submissions",  "Message Submission over TLS"],
  [514,   ["udp"],       "syslog",       "Syslog"],
  [587,   ["tcp"],       "submission",   "Message Submission"],
  [993,   ["tcp"],       "imaps",        "IMAP over TLS/SSL"],
  [995,   ["tcp"],       "pop3s",        "POP3 over TLS/SSL"],
  [1880,  ["tcp"],       "vsat-control", "VSAT Control Protocol"],
  [1883,  ["tcp","udp"], "mqtt",         "MQ Telemetry Transport (MQTT)"],
  [2055,  ["udp"],       "uniport",      "Uniport (historically assigned; NetFlow common use)"],
  [2222,  ["tcp"],       "EtherNet/IP-1","EtherNet/IP I/O"],
  [3000,  ["tcp"],       "hbci",         "HBCI (Home Banking Computer Interface)"],
  [3001,  [],            "",             "(Unassigned)"],
  [3923,  ["tcp","udp"], "symb-sb-port", "Symmetrix SB port"],
  [4190,  ["tcp"],       "sieve",        "ManageSieve Protocol"],
  [4444,  ["tcp","udp"], "krb524",       "Kerberos 5 to 4 Grant Tickets"],
  [5000,  ["tcp","udp"], "commplex-main","CommPlex Main"],
  [5001,  ["tcp","udp"], "commplex-link","CommPlex Link"],
  [5230,  ["tcp"],       "pptp",         "(not standardized; commonly used by apps)"],
  [5380,  [],            "",             "(Unassigned)"],
  [5601,  [],            "",             "(Unassigned — Kibana/Elasticsearch common use)"],
  [5672,  ["tcp"],       "amqp",         "Advanced Message Queuing Protocol"],
  [5679,  ["tcp","udp"], "activesync",   "Microsoft ActiveSync over TCP"],
  [6789,  ["tcp"],       "nmap",         "nmap/NZBGet common use (unassigned IANA)"],
  [6790,  [],            "",             "(Unassigned)"],
  [7878,  [],            "",             "(Unassigned — Radarr common use)"],
  [8000,  ["tcp","udp"], "irdmi",        "iRDMI"],
  [8001,  ["tcp","udp"], "vcom-tunnel",  "VCOM Tunnel"],
  [8069,  [],            "",             "(Unassigned — Odoo common use)"],
  [8073,  [],            "",             "(Unassigned)"],
  [8079,  [],            "",             "(Unassigned)"],
  [8080,  ["tcp","udp"], "http-alt",     "HTTP Alternate"],
  [8081,  [],            "",             "(Unassigned — HTTP common alternate)"],
  [8082,  [],            "",             "(Unassigned)"],
  [8083,  [],            "",             "(Unassigned — MQTT over TLS common)"],
  [8084,  [],            "",             "(Unassigned)"],
  [8085,  [],            "",             "(Unassigned)"],
  [8086,  ["tcp"],       "d-s-n",        "Distributed SCADA Networking"],
  [8087,  [],            "",             "(Unassigned)"],
  [8088,  [],            "",             "(Unassigned)"],
  [8089,  [],            "",             "(Unassigned)"],
  [8090,  [],            "",             "(Unassigned)"],
  [8091,  [],            "",             "(Unassigned — Couchbase common)"],
  [8092,  [],            "",             "(Unassigned)"],
  [8093,  [],            "",             "(Unassigned)"],
  [8094,  [],            "",             "(Unassigned)"],
  [8095,  [],            "",             "(Unassigned)"],
  [8096,  [],            "",             "(Unassigned)"],
  [8097,  [],            "",             "(Unassigned)"],
  [8098,  [],            "",             "(Unassigned)"],
  [8099,  [],            "",             "(Unassigned)"],
  [8100,  [],            "",             "(Unassigned)"],
  [8101,  [],            "",             "(Unassigned)"],
  [8102,  [],            "",             "(Unassigned)"],
  [8103,  [],            "",             "(Unassigned)"],
  [8104,  [],            "",             "(Unassigned)"],
  [8105,  [],            "",             "(Unassigned)"],
  [8123,  [],            "",             "(Unassigned — Home Assistant common use)"],
  [8384,  [],            "",             "(Unassigned — Syncthing common use)"],
  [8428,  [],            "",             "(Unassigned)"],
  [8443,  ["tcp","udp"], "pcsync-https", "PCSync HTTPS Port"],
  [8448,  [],            "",             "(Unassigned — Matrix Conduit common use)"],
  [8554,  ["tcp","udp"], "rtsp-alt",     "RTSP Alternate"],
  [8555,  [],            "",             "(Unassigned — Frigate WebRTC common use)"],
  [8686,  [],            "",             "(Unassigned — Lidarr common use)"],
  [8883,  ["tcp","udp"], "secure-mqtt",  "MQTT over SSL"],
  [8888,  ["tcp","udp"], "ddi-tcp-1",    "NewsEDGE server TCP/UDP"],
  [8889,  ["tcp","udp"], "ddi-tcp-2",    "Desktop Data TCP 2"],
  [8971,  [],            "",             "(Unassigned)"],
  [8983,  [],            "",             "(Unassigned — Apache Solr common use)"],
  [8989,  [],            "",             "(Unassigned — Sonarr common use)"],
  [9000,  ["tcp","udp"], "cslistener",   "CSlistener"],
  [9001,  ["tcp","udp"], "tor-orport",   "Tor ORPort"],
  [9002,  [],            "",             "(Unassigned)"],
  [9091,  [],            "",             "(Unassigned — Transmission common use)"],
  [9117,  [],            "",             "(Unassigned — Jackett common use)"],
  [9120,  [],            "",             "(Unassigned)"],
  [9200,  ["tcp","udp"], "wap-wsp",      "WAP connectionless session service"],
  [9428,  [],            "",             "(Unassigned)"],
  [9696,  [],            "",             "(Unassigned — Prowlarr common use)"],
  [9898,  ["tcp","udp"], "monkeycom",    "MonkeyCom"],
  [9999,  ["tcp","udp"], "abyss",        "Abyss"],
  [10050, ["tcp","udp"], "zabbix-agent", "Zabbix Agent"],
  [10051, ["tcp","udp"], "zabbix-trapper","Zabbix Trapper"],
  [15672, [],            "",             "(Unassigned — RabbitMQ Management common use)"],
  [15675, [],            "",             "(Unassigned)"],
  [18966, [],            "",             "(Unassigned)"],
  [21027, ["udp"],       "triton-pft",   "Triton Protocol Family Transport"],
  [22000, [],            "",             "(Unassigned — Syncthing sync common)"],
  [32400, [],            "",             "(Unassigned — Plex Media Server common)"],
  [55413, [],            "",             "(Unassigned)"],
  [55414, [],            "",             "(Unassigned)"],
  [55415, [],            "",             "(Unassigned)"],
  // Candidate community ranges — IANA registered ports within ranges
  // Range 6717–6766
  [6717,  ["tcp","udp"], "fts",          "Fault-Tolerant Services"],
  [6718,  ["tcp","udp"], "priority-e-com","Priority E-Com Application"],
  [6730,  ["tcp","udp"], "ibm-ds",       "IBM DS"],
  // Range 8504–8553
  [8504,  [],            "",             "(Unassigned)"],
  // Range 8810–8872
  [8840,  ["tcp","udp"], "cernsysmgmt",  "CERN System Management"],
  // Range 9803–9874
  [9803,  ["tcp","udp"], "sapv1",        "SAP Protocol V1"],
  [9804,  ["tcp","udp"], "sapv2",        "SAP Protocol V2"],
  [9855,  ["tcp","udp"], "sapxte",       "SAP Extended Protocol"],
]

// Build lookup: port -> { tcp?: ianaService, udp?: ianaService }
// ianaService = { name: string, description: string }
const IANA_BY_PORT = {}
for (const [port, protos, name, desc] of IANA_SERVICES_RAW) {
  if (!IANA_BY_PORT[port]) IANA_BY_PORT[port] = {}
  const entry = name ? { name, description: desc } : null
  if (protos.length === 0) {
    // Applies to any protocol
    IANA_BY_PORT[port].any = entry
  } else {
    for (const proto of protos) {
      IANA_BY_PORT[port][proto] = entry
    }
  }
}

// ─── Candidate community ranges ─────────────────────────────────────────────
// Proposed ranges of largely unassigned IANA ports (50+ unassigned consecutive ports)
// suitable for a community /app port registry.
const CANDIDATE_RANGES = [
  { start: 6717, end: 6766, label: "6717-6766" },
  { start: 8504, end: 8553, label: "8504-8553" },
  { start: 8810, end: 8872, label: "8810-8872" },
  { start: 9803, end: 9874, label: "9803-9874" },
]

// ─── Port string parser ──────────────────────────────────────────────────────
// Handles all three formats from SKILL.md plus the firewall-redirects field.
//
// Format 1 (old OCI-style):  [ip:]host:container[/tcp|/udp][:label]
// Format 2 (new ROS-style):  [ip:]host:container[:label][:tcp|:udp]
// Format 3 (object):         { target, published, protocol, name }
// Format 4 (firewall-redirect field): host:container:proto:label  (always 4 parts)
//
// Returns: { host: number, container: number, proto: "tcp"|"udp"|"both", label: string|null }
// or null if parsing fails.
function parsePortString(raw) {
  if (!raw) return null

  // Object (long-form) mapping
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const host = Number(raw.published)
    const container = Number(raw.target)
    if (Number.isNaN(host) || Number.isNaN(container)) return null
    return {
      host,
      container,
      proto: normalizeProto(raw.protocol),
      label: raw.name || null,
    }
  }

  // Strip surrounding quotes that sometimes appear in firewall-redirects
  let s = String(raw).trim().replace(/^['"]/, "").replace(/['"]$/, "")
  if (!s) return null

  // Strip leading IP address (contains a dot before first colon, or is a placeholder)
  // Handles: "192.168.1.1:53:53/udp" or "[accessIP]:8080:80"
  const ipLeadingRe = /^(?:\d+\.\d+\.\d+\.\d+|\[[^\]]+\]):/
  if (ipLeadingRe.test(s)) {
    s = s.replace(ipLeadingRe, "")
  }

  // Detect old OCI-style: host:container[/proto][:label]
  // Key indicator: a slash before a protocol
  if (s.includes("/")) {
    // e.g. "8080:80/tcp" or "8080:80/tcp:web"
    const slashIdx = s.indexOf("/")
    const colonBeforeSlash = s.slice(0, slashIdx).lastIndexOf(":")
    if (colonBeforeSlash === -1) return null
    const host = Number(s.slice(0, colonBeforeSlash))
    const container = Number(s.slice(colonBeforeSlash + 1, slashIdx))
    if (Number.isNaN(host) || Number.isNaN(container)) return null
    const rest = s.slice(slashIdx + 1)
    const protoLabelParts = rest.split(":")
    const proto = normalizeProto(protoLabelParts[0])
    const label = protoLabelParts[1] || null
    return { host, container, proto, label }
  }

  // Remaining styles are colon-delimited only.
  const parts = s.split(":")
  // Must have at least 2 parts
  if (parts.length < 2) return null

  const host = Number(parts[0])
  const container = Number(parts[1])
  if (Number.isNaN(host) || Number.isNaN(container)) return null

  if (parts.length === 2) {
    // "host:container" — no protocol or label
    return { host, container, proto: "both", label: null }
  }

  // parts[2] and optionally parts[3] can be: label, proto, or empty
  // New RouterOS style: host:container[:label][:tcp|:udp]
  // Old (no slash but has 3-4 parts): "8080:80:web" or "8080:80:web:tcp"
  // firewall-redirects 4-part: "host:container:proto:label"
  //   → "8123:8123:tcp:web"
  // Detect whether parts[2] is a protocol or a label:
  const isProto2 = /^(tcp|udp)$/i.test(parts[2])
  const isProto3 = parts.length >= 4 && /^(tcp|udp)$/i.test(parts[3])

  if (parts.length === 3) {
    // "host:container:label" or "host:container:tcp"
    if (isProto2) {
      return { host, container, proto: normalizeProto(parts[2]), label: null }
    }
    return { host, container, proto: "both", label: parts[2] || null }
  }

  if (parts.length >= 4) {
    // Could be firewall-redirects "host:container:tcp:label"
    // or new ROS style "host:container:label:tcp"
    if (isProto2) {
      // "host:container:tcp:label"
      return { host, container, proto: normalizeProto(parts[2]), label: parts[3] || null }
    }
    if (isProto3) {
      // "host:container:label:tcp"
      return { host, container, proto: normalizeProto(parts[3]), label: parts[2] || null }
    }
    // Both parts[2] and parts[3] are labels (unusual) — take first as label
    return { host, container, proto: "both", label: parts[2] || null }
  }

  return { host, container, proto: "both", label: null }
}

function normalizeProto(s) {
  if (!s) return "both"
  const lower = String(s).toLowerCase()
  if (lower === "tcp") return "tcp"
  if (lower === "udp") return "udp"
  return "both"
}

// Two port mappings conflict when their host ports are equal and their protocols overlap.
// "both" overlaps with everything; "tcp" only overlaps with "tcp" and "both"; etc.
function protosConflict(a, b) {
  if (a === "both" || b === "both") return true
  return a === b
}

// ─── Port extraction ─────────────────────────────────────────────────────────
// Extracts all host port mappings from one app.json entry.
// Prefers the `yaml` field (authoritative source) with firewall-redirects as fallback.
// Returns array of { host, container, proto, label, service, appName }.
function extractPorts(appEntry) {
  const appName = appEntry.name || appEntry[".id"] || "unknown"
  const results = []

  const ystr = appEntry.yaml || ""
  if (ystr) {
    let ydata
    try {
      ydata = YAML.load(ystr)
    } catch {
      ydata = null
    }
    if (ydata && typeof ydata === "object" && ydata.services) {
      for (const [svcName, svc] of Object.entries(ydata.services)) {
        if (!svc || !Array.isArray(svc.ports)) continue
        for (const portDef of svc.ports) {
          const parsed = parsePortString(portDef)
          if (parsed) {
            results.push({ ...parsed, service: svcName, appName })
          }
        }
      }
    }
  }

  // Fall back to firewall-redirects if YAML parsing yielded nothing
  if (results.length === 0) {
    const fr = (appEntry["firewall-redirects"] || "").trim()
    if (fr) {
      for (const seg of fr.split(",")) {
        const parsed = parsePortString(seg.trim())
        if (parsed) {
          results.push({ ...parsed, service: null, appName })
        }
      }
    }
  }

  return results
}

// ─── IANA lookup ─────────────────────────────────────────────────────────────
// Returns IANA service entry or null if unassigned.
function lookupIana(port, proto) {
  const entry = IANA_BY_PORT[port]
  if (!entry) return null
  if (entry[proto]) return entry[proto]
  if (entry.any) return entry.any
  // If proto is "both", check if either tcp or udp has an assignment
  if (proto === "both") {
    return entry.tcp || entry.udp || null
  }
  return null
}

// ─── Candidate range check ───────────────────────────────────────────────────
function getCandidateRange(port) {
  for (const r of CANDIDATE_RANGES) {
    if (port >= r.start && port <= r.end) return r
  }
  return null
}

// ─── Core analysis ───────────────────────────────────────────────────────────
/**
 * Analyzes host port usage across all apps in a single app.json file.
 * @param {string} appJsonPath  Path to app.json
 * @param {string} version      Version string (for labeling)
 * @returns {PortReport}
 */
function analyzeAppJsonFile(appJsonPath, version) {
  const data = JSON.parse(fs.readFileSync(appJsonPath, "utf8"))

  // Collect all port mappings
  /** @type {Array<{host, container, proto, label, service, appName}>} */
  const allPorts = []
  const parseErrors = []

  for (const appEntry of data) {
    const ports = extractPorts(appEntry)
    allPorts.push(...ports)
    // Track apps with yaml but no parsed ports (possible parse error)
    if (ports.length === 0 && (appEntry.yaml || appEntry["firewall-redirects"])) {
      parseErrors.push(appEntry.name || appEntry[".id"])
    }
  }

  // Build per-(host+proto) bucket: key = "port/proto"
  const buckets = {}
  for (const p of allPorts) {
    // A "both" proto mapping should be checked against tcp and udp buckets individually
    const effectiveProtos = p.proto === "both" ? ["tcp", "udp"] : [p.proto]
    for (const ep of effectiveProtos) {
      const key = `${p.host}/${ep}`
      if (!buckets[key]) buckets[key] = []
      buckets[key].push({ ...p, effectiveProto: ep })
    }
  }

  // Find inter-app conflicts (more than one distinct appName on same host+proto)
  const interAppConflicts = []
  for (const [key, mappings] of Object.entries(buckets)) {
    const apps = [...new Set(mappings.map((m) => m.appName))]
    if (apps.length > 1) {
      const [portStr, proto] = key.split("/")
      const port = Number(portStr)
      interAppConflicts.push({
        port,
        proto,
        apps: mappings.map((m) => ({
          app: m.appName,
          service: m.service,
          label: m.label,
          mapping: `${m.host}:${m.container}`,
        })),
      })
    }
  }
  interAppConflicts.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))

  // IANA conflict check — for every distinct (host port, proto) used
  const portProtos = {}
  for (const p of allPorts) {
    const eps = p.proto === "both" ? ["tcp", "udp"] : [p.proto]
    for (const ep of eps) {
      const key = `${p.host}/${ep}`
      if (!portProtos[key]) portProtos[key] = []
      portProtos[key].push(p)
    }
  }

  const ianaConflicts = []
  for (const [key, mappings] of Object.entries(portProtos)) {
    const [portStr, proto] = key.split("/")
    const port = Number(portStr)
    const ianaEntry = lookupIana(port, proto)
    if (ianaEntry?.name) {
      const apps = [...new Set(mappings.map((m) => m.appName))]
      ianaConflicts.push({
        port,
        proto,
        ianaService: ianaEntry.name,
        ianaDescription: ianaEntry.description,
        apps,
      })
    }
  }
  ianaConflicts.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))

  // Candidate range check
  const inCandidateRanges = []
  for (const [key, mappings] of Object.entries(portProtos)) {
    const [portStr, proto] = key.split("/")
    const port = Number(portStr)
    const range = getCandidateRange(port)
    if (range) {
      const ianaEntry = lookupIana(port, proto)
      const apps = [...new Set(mappings.map((m) => m.appName))]
      inCandidateRanges.push({
        port,
        proto,
        range: range.label,
        ianaService: ianaEntry?.name || null,
        apps,
      })
    }
  }
  inCandidateRanges.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto))

  // Summary table — all unique host ports with their users and IANA status
  const portSummary = []
  const seenPortProtos = new Set()
  for (const p of allPorts.sort((a, b) => a.host - b.host)) {
    const eps = p.proto === "both" ? ["tcp", "udp"] : [p.proto]
    for (const ep of eps) {
      const key = `${p.host}/${ep}`
      if (seenPortProtos.has(key)) continue
      seenPortProtos.add(key)
      const ianaEntry = lookupIana(p.host, ep)
      const range = getCandidateRange(p.host)
      const useCount = (buckets[key] || []).length
      const appNames = [...new Set((buckets[key] || []).map((m) => m.appName))]
      portSummary.push({
        port: p.host,
        proto: ep,
        apps: appNames,
        useCount,
        ianaService: ianaEntry?.name || null,
        ianaDescription: ianaEntry?.description || null,
        inCandidateRange: range ? range.label : null,
      })
    }
  }

  return {
    version,
    appJsonPath,
    totalApps: data.length,
    totalPortMappings: allPorts.length,
    parseErrors,
    portSummary,
    interAppConflicts,
    ianaConflicts,
    inCandidateRanges,
    candidateRanges: CANDIDATE_RANGES,
    hasInterAppConflicts: interAppConflicts.length > 0,
  }
}

// ─── Output formatters ───────────────────────────────────────────────────────

function formatText(report, opts = {}) {
  const lines = []
  const h1 = (s) => lines.push(`\n=== ${s} ===`)
  const h2 = (s) => lines.push(`\n--- ${s} ---`)
  const ln = (s = "") => lines.push(s)

  h1(`RouterOS /app Port Analysis — v${report.version}`)
  ln(`  Source   : ${report.appJsonPath}`)
  ln(`  Apps     : ${report.totalApps}`)
  ln(`  Port maps: ${report.totalPortMappings}`)
  if (report.parseErrors.length > 0) {
    ln(`  WARNING  : No ports extracted from: ${report.parseErrors.join(", ")}`)
  }

  // ── Inter-app conflicts
  h2(`Inter-App Port Conflicts (${report.interAppConflicts.length})`)
  if (report.interAppConflicts.length === 0) {
    ln("  (none)")
  } else {
    for (const c of report.interAppConflicts) {
      ln(`  Port ${c.port}/${c.proto}:`)
      for (const a of c.apps) {
        ln(`    ${a.app}${a.service ? `.${a.service}` : ""} — ${a.mapping}${a.label ? ` (${a.label})` : ""}`)
      }
    }
  }

  // ── IANA conflicts
  if (!opts.rangesOnly) {
    h2(`IANA Registered Conflicts (${report.ianaConflicts.length})`)
    if (report.ianaConflicts.length === 0) {
      ln("  (none)")
    } else {
      for (const c of report.ianaConflicts) {
        ln(`  Port ${c.port}/${c.proto} — IANA: "${c.ianaService}" (${c.ianaDescription})`)
        ln(`    Used by: ${c.apps.join(", ")}`)
      }
    }
  }

  // ── Candidate ranges
  h2(`Ports Inside Candidate Community Ranges`)
  ln("  (Ranges: " + report.candidateRanges.map((r) => r.label).join(", ") + ")")
  if (report.inCandidateRanges.length === 0) {
    ln("  (none — all candidate ranges are clear)")
  } else {
    for (const c of report.inCandidateRanges) {
      const iana = c.ianaService ? ` [IANA: ${c.ianaService}]` : ""
      ln(`  Port ${c.port}/${c.proto} in range ${c.range}${iana} — used by: ${c.apps.join(", ")}`)
    }
    ln("")
    // summarize which ranges are partially occupied
    const occupied = {}
    for (const c of report.inCandidateRanges) {
      occupied[c.range] = (occupied[c.range] || 0) + 1
    }
    for (const r of report.candidateRanges) {
      const n = occupied[r.label] || 0
      const total = r.end - r.start + 1
      const status = n === 0 ? "CLEAN" : `${n} ports occupied`
      ln(`  Range ${r.label} (${total} ports): ${status}`)
    }
  }

  if (!opts.rangesOnly) {
    // ── Full port table
    h2("All Host Ports — Summary Table")
    const col = (s, w) => String(s).padEnd(w)
    ln(`  ${col("Port/Proto",12)} ${col("Apps",35)} ${col("IANA Service",25)} ${col("Range",14)}`)
    ln(`  ${"─".repeat(12)} ${"─".repeat(35)} ${"─".repeat(25)} ${"─".repeat(14)}`)
    for (const p of report.portSummary) {
      const apps = p.apps.join(", ")
      const truncApps = apps.length > 34 ? apps.slice(0, 31) + "..." : apps
      ln(
        `  ${col(`${p.port}/${p.proto}`, 12)} ${col(truncApps, 35)} ${col(p.ianaService || "—", 25)} ${col(p.inCandidateRange || "—", 14)}`
      )
    }
  }

  return lines.join("\n")
}

function formatYaml(report, opts = {}) {
  const out = {
    version: report.version,
    source: report.appJsonPath,
    summary: {
      total_apps: report.totalApps,
      total_port_mappings: report.totalPortMappings,
      inter_app_conflicts: report.interAppConflicts.length,
      iana_conflicts: report.ianaConflicts.length,
      ports_in_candidate_ranges: report.inCandidateRanges.length,
    },
    candidate_ranges: report.candidateRanges.map((r) => {
      const occupied = report.inCandidateRanges.filter((c) => c.range === r.label)
      return {
        range: r.label,
        total_ports: r.end - r.start + 1,
        occupied: occupied.length,
        clean: occupied.length === 0,
        ports: occupied.map((c) => ({
          port: c.port,
          proto: c.proto,
          apps: c.apps,
          iana_service: c.ianaService || null,
        })),
      }
    }),
    inter_app_conflicts: report.interAppConflicts.map((c) => ({
      port: c.port,
      proto: c.proto,
      apps: c.apps.map((a) => ({
        app: a.app,
        service: a.service,
        label: a.label,
        mapping: a.mapping,
      })),
    })),
  }

  if (!opts.rangesOnly) {
    out.iana_conflicts = report.ianaConflicts.map((c) => ({
      port: c.port,
      proto: c.proto,
      iana_service: c.ianaService,
      iana_description: c.ianaDescription,
      apps: c.apps,
    }))

    out.all_ports = report.portSummary.map((p) => ({
      port: p.port,
      proto: p.proto,
      apps: p.apps,
      iana_service: p.ianaService || null,
      in_candidate_range: p.inCandidateRange || null,
    }))
  }

  return YAML.dump(out, { lineWidth: 120, noRefs: true })
}

// ─── Discover available versions ─────────────────────────────────────────────
function findVersionsWithAppJson(docsDir) {
  const results = []
  const entries = fs.readdirSync(docsDir, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const candidate = path.join(docsDir, ent.name, "app.json")
    if (fs.existsSync(candidate)) {
      results.push({ version: ent.name, path: candidate })
    }
  }
  // Sort by version semver-ish
  results.sort((a, b) => {
    const av = versionKey(a.version)
    const bv = versionKey(b.version)
    return av < bv ? -1 : av > bv ? 1 : 0
  })
  return results
}

// Convert version string to a sortable key (e.g., "7.22.1" → "0007.0022.0001.stable")
function versionKey(v) {
  const stability = /beta/i.test(v) ? "beta" : /rc/i.test(v) ? "rc" : "stable"
  const nums = v.replace(/[a-z]+\d*/gi, "").split(".").map((n) => n.padStart(4, "0"))
  return nums.join(".") + "." + stability
}

// ─── GitHub Actions log helpers ──────────────────────────────────────────────
function ghWarning(msg, title) {
  const t = title ? ` title=${JSON.stringify(title)}` : ""
  console.error(`::warning${t}::${msg}`)
}

function ghNotice(msg) {
  console.error(`::notice::${msg}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = (typeof Bun !== "undefined" ? Bun.argv : process.argv).slice(2)

  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    process.exit(0)
  }

  const docsDir = path.resolve(path.join(import.meta.dir, "..", "docs"))

  const versionIdx = args.indexOf("--version")
  const formatIdx = args.indexOf("--format")
  const rangesOnly = args.includes("--ranges")
  const allVersions = args.includes("--all-versions")
  const ciMode = args.includes("--ci") || process.env.GITHUB_ACTIONS === "true"

  const fmt = formatIdx >= 0 ? args[formatIdx + 1] : "text"
  if (fmt !== "text" && fmt !== "yaml") {
    console.error(`Error: --format must be "text" or "yaml"`)
    process.exit(2)
  }

  let versionsToAnalyze = []
  const available = findVersionsWithAppJson(docsDir)

  if (available.length === 0) {
    console.error(`Error: No app.json files found under ${docsDir}`)
    process.exit(2)
  }

  if (allVersions) {
    versionsToAnalyze = available
  } else if (versionIdx >= 0) {
    const v = args[versionIdx + 1]
    if (!v) {
      console.error("Error: --version requires an argument")
      process.exit(2)
    }
    const found = available.find((a) => a.version === v)
    if (!found) {
      console.error(`Error: No app.json found for version "${v}"`)
      console.error(`Available versions: ${available.map((a) => a.version).join(", ")}`)
      process.exit(2)
    }
    versionsToAnalyze = [found]
  } else {
    // Default: latest stable, then latest overall
    const latest =
      available.filter((a) => !/beta|rc/i.test(a.version)).pop() || available[available.length - 1]
    versionsToAnalyze = [latest]
  }

  let hasAnyConflict = false

  for (const { version, path: appJsonPath } of versionsToAnalyze) {
    const report = analyzeAppJsonFile(appJsonPath, version)
    if (report.hasInterAppConflicts) hasAnyConflict = true

    if (fmt === "yaml") {
      process.stdout.write(formatYaml(report, { rangesOnly }))
      if (versionsToAnalyze.length > 1) process.stdout.write("---\n")
    } else {
      console.log(formatText(report, { rangesOnly }))
    }

    // CI mode: emit GitHub Actions annotations
    if (ciMode) {
      for (const c of report.interAppConflicts) {
        const appList = c.apps.map((a) => a.app).join(", ")
        ghWarning(
          `Port ${c.port}/${c.proto} is shared by multiple /app definitions: ${appList}`,
          `/app port conflict: ${c.port}/${c.proto}`
        )
      }
      for (const c of report.ianaConflicts) {
        if (c.ianaService) {
          ghNotice(
            `Port ${c.port}/${c.proto} (IANA: "${c.ianaService}") used by: ${c.apps.join(", ")}`
          )
        }
      }
      if (report.interAppConflicts.length === 0) {
        ghNotice(`/app port analysis v${version}: no inter-app conflicts found (${report.totalPortMappings} port mappings across ${report.totalApps} apps)`)
      } else {
        ghWarning(
          `/app port analysis v${version}: ${report.interAppConflicts.length} inter-app port conflict(s) detected`,
          "/app port conflicts detected"
        )
      }
    }
  }

  // Multi-version comparison table
  if (allVersions && versionsToAnalyze.length > 1) {
    if (fmt !== "yaml") {
      console.log("\n\n=== Multi-Version Comparison ===")
      console.log("")
      const col = (s, w) => String(s).padEnd(w)
      console.log(
        `  ${col("Version", 14)} ${col("Apps", 6)} ${col("Ports", 6)} ${col("Conflicts", 10)} ${col("IANA hits", 10)}`
      )
      console.log(`  ${"─".repeat(14)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(10)} ${"─".repeat(10)}`)
      for (const { version, path: p } of versionsToAnalyze) {
        const r = analyzeAppJsonFile(p, version)
        console.log(
          `  ${col(version, 14)} ${col(r.totalApps, 6)} ${col(r.totalPortMappings, 6)} ${col(r.interAppConflicts.length, 10)} ${col(r.ianaConflicts.length, 10)}`
        )
      }
    }
  }

  process.exit(hasAnyConflict ? 1 : 0)
}

function printHelp() {
  console.log(`
analyze_appports.js — RouterOS /app host port conflict and registry analyzer

Usage:
  bun scripts/analyze_appports.js [options]

Options:
  --version <ver>    Analyze a specific RouterOS version (e.g. 7.23beta4)
  --format yaml      Output as YAML instead of plain text
  --ranges           Only show candidate community range analysis (suppress full table)
  --all-versions     Analyze all available versions and print a comparison table
  --ci               Emit GitHub Actions ::warning:: / ::notice:: annotations
  --help, -h         Show this help

Exit codes:
  0  No inter-app port conflicts
  1  One or more inter-app port conflicts found  
  2  Usage / data error

Candidate community ranges (largely unassigned IANA blocks):
${CANDIDATE_RANGES.map((r) => `  ${r.label}  (${r.end - r.start + 1} ports)`).join("\n")}
`)
}

// ─── Module export & entry point ─────────────────────────────────────────────
// Export for programmatic use (e.g. from build scripts)
export { analyzeAppJsonFile, parsePortString, protosConflict, CANDIDATE_RANGES, IANA_BY_PORT }

// Run when executed directly
main().catch((err) => {
  console.error(err)
  process.exit(2)
})

/**
 * @typedef {{
 *   version: string,
 *   appJsonPath: string,
 *   totalApps: number,
 *   totalPortMappings: number,
 *   parseErrors: string[],
 *   portSummary: Array<{port:number, proto:string, apps:string[], ianaService:string|null, ianaDescription:string|null, inCandidateRange:string|null}>,
 *   interAppConflicts: Array<{port:number, proto:string, apps:Array<{app:string, service:string|null, label:string|null, mapping:string}>}>,
 *   ianaConflicts: Array<{port:number, proto:string, ianaService:string, ianaDescription:string, apps:string[]}>,
 *   inCandidateRanges: Array<{port:number, proto:string, range:string, ianaService:string|null, apps:string[]}>,
 *   candidateRanges: Array<{start:number, end:number, label:string}>,
 *   hasInterAppConflicts: boolean
 * }} PortReport
 */
