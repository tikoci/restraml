# CLAUDE.md — AI Agent Guide for restraml

> This file is written for future AI coding agents (Copilot, Claude, etc.) working on this repository.
> It explains the architecture, key patterns, common tasks, and critical gotchas so you can be
> productive immediately without extensive archaeology of the codebase.

## What This Repository Does

**restraml** generates API schema documentation for the [MikroTik RouterOS](https://mikrotik.com/) REST API.

The pipeline is:
1. Boot a RouterOS CHR (Cloud Hosted Router) directly in QEMU on the GitHub Actions runner
2. Query the router's `/console/inspect` REST endpoint to extract the full command/API tree
3. Convert that tree to [RAML 1.0](https://raml.org/) schema format and OpenAPI 3.0
4. Commit everything to `/docs/` and publish via GitHub Pages

The generated schemas live at https://tikoci.github.io/restraml — with per-version folders in `/docs/`.

---

## Repository Layout

```
restraml/
├── rest2raml.js          # Main script: connects to RouterOS REST API → RAML 1.0
├── validraml.cjs         # Validates RAML 1.0 (uses webapi-parser, requires Node.js)
├── appyamlvalidate.js    # Validates /app YAML schemas and built-in /app YAMLs (Bun)
├── deep-inspect.ts       # Deep inspection of RouterOS API tree (Bun)
├── enrich-openapi.ts     # Enriches generated OpenAPI schemas (Bun)
├── validate-openapi.ts   # Validates OpenAPI 3.0 schemas (Bun)
├── ros-api-protocol.ts   # Vendored RouterOS native API wire protocol (Bun)
├── *.test.ts             # Unit + integration tests (bun test)
├── Dockerfile.chr-qemu   # Alpine image that runs RouterOS CHR in QEMU (for local use)
├── scripts/
│   ├── entrypoint.sh               # QEMU launcher used by Dockerfile.chr-qemu (user-mode networking)
│   ├── test-with-qemu.sh           # Integration tests (deep-inspect) against local QEMU CHR
│   ├── test-ros-api.sh             # Integration + stress tests (ros-api-protocol) against local CHR
│   ├── benchmark-qemu.sh           # REST vs native API timing benchmark against local CHR
│   ├── deep-inspect-multi-arch.ts  # Per-arch deep-inspect orchestrator (quickchr library, x86 + arm64)
│   ├── diff-deep-inspect.ts        # Diff two deep-inspect.<arch>.json files (enum drift + path delta)
│   ├── analyze_appports.js         # Analyze /app port mappings (Bun)
│   ├── analyze_appyamls.py         # Analyze /app YAML patterns (Python)
│   └── extract_appyamls.py         # Extract /app YAMLs from app.json (Python)
├── .env                  # Local dev env vars (URLBASE, BASICAUTH) — not committed secrets
├── docs/                 # GitHub Pages root; one subdirectory per RouterOS version
│   ├── index.html        # Main SPA: version list, diff tool, download links
│   ├── lookup.html       # RouterOS command search tool (fully event-driven, no buttons)
│   ├── diff.html         # Schema diff tool (side-by-side / line-by-line diff between versions)
│   ├── openapi.html      # OpenAPI 3.0 API Explorer (Swagger UI)
│   ├── tikapp.html       # /app YAML editor with Monaco + live validation
│   ├── tikapp-manual.html # /app YAML documentation / manual reference
│   ├── restraml-shared.js  # Shared JS utilities for all docs/*.html pages
│   ├── restraml-shared.css # Shared CSS: fonts, logo, theme, guide, modal, utilities
│   ├── routeros-app-yaml-schema.latest.json       # /app YAML schema (strict, CI validation)
│   ├── routeros-app-yaml-schema.editor.json       # /app YAML schema (relaxed, SchemaStore/editor)
│   ├── routeros-app-yaml-store-schema.latest.json # /app store schema (strict, CI validation)
│   ├── routeros-app-yaml-store-schema.editor.json # /app store schema (relaxed, SchemaStore/editor)
│   ├── {version}/
│   │   ├── schema.raml                          # RAML 1.0 schema (presence = "this version is built")
│   │   ├── inspect.json                         # Raw /console/inspect output from RouterOS
│   │   ├── openapi.json                         # OpenAPI 3.0 schema (7.21.1+)
│   │   ├── app.json                             # Raw GET /rest/app output (built-in /app YAMLs)
│   │   ├── routeros-app-yaml-schema.json        # /app YAML schema for this version
│   │   └── routeros-app-yaml-store-schema.json  # /app store schema for this version
│   └── {version}/extra/  # Same files, but built with all_packages (extra features)
├── CLAUDE.md             # Full architecture guide for AI agents
├── AGENTS.md             # GitHub Copilot agent-specific instructions
└── .github/
    └── workflows/
        ├── auto.yaml                                    # Daily cron: detect new versions, trigger builds
        ├── manual-using-docker-in-docker.yaml           # Build: base RouterOS schema
        ├── manual-using-extra-docker-in-docker.yaml     # Build: schema with extra packages
        ├── appyamlschemas.yaml                          # Build: validate and publish /app YAML schemas
        ├── deep-inspect-multi-arch.yaml                 # Build: per-arch deep-inspect (x86 KVM + arm64 TCG) with diff
        └── manual-from-secrets.yaml                     # Build: using a real RouterOS device (secrets)
```

---

## Key Patterns and Architecture

### RouterOS Version Detection
MikroTik publishes the current version for each release channel at:
```
https://upgrade.mikrotik.com/routeros/NEWESTa7.<channel>
```
Channels: `stable`, `testing`, `development`, `long-term`

To check if a version is already built, check for `docs/{version}/schema.raml`.
To check if a version's /app YAML schemas are built, check for `docs/{version}/routeros-app-yaml-schema.json`.

### RouterOS /app YAML Schema System (7.22+)

RouterOS 7.22 introduced `/app` — a `docker-compose`-lite YAML format for defining custom container
applications. The restraml project provides JSON Schema files to validate this YAML format.

**Root-level schema files (do not rename or move these files):**

Two variants exist for both the single-app and store schemas:

| File | Purpose | Used by |
|---|---|---|
| `docs/routeros-app-yaml-schema.latest.json` | Strict validation (regex patterns, tight enums) | CI (`appyamlvalidate.js`), public URL |
| `docs/routeros-app-yaml-schema.editor.json` | Relaxed for editor UX (no regex blockers) | SchemaStore, VSCode/Monaco autocompletion |
| `docs/routeros-app-yaml-store-schema.latest.json` | Strict store schema (array of /app YAMLs) | CI, `app-store-urls=` validation |
| `docs/routeros-app-yaml-store-schema.editor.json` | Relaxed store schema | SchemaStore/editor |

**History: `*.latest.json` vs `*.editor.json`** — Originally there was a `*.dev.json` intended
for beta/RC versions. The regex-blocks-autocompletion problem in VSCode YAML extension led to
creating `*.editor.json` as a relaxed variant instead. The `*.dev.json` file was removed; the
"editor" variant solved the immediate completion problem but conflated two dimensions: (1) strict
vs editor-friendly and (2) stable vs testing/beta versions. See "Schema file naming" in
Open Process Questions below for the backlog item on rethinking this scheme.

**Per-version schema files (generated by `appyamlschemas.yaml` workflow):**
- `docs/{version}/routeros-app-yaml-schema.json` — single /app YAML schema with version-specific `$id`
- `docs/{version}/routeros-app-yaml-store-schema.json` — store schema referencing per-version single schema

Per-version schemas are generated from the base `*.latest.json` schemas with version-specific `$id` URLs
(`https://tikoci.github.io/restraml/{version}/routeros-app-yaml-schema.json`). They do NOT use `.latest`
in the filename since the parent directory already implies the version.

**`appyamlvalidate.js` — Bun script:**
- Run as: `bun appyamlvalidate.js <version>`
- Generates per-version schema files under `docs/{version}/`
- Part 1: Validates both schemas against JSON Schema meta-schema (AJV with draft-07)
  — required for potential SchemaStore publication
- Part 2: If `URLBASE` is set, fetches all built-in /app YAMLs from the live RouterOS CHR
  (`GET /rest/app`) and validates each against the schema
  — exit code 2 means at least one /app YAML failed validation
- Requires: `bun install` (deps are in `package.json`)

**`appyamlschemas.yaml` workflow:**
- Takes `rosver` input; boots CHR with extra packages (container/app feature requires them)
- Runs `appyamlvalidate.js` against the live CHR
- Handles three distinct exit codes from `appyamlvalidate.js`:
  - **Exit 0** (all passed) → commits `app.json` + per-version schemas to `docs/{version}/`
  - **Exit 1** (meta-validation failed — schemas are invalid JSON Schema) → fails immediately, commits nothing
  - **Exit 2** (live validation failed — schemas valid but some MikroTik apps don't conform) → commits `app.json` only (for debugging); schemas are NOT committed so `auto.yaml` will detect them as missing and retry the build
- Creates a GitHub Issue listing each failing built-in /app app name when exit code is 2
- Uses two separate commit steps: one for `app.json` (always if fetched), one for schemas (only on exit 0)
- Dispatched by `auto.yaml` when `docs/{version}/routeros-app-yaml-schema.json` is missing

**RouterOS /app YAML format notes:**
- Resembles `docker-compose` but is NOT compatible — RouterOS has specific differences
- Reference: https://forum.mikrotik.com/t/amm0s-manual-for-custom-app-containers-7-22beta/268036/22
- Top-level keys: `name`, `descr`, `page`, `category`, `icon`, `default-credentials`, `services`,
  `configs`, `volumes`, `networks`
- Each service under `services:` maps to one container
- Placeholders `[accessIP]`, `[accessPort]`, `[containerIP]`, `[routerIP]` etc. are expanded at deploy time
- Port format: two styles are supported:
  - Old (OCI-style): `host-port:container-port[/tcp|/udp][:label]` (e.g., `8080:80/tcp:web`)
  - New (RouterOS 7.23+ style): `host-port:container-port[:label][:tcp|:udp]` (e.g., `8080:80:web:tcp`)
  Both forms are valid; new apps from 7.23beta2 onward use the colon-separated `:tcp`/`:udp` suffix.
- The `/app` REST endpoint (`GET /rest/app`) requires the **container** extra package

**VSCode / Editor Integration:**
The /app YAML schemas work with the [RedHat YAML VSCode extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml).
Add to VSCode settings or `.vscode/settings.json`. **Files must be named using the configured ending** (e.g. `my-app.tikapp.yaml` for a single app, `my-store.tikappstore.yaml` for a store):
```json
{
  "yaml.schemas": {
    "https://tikoci.github.io/restraml/routeros-app-yaml-schema.latest.json": "*.tikapp.yaml",
    "https://tikoci.github.io/restraml/routeros-app-yaml-store-schema.latest.json": "*.tikappstore.yaml"
  }
}
```
**Important:** Regex patterns in the schema prevent autocompletion in VSCode YAML extension.
A future task may create a "loose" version of the schema without strict regex patterns to improve
editor UX (autocompletion). The current schema is intentionally strict for validation correctness.
The SchemaStore (https://www.schemastore.org) can automatically apply schemas to matching filenames —
once published there, editors like VSCode pick up the schema without manual configuration.

**How the schema evolves — `app.json` as source of truth:**
MikroTik's built-in `/app` collection (the array returned by `GET /rest/app`, stored per-version in
`docs/{version}/app.json`) is the **canonical source of truth** for schema updates. When the CI
`appyamlschemas.yaml` workflow fails with exit code 2 (validation failures), it creates a GitHub Issue
listing the failing app names and error messages. To resolve:

1. **Download the CI artifact** `app-yaml-schema-results-<version>.zip` — it contains `app.json`
   from the live CHR that was not committed because validation failed.
2. **Inspect the failing entries**: parse each failing app's `yaml` field (it's a RouterOS YAML string)
   and examine the properties that cause errors.
3. **Identify new patterns**: map each error class to a schema change:
   - `must NOT have additional properties` → new service property (e.g., `entrypoint`, `devices`)
   - `must be equal to one of the allowed values` → new enum value (e.g., new `category`)
   - `must match pattern` → port format change or new regex syntax
4. **Update `docs/routeros-app-yaml-schema.latest.json`** (strict, CI validation) and
   `docs/routeros-app-yaml-schema.editor.json` (relaxed, SchemaStore/editor) with the new properties.
5. **Copy `app.json`** from the CI artifact to `docs/{version}/app.json` so it is committed.
6. Run `bun appyamlvalidate.js <version>` locally to confirm the schema is valid JSON Schema;
   also manually validate the YAML fields from failing apps against the updated schema.
7. Per-version `routeros-app-yaml-schema.json` files are regenerated on the next CI run.

**Key: make schema changes only in `*.latest.json` and `*.editor.json`** — do NOT edit per-version
`docs/{version}/routeros-app-yaml-schema.json` files directly; those are generated by `appyamlvalidate.js`.

- **Stable releases** (e.g., `7.22`, no qualifier): only on `download.mikrotik.com`
- **Beta/RC/testing releases** (e.g., `7.22rc2`, `7.22beta4`): on `cdn.mikrotik.com`

Both the CI workflows and `Dockerfile.chr-qemu` try `download.mikrotik.com` first, then fall
back to `cdn.mikrotik.com`. This is why versions without a qualifier (like `7.22`) previously
failed when only CDN was tried. **Do not change this order.**

### rest2raml.js — Schema Generator
- Runs under [Bun](https://bun.sh/) (not Node.js) — uses `Bun.argv` for CLI args
- Connects to RouterOS via HTTP REST API: `URLBASE` and `BASICAUTH` env vars
- Uses `POST /console/inspect` with `{"request": "child", "path": "..."}` to walk the API tree
- Certain paths crash the REST server and are skipped: `where`, `do`, `else`, `rule`, `command`, `on-error`
- Writes two outputs: `ros-inspect-*.json` (raw) and `ros-rest-*.raml` (processed RAML)
- `--version` flag: prints the RouterOS version and exits (used in CI to capture the actual version)
- `INSPECTFILE` env var: skip live router query and load from a saved JSON file (useful for offline testing)

### deep-inspect.ts — Enhanced Schema Generation (Enrichment)
- Runs under Bun. Takes an existing `inspect.json` and enriches it with `request=completion`
  data from the RouterOS REST API. Outputs `deep-inspect.json` and `openapi.json`.
- Supports two transports: REST (`RouterOSClient`) and native API (`NativeRouterOSClient`)
- **CI production uses `--transport rest` only** — do not change without reading the note below

### Native API Wire Protocol (`ros-api-protocol.ts`)
- Vendored from `tikoci/tiktui`. Zero external dependencies. Fully functional binary protocol.
- Exports: `RosAPI`, `RosError`, `RosErrorCode`, `Sentence`, `CommandResult`
- Supports tag-multiplexed concurrent commands on a single TCP connection

### ⚠️ Native API Transport Policy — REST Only for Schema Generation

**Decision (May 2026):** All schema generation (both crawl and completion enrichment) uses the
REST API transport. The native API transport (`--transport native`) is NOT used in CI.

**Why:** RouterOS `/console/inspect` with `request=completion` returns **non-deterministic results**
over the native API binary protocol. The same command issued repeatedly on the same TCP connection
randomly drops completion entries ~20-30% of the time. REST is 100% deterministic. This is a
confirmed RouterOS bug, not a client-side issue.

**Key facts:**
- REST: 9,357 paths with completions, 55,730 total entries — deterministic across all runs
- Native: 9,302 paths, 53,935 entries — randomly drops entries, always a strict subset of REST
- Only `request=completion` is affected; `request=child` and `request=syntax` are reliable
- The bug is per-call random, not cumulative or session-dependent
- Native API is 22× faster for tree crawl and 2× faster per-call — but unusable for completions

**What this means for agents:**
- Do NOT change CI workflows to `--transport native` or `--transport auto` for enrichment
- `ros-api-protocol.ts` and `NativeRouterOSClient` in `deep-inspect.ts` remain for potential future use
  if MikroTik fixes the bug; `benchmark.test.ts` and `native-api.test.ts` were removed (research artifacts)
- `--transport rest` is now the explicit default in `deep-inspect.ts`
- If MikroTik fixes the bug, the hybrid approach (REST crawl + native enrichment) becomes viable
- See `BACKLOG.md` Phase 2.9 and `docs/mikrotik-bug-native-api-inspect.md` for full investigation details

### Two Build Variants
- **Base** (`manual-using-docker-in-docker.yaml`): base RouterOS only
- **Extra** (`manual-using-extra-docker-in-docker.yaml`): all_packages including container, iot, zerotier, etc.
  - Extra packages are downloaded separately from `download.mikrotik.com/routeros/{ver}/all_packages-x86-{ver}.zip`
  - Uploaded to CHR root via SCP, then CHR is rebooted to activate them

### CHR Boot Pattern — Direct QEMU on GitHub Runner
CI workflows run RouterOS CHR **directly in QEMU on the ubuntu-latest runner** (no Docker-in-Docker,
no docker-compose). The key steps are:

1. Install `qemu-system-x86` and `qemu-utils` via apt
   - **Note**: The Ubuntu package is `qemu-system-x86` (not `qemu-system-x86_64` — that's the binary name, not the apt package)
2. Enable KVM via udev rules (`/dev/kvm` is available on GitHub hosted runners)
3. Download the CHR `.vdi` image (primary: `download.mikrotik.com`, fallback: `cdn.mikrotik.com`)
4. Convert `.vdi` to `.qcow2` using `qemu-img convert -f vdi -O qcow2` (native QEMU format)
5. Launch QEMU in background with user-mode networking and port forwarding:
   - host:9180 → VM:80 (RouterOS REST API)
   - host:9122 → VM:22 (RouterOS SSH, used for SCP in extra-packages workflow)
   - Disk: `-drive file=chr.qcow2,format=qcow2,if=virtio` (virtio recommended by MikroTik for CHR)
   - Network: `-netdev user,id=net0,... -device virtio-net-pci,netdev=net0` (virtio NIC)
6. Wait up to **5 minutes** (30 × 10s) for the API to respond — fail fast if not up in time
7. Cleanup: `kill` the QEMU PID stored in `/tmp/qemu.pid`

**KVM is critical for performance** — without it CHR boots very slowly in software emulation.
If the wait loop times out, check `/tmp/qemu.log` in the artifact or CI logs for QEMU errors.

**QEMU settings for CHR (MikroTik recommended):**
- Disk: virtio (`if=virtio`) — confirmed to work on amd64/intel
- Network: virtio-net-pci — use `-netdev user,id=net0,... -device virtio-net-pci,netdev=net0`
- Memory: 256 MB is sufficient for schema generation
- Do NOT use `-nic` shorthand (less control); use `-netdev`+`-device` instead for explicit virtio

`Dockerfile.chr-qemu` + `scripts/entrypoint.sh` are provided for **local development use only**
(not used in CI). They use the same user-mode networking approach. To run locally:
```sh
docker build --build-arg ARG_ROUTEROS_VERSION=7.22 -t chr-qemu -f Dockerfile.chr-qemu .
docker run --rm -d --device /dev/kvm -p 9180:80 -p 9122:22 chr-qemu
```

### Docs Publishing
After schema generation, files are committed directly to `main` branch by `github-actions[bot]`.
The commit structure is:
```
docs/{rosver}/{schema.raml,inspect.json,openapi.json}
docs/{rosver}/extra/{schema.raml,...}   # extra-packages build only
```

### Concurrent Build Push — Retry Pattern
Multiple workflows (base + extra, multiple RouterOS versions) can run at the same time. All push
to `main`, so a simple `git push` will fail if another job committed first. The fix used in all
build workflows is to **commit first, then retry the push with `git pull --rebase`** on rejection:

```bash
git add docs/${ROSVER}/
git commit -m "Publish ${ROSVER} ..."
# Retry up to 5 times with rebase on push rejection
for attempt in {1..5}; do
  if git push origin main; then
    break
  elif [ $attempt -eq 5 ]; then
    echo "::error::Failed to push after 5 attempts due to concurrent build conflicts."
    exit 1
  fi
  echo "::warning::Push attempt $attempt/5 failed (remote is ahead), rebasing and retrying..."
  # Clean up unstaged changes left by bun install / npm install BEFORE rebase.
  # Do NOT run this before artifact upload — run it only when a push fails.
  git checkout -- .
  git clean -fd
  git pull --rebase
  sleep $((RANDOM % 10 + 5))
done
```

This is safe because each build writes to its own `docs/{version}/` directory — there are no
real file conflicts between concurrent jobs. **Do not revert to a simple `git pull` + `git push`
pattern.** The `git checkout -- .` / `git clean -fd` are required because `bun install` /
`npm install` modify tracked files (`package.json`, `bun.lock`) which would block `git pull --rebase`.

---

## WebMCP — Structured Tools for AI Agents

The `docs/*.html` pages expose [WebMCP](https://github.com/webmachinelearning/webmcp) tools
(Chrome 146+, `chrome://flags/#enable-webmcp-testing`) via the imperative API
(`navigator.modelContext.registerTool()`). This lets agentic browsers discover and call the
pages' data functions directly, returning structured JSON instead of requiring screen-scraping.

**Implementation is progressive enhancement** — all code is behind `webMCPAvailable()` feature
detection in `restraml-shared.js`. Zero impact on browsers without WebMCP support.

### Shared Infrastructure (`restraml-shared.js`)

- `webMCPAvailable()` — returns `true` if `navigator.modelContext.registerTool` exists
- `registerWebMCPTools()` — registers the shared `list_routeros_versions` tool, returns
  `{ register(toolDef) }` helper for page-specific tools. Called once per page.

### Registered Tools by Page

| Tool Name | Page | Description |
|---|---|---|
| `list_routeros_versions` | All pages | List published versions with metadata (shared) |
| `lookup_routeros_command` | `lookup.html` | Look up a CLI path/attribute in inspect.json |
| `diff_routeros_versions` | `diff.html` | Compare two versions — delta stats + added/removed paths |
| `get_routeros_changelog` | `index.html` | Fetch & parse MikroTik CHANGELOG into structured entries |
| `validate_routeros_app_yaml` | `tikapp.html` | Validate /app YAML against JSON Schema |
| `list_builtin_apps` | `tikapp.html` | List built-in /app container applications |
| `get_openapi_schema_url` | `openapi.html` | Get OpenAPI 3.0 schema download URL + availability |

### Tool Design Conventions

- All `execute` functions return `JSON.stringify(result)` — structured JSON, not HTML
- Error responses: `JSON.stringify({ error: "message" })` with descriptive text for agent self-correction
- Large data is summarized (diff returns stats + capped path lists, not full unified patch)
- Version parameters default to latest stable when omitted
- `list_routeros_versions` should be called first to discover valid version strings

### Adding a New WebMCP Tool

1. In the page's main `<script>`, get the helper: `const _wmcp = registerWebMCPTools()`
2. Register tools: `_wmcp.register({ name, description, inputSchema, execute })`
3. Follow the naming convention: `verb_routeros_noun` in `snake_case`
4. Return JSON strings from `execute` (always wrap in try/catch)
5. Add the tool to the table above

---

## Web Pages in `docs/` — Standards and Conventions

All HTML pages served from `docs/` (GitHub Pages) follow these non-negotiable conventions:

### Tech Stack
- **Pico CSS** (`@picocss/pico@2`) — the only CSS framework, loaded from CDN. No Bootstrap,
  Tailwind, or other CSS frameworks.
- **JetBrains Mono** — the primary font for all pages. Use it creatively: monospace weight
  variation, italic, variable fonts, `letter-spacing`, `font-feature-settings` for ligatures, etc.
  The font can be used for fun visual effects — the constraint is the font choice, not how it's used.
- **Semantic HTML** — use proper `<header>`, `<main>`, `<section>`, `<nav>`, `<article>`,
  `<details>`, `<summary>`, etc. No `<div>` soup.
- **No web frameworks** — no React, Vue, Angular, Svelte, etc. Vanilla JS only.
- **No build tools** — no webpack, Vite, npm scripts for the HTML page itself. Single `.html` file.
- **`restraml-shared.js`** — shared JS utilities (version parsing, theme switcher, share modal,
  GitHub API fetch). All `docs/*.html` pages load this via `<script src="restraml-shared.js"></script>`.
  When modifying shared behavior, change this file — not inline copies. When creating a new page,
  include this script before page-specific code.
- **`restraml-shared.css`** — shared CSS loaded by all pages via
  `<link rel="stylesheet" href="restraml-shared.css">` (after Pico CSS, before page `<style>`).
  Contains: font overrides (JetBrains Mono + Manrope), inline code/kbd tightening (prevents
  line-height bloat in paragraphs), MikroTik logo dark/light swap, theme switcher icon sizing,
  Tools dropdown LTR fix, `.page-guide` pattern (collapsible help sections), `.share-modal`
  styling, and utility classes (`.ml-1`, `.text-right`, `.mt-1`, `.inline-select`,
  `.switch-controls`, `.grid-2fr-1fr`, `.share-link`). When adding shared visual patterns,
  add them here — not as inline styles or duplicated `<style>` blocks.
- **Avoid submit buttons** — prefer JS event listeners (`input`, `change`, `keydown`) over explicit
  submit/lookup buttons. Use debouncing (~400 ms) for text inputs; fire immediately on `change`
  events for checkboxes and `<select>` elements. Cancellation tokens (incrementing counter compared
  before and after each `await`) prevent stale results from racing async fetches.
- **Client-side SPA** — all logic runs in the browser. There is no backend. GitHub Pages serves
  static files only. Use the **GitHub REST API** or **GitHub GraphQL API** for dynamic data
  (version lists, file contents, etc.).
- **Minimal dependencies** — only add a CDN library if it meaningfully solves a problem (e.g.,
  `json-diff`, `highlight.js`, `deep-diff`, `jsonpath`). Keep the CDN dependency count low.
- **Shareable URLs — query string pattern**: All tool pages support query strings that populate
  controls and trigger results on load. Use `history.replaceState()` to update the URL as the user
  interacts (not `pushState` — no new history entries). Read params after the async version list loads
  so `<select>` options exist before being set. Invalid/unknown params are silently ignored.
  Parameter names per page:
  - `index.html`: `compare1`, `compare2`, `extra` (false to disable), `testing` (true to enable)
  - `diff.html`: `compare1`, `compare2`, `extra`, `testing`, `format` (side-by-side|line-by-line),
    `context` (0|3), `hunks` (showing|hiding)
  - `lookup.html`: `path` (without leading slash), `attr`, `version`, `allVersions` (true),
    `testing` (true), `extra` (true)
- **Share button — two patterns exist**:
  - **Preferred: inline "Copied!" button** (`lookup.html`, `tikapp.html`): A `<button>` that
    calls `writeQueryParams()`, copies the URL via `navigator.clipboard.writeText()`, and swaps
    its text to "✓ Copied!" for 1.8 seconds. No modal, no dialog. Place it right-aligned on the
    same line as the Results heading. New pages should use this pattern.
  - **Legacy: `<dialog>` modal** (`diff.html`): A "Share" link opens a `<dialog class="share-modal">`
    with URL input and "Copy to clipboard" button, wired via `initShareModal()` from
    `restraml-shared.js`. Styling in `restraml-shared.css`. This pattern still works but new
    pages should prefer the inline button.

### docs/index.html — Architecture Reference

`docs/index.html` is the primary SPA. Key page-specific patterns:

- **Custom events**: `builddir` and `inspectdownload` events decouple data fetching from UI updates.
- **Early-event queue**: `_pendingBuildDirs` queues events that fire before `DOMContentLoaded`.
- **MikroTik logo trick**: two `<img>` tags with `data-theme="dark"` / `data-theme="light"` —
  CSS rules swap which is visible based on the current theme.
- **`inspect.json` is the data source** for diffs and stats. Use `jsonpath` for structured queries.
  Use `json-diff` + `highlight.js` for textual diff. Use `deep-diff` for change statistics.
- **Plausible analytics**: `plausible("Event Name", { props: { key: value } })` for tracking
  user interactions. Always include event tracking for new interactive features.

### docs/lookup.html — RouterOS Command Search Tool

`docs/lookup.html` is a fully event-driven command search tool. Key patterns:

- **Inline controls layout**: CLI Path (~55%), Attribute (~27%), and Version (~17%) are on a
  single row. Switches (extra-packages, check all versions, include testing) sit below.
- **Combined path+cmd input**: a single text field accepts the full path including the command
  as the last segment (e.g. `/ip/address/set`). No separate path and command inputs.
- **Dynamic, no submit button**: results update as the user types (400 ms debounce on text,
  immediate on `change` for checkboxes/selects).
- **Smart results summary**: single-version searches name the version; multi-version searches
  describe the scope ("all 25 stable versions"). Schema type (base/extra-packages) is stated.
- **Dynamic column header**: the "Details" column header changes to "Attributes" (when the
  terminal node is a command) or "Commands" (when a directory/path) based on the search result.
- **Inline share button**: "Share" button copies the URL with "✓ Copied!" feedback (no modal).
- **inspect.json cache**: fetched data cached per version+subdir in `inspectCache`.
- **Cancellation tokens**: `runLookupId` counter prevents stale async results from updating DOM.

### Custom / Derivative Pages (`docs/*.html`)

Beyond `docs/index.html`, agents may be asked (via GitHub Issues) to create additional pages
in `docs/` offering different views of the schema data. Pattern: `docs/custom-view.html`.

**Rules for custom pages:**
- Must follow all the web page conventions above (Pico CSS, JetBrains Mono, semantic HTML,
  client-side only, minimal dependencies).
- Use the GitHub API/GraphQL for any dynamic data — schemas, version lists, inspect JSON, etc.
  URLs follow the pattern `https://tikoci.github.io/restraml/{version}/inspect.json` and
  `https://tikoci.github.io/restraml/{version}/schema.raml`.
- No server-side code, no backend, no build step.
- **Include the shared Tools nav dropdown** (see "Tools Nav Dropdown" section below) for consistent navigation.
- Include `<link rel="stylesheet" href="restraml-shared.css">` after Pico CSS and Google Fonts,
  before any page-specific `<style>` block. This provides fonts, logo swap, theme switcher,
  page-guide, share-modal, and utility classes — no need to duplicate these in page styles.
- Include `<script src="restraml-shared.js"></script>` before page-specific scripts. Call
  `initThemeSwitcher()`. For sharing, prefer the inline "Copied!" button pattern (see Share
  button section above); `initShareModal({...})` is still available as a legacy option. Use
  `fetchVersionList()` and `RESTRAML.pagesUrl` from the shared utilities.
- Keep JavaScript in the single `.html` file (no separate `.js` files unless there is a very
  strong reason for separation).
- Issues requesting custom views will typically describe a desired user-facing feature (e.g.,
  "show a visual graph of RouterOS commands", "compare two versions side by side"). Interpret
  the request creatively — the font and aesthetic constraint is intentional.

**Example inspiration** (from GitHub Issues by `fischerdouglas` and others):
- A visual tree/graph of the RouterOS command hierarchy
- A filterable/searchable table of commands and arguments
- A changelog-style page showing what changed between versions
- A diff page highlighting only added/removed commands between two versions

### Tools Nav Dropdown — Shared Navigation Pattern

All `docs/*.html` pages include a **Tools** dropdown in the top nav (Pico CSS `<details class="dropdown">`),
providing consistent navigation between tools. The dropdown lists all tools; mark the current page with
`aria-current="page"`.

The dropdown currently contains both local tool pages and cross-project external links:

```html
<!-- In the right-side <ul> of the header <nav>, before the theme switcher -->
<li>
    <details class="dropdown">
        <summary>Tools</summary>
        <ul dir="rtl">
            <li><a href="https://tikoci.github.io/project-map.html">Project Map</a></li>
            <li><a href="https://tikoci.github.io/chr-images.html">CHR Images</a></li>
            <li><a href="https://tikoci.github.io/p/netinstall">Netinstall</a></li>
            <li><a href="openapi.html">API Explorer</a></li>
            <li><a href="tikapp.html">/app Editor</a></li>
            <li><a href="diff.html">Schema Diff</a></li>
            <li><a href="lookup.html">Command Lookup</a></li>
        </ul>
    </details>
</li>
```

- Use `dir="rtl"` on the `<ul>` so the dropdown aligns right when placed in the right nav column.
- The theme switcher `<li>` follows the Tools `<li>` in the same `<ul>`.
- When adding a new `docs/*.html` tool page, add it to the dropdown list in **all** existing pages.
- On `index.html`, replace direct links to other tools in the intro text with "check the **Tools** menu above".

### Dark Mode — Correct Pattern for All `docs/` Pages

Dark mode is handled by `initThemeSwitcher()` in `restraml-shared.js`. All pages call this function.

**Critical Pico v2 gotcha**: `data-theme='auto'` is **not** a valid Pico CSS v2 value — it silently
forces light mode. The shared code handles this correctly by removing the attribute for "auto" state.

**CSS pattern for third-party components in dark mode** (covers auto+OS-dark AND explicit dark):
```css
/* Auto mode + OS dark */
@media (prefers-color-scheme: dark) {
    :root:not([data-theme=light]) #mycomponent { /* dark styles */ }
}
/* Explicit dark */
[data-theme=dark] #mycomponent { /* dark styles */ }
```

### Monaco Editor Integration — Pico CSS Conflict

`docs/tikapp.html` embeds Monaco Editor. Pico CSS's global `button` and `[role="button"]` rules
leak into Monaco's internal widget DOM and style Monaco's hover tooltips, zone widgets (problem
panels), and action links as large styled buttons. The fix is a targeted CSS reset, but the
*selector specificity* is critical — get it wrong and you either don't fix Pico's overrides or
you break Monaco's own internal styling.

**The specificity sandwich:**

| Rule | Specificity | Must… |
|---|---|---|
| Pico global `button { }` | `(0,0,1)` | be beaten by our reset |
| Pico global `[role="button"] { }` | `(0,1,0)` | be beaten by our reset |
| **Our reset** | **`(0,2,1)`** | **sits between the two** |
| Monaco widget `.zone-widget button` etc. | `(0,2,1)+` | beat our reset so Monaco's own styles win |

Note: `.monaco-editor :is(button, a[role="button"])` resolves to `(0,2,1)` because `.monaco-editor`
contributes `(0,1,0)` and `:is(button, a[role="button"])` contributes `(0,1,1)` (the max specificity
of its forgiving list).

**The correct two-rule pattern:**
```css
/* Box model reset for both <button> and <a role="button"> */
.monaco-editor :is(button, a[role="button"]) {
    padding: 0; border: 0; background: transparent;
    box-shadow: none; width: auto; inline-size: auto;
    min-height: 0; margin: 0; border-radius: 0;
}
/* Font reset for <a role="button"> ONLY ("View Problem (F8)" etc.)
   Scoped to <a> not <button> — Monaco controls icon font-size on <button>.codicon */
.monaco-editor a[role="button"] {
    font-size: inherit;
    line-height: inherit;
    font-weight: inherit;
}
```

**Anti-patterns that cause bugs:**

- **`#editor-container :is(...)`** — ID gives specificity `(1,0,1)/(1,1,1)`, which is HIGHER than
  Monaco's own `.zone-widget button` rules `(0,2,1)`. This overrides Monaco's internal widget
  styles and causes close/navigate icon buttons to render as "bars" (bare codicon characters with
  all Monaco chrome removed).
- **`appearance: auto`** — tells the browser to render OS-native button chrome. On macOS dark mode
  with `background: transparent`, this produces visible striped bars on previously styled buttons.
- **`font: inherit`** — codicon icon glyphs in `.monaco-editor ::before` pseudo-elements rely on
  `font-family: codicon` being set by Monaco's own rules on the pseudo-element; adding `font: inherit`
  on the parent element can interfere with glyph rendering depending on where Monaco puts the icon
  character (text content vs `::before`). Omit it.
- **`color: inherit`** — may affect icon color in dark vs light modes. Let Monaco control it.
- **Adding `font-size/weight/line-height` to the `:is(button, a[role="button"])` rule** — Pico
  inflates font on `[role="button"]` anchors ("View Problem" link becomes oversized), but resetting
  font-size on `<button>` too can interfere with Monaco's codicon icon sizing. Split it: reset font
  properties on a **separate `a[role="button"]`-only rule** (see pattern above).

**Monaco widget types and which elements they use:**

- **Hover widget** ("View Problem (F8)" etc.): uses `<a role="button">` — must be in the selector.
- **Zone widget** (problem navigation panel): uses `<button>` and `<a role="button">` for close/navigate.
- **Overflow widgets** (hover tooltip): only appear outside `.monaco-editor` if `fixedOverflowWidgets: true`
  (default is `false`, so they stay inside `.monaco-editor` and ARE covered by the selector).

### diff2html Integration — Gotchas

`docs/diff.html` uses [diff2html](https://diff2html.xyz/) with [jsdiff](https://github.com/kpdecker/jsdiff).
The CSS in `diff.html` already handles all these issues. If modifying the diff page:

1. **`colorScheme` option is a no-op in `Diff2Html.html()`** — dark mode must use CSS overrides.
2. **Pico CSS overrides all `td`/`th`** — reset within `#diffoutput` using ID-prefixed selectors.
3. **diff2html CSS sets opaque white backgrounds** — reset `.d2h-file-wrapper` etc. to `transparent`.
4. **Context lines are a jsdiff option (patch level)**, not diff2html (render level).
   Cache `_lastText1`/`_lastText2` for context re-renders; cache `_lastPatch` for format-only.

### Collapsible Guide Pattern — In-Page Help

Tool pages (`diff.html`, `lookup.html`) include a collapsed `<details>` section that serves as
lightweight in-page documentation. This avoids linking to external docs and keeps the single-HTML
file pattern. The guide is collapsed by default so it doesn't clutter the UI for experienced users.

**Structure:**

```html
<details id="my-guide" class="page-guide">
    <summary><b>How to read this?</b> &hellip;</summary>
    <article>
        <header><strong>Section Title</strong></header>
        <!-- Usage explanation -->
        <hr>
        <!-- Notation / syntax explanation -->
        <hr>
        <div class="behind-curtain">
            <small><b>Behind the curtain</b> &mdash; ...</small>
        </div>
        <footer>
            <small>Bug/feature links, README link</small>
        </footer>
    </article>
</details>
```

**Flow:** Explain *using* the tool first (controls, options), then the *notation/syntax*, then a
brief "how the sausage is made" peek at the data source. Keep it tight — more trivia than
architecture. The `<article>` gives Pico's card styling; `<header>` and `<footer>` add structure.

**CSS:** The `.page-guide` class in `restraml-shared.css` provides all guide styling (summary font,
article sizing, `pre` left-border, `.behind-curtain` callout). No per-page CSS needed — just add
`class="page-guide"` to the `<details>` element.

**"Found a bug?" and README links** live inside the guide's `<footer>`, not as a standalone
section — keeps the page clean when the guide is collapsed.

### Pico CSS Semantic HTML Tricks — Quick Reference

These Pico v2 patterns are used across `docs/*.html` pages. Prefer these over `<div>` + classes:

| Element / Pattern | What Pico Does | Used For |
|---|---|---|
| `<article>` | Card with padding, border, rounded corners | Guide sections, callouts |
| `<article>` + `<header>` / `<footer>` | Card with distinct header/footer sections | Structured cards |
| `<details>` / `<summary>` | Native accordion, styled with arrow | Collapsible guide, TOC |
| `<details>` + `name="group"` | Exclusive accordion (only one open) | Grouped sections |
| `<summary role="button">` | Summary styled as a button | Prominent toggles |
| `<mark>` | Highlighted inline text (yellow/primary) | Key terms, toggle names |
| `<kbd>` | Keyboard-key styled inline | Package names, key combos |
| `<figure>` + `<figcaption>` | Captioned content block | Code examples with notes |
| `<ins>` / `<del>` | Green/red inline text | Showing diff semantics |
| `<hr>` inside `<article>` | Subtle section divider within a card | Separating guide topics |
| `role="switch"` on checkbox | Toggle switch appearance | Extra-packages, testing toggles |
| `<nav>` with `<ul>` | Horizontal flex layout | Controls bar, toolbar |

**Consistent switch labels:** When a `<nav>` has multiple `role="switch"` toggles, give the
`<nav>` an ID and apply `font-size: 0.88rem; font-style: italic` to all labels via CSS. Use
`<code>` (with `font-style: normal`) for technical terms within labels. Remove individual `<i>`
tags — let CSS handle italic consistently.

---

## Agentic AI — GitHub Copilot in GitHub Actions

This repository uses GitHub Copilot coding agents (running Claude Sonnet) triggered from GitHub
Issues and PRs. The following notes apply to any AI agent working on this repo:

### AGENTS.md
An `AGENTS.md` file exists at the repo root. It provides instructions specific to Copilot agents:
- Technology stack and constraints for this repo
- PR conventions
- Specific areas where agent work is expected

### Agent Work Patterns
- **Schema build fixes**: changes to `.github/workflows/*.yaml` to fix or improve the CI pipeline
- **Custom web views**: creating new `docs/*.html` pages based on GitHub Issue requests
- **CLAUDE.md / AGENTS.md updates**: keep these files current with any architectural changes

### GitHub Actions + Agent Interaction
- Agents commit to a branch and open PRs; the human reviews and merges.
- Build workflows are triggered by `auto.yaml` (daily cron) or `workflow_dispatch`.
- Agents must not break existing build workflows. Always validate YAML syntax before committing.
- The `GITHUB_TOKEN` available in Actions has write access to push to `main`; agents must not
  hardcode or leak this token.

---

### "A new RouterOS version was released, build it"
The `auto.yaml` workflow runs daily and handles this automatically. If you need to trigger it
manually, dispatch `auto.yaml` via `workflow_dispatch` with no inputs. Alternatively, dispatch
`manual-using-docker-in-docker.yaml` directly with the version string as `rosver`.

### "The build failed for version X"
1. Check the GitHub Actions logs for the failed workflow run
2. Common failures:
   - **Image download fails**: The CHR `.vdi.zip` couldn't be fetched — check if `download.mikrotik.com`
     and `cdn.mikrotik.com` both serve the version. Workflows try both with primary+fallback.
   - **`qemu-system-x86` install fails**: On Ubuntu, the apt package is `qemu-system-x86` (not
     `qemu-system-x86_64` — that's the binary name). Also install `qemu-utils` for `qemu-img`.
   - **Wait loop times out (5 min)**: CHR didn't boot — check `/tmp/qemu.log` in CI output for
     QEMU errors. Most likely KVM is unavailable or the image is corrupt.
   - **`rosver` output is empty**: The `bun rest2raml.js --version` step's output parsing failed;
     check the `xargs` command in the `connection-check` step

### "Add support for a new RouterOS version format"
RouterOS versions follow `MAJOR.MINOR[QUALIFIER]` where qualifier is one of:
- *(none)* — stable release, e.g. `7.22`
- `beta1`, `beta2`, ... — beta builds, on cdn.mikrotik.com
- `rc1`, `rc2`, ... — release candidates, on cdn.mikrotik.com

The download URL pattern is:
```
https://download.mikrotik.com/routeros/{version}/chr-{version}.vdi.zip   # stable
https://cdn.mikrotik.com/routeros/{version}/chr-{version}.vdi.zip        # beta/rc
```

### "Run rest2raml.js locally"
```sh
# Install Bun: https://bun.sh/
bun install
URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js

# Just get the RouterOS version:
URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js --version

# Generate schema for a subtree only:
URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js ip address

# Use a cached inspect.json (skip live router):
INSPECTFILE=./ros-inspect-all.json URLBASE=http://unused/rest BASICAUTH=x: bun rest2raml.js
```

### "Validate schemas"

```sh
# RAML validation (webapi-parser requires Node.js, not Bun)
node validraml.cjs ros-rest-all.raml

# OpenAPI 3.0 validation
bun run validate:openapi

# /app YAML schema validation (requires live CHR or just meta-validates schemas)
bun appyamlvalidate.js <version>
```

### "Run tests and lint"

```sh
bun test                       # Unit tests — no router needed; runs in CI
bun run test:ros-api           # ros-api-protocol integration + stress tests (local CHR)
bun run test:qemu              # deep-inspect integration tests (local CHR)
bun run test:benchmark         # REST vs native API timing benchmark (local CHR)
bun run lint                   # Biome lint + TypeScript type check
bun run lint:fix               # Auto-fix Biome issues
bun run typecheck              # TypeScript type check only
bun run deep-inspect           # Deep API tree inspection (single CHR via env vars)
bun run deep-inspect:multi-arch  # Per-arch enrichment via quickchr (x86 + arm64)
bun run deep-inspect:diff      # Diff two deep-inspect.<arch>.json files
```

**Per-arch enrichment** (`deep-inspect:multi-arch`) boots a fresh CHR per arch
via the `quickchr` library (`installAllPackages: true`), applies a p1 trial
license if MikroTik web credentials are available (env vars for CI,
Bun.secrets for local via `quickchr login`), runs `deep-inspect.ts --live`
as a subprocess, and writes `deep-inspect.<arch>.json` / `openapi.<arch>.json`
side-by-side. Exits nonzero per BACKLOG principle 3 if any arch has crash
paths or failed args — anomalies are the point, not something to tolerate.
See `BACKLOG.md` Phase 3 for the decision context and the first-run findings.

**Diff tool** (`deep-inspect:diff`) reports structural delta (paths only in
one arch), completion enum drift (same arg, different `_completion` keysets —
this is the bucket that surfaces real schema gaps), and a `_meta` side-by-side.
Does not merge, does not decide who is right; always exits 0. The text report
is the intended CI artifact once Phase 3.5 lands.

**Local CHR test scripts** (`test:ros-api`, `test:qemu`, `test:benchmark`) boot a RouterOS CHR
VM using [mikropkl](https://github.com/tikoci/mikropkl) machine directories searched in this order:
`~/Lab/mikropkl/Machines/`, `~/GitHub/mikropkl/Machines/`, or `$MIKROPKL_DIR/Machines/`.
You can also pass a machine path directly: `./scripts/test-ros-api.sh /path/to/machine.utm`.

> **Short-term limitation**: Integration scripts currently require a local mikropkl directory.
> The long-term goal is for `test:ros-api` and `test:qemu` to run in CI using the same
> QEMU+CHR+KVM infrastructure that the build workflows already use (see "CHR Boot Pattern" above).
> Contributions to add CI jobs are welcome.

**`test:ros-api` stress test** (`scripts/test-ros-api.sh`) is the regression canary for the
ghost-command bug where `writeAbortable()` without `/cancel` left 50 orphaned RouterOS commands
blocking the inspect queue. The stress test fires 50 concurrent `writeAbortable()` calls, aborts
half mid-flight, then probes the router — clean queue = &lt;5 s; ghost regression = ~60 s timeout.

---

## CI/CD Workflow Summary

| Workflow | Trigger | What it does |
|---|---|---|
| `auto.yaml` | Daily cron + manual | Checks all 4 RouterOS channels; per unique version, independently checks 4 artifacts (`schema.raml`, `extra/schema.raml`, `routeros-app-yaml-schema.json`, `extra/deep-inspect.x86.json`) and dispatches only the builds that are missing; outputs a step summary table. Accepts a `skip_versions` input (see below). |
| `manual-using-docker-in-docker.yaml` | Manual (`rosver` input) or `auto.yaml` | Installs QEMU, boots CHR, builds base schema, commits to `/docs/{version}/` |
| `manual-using-extra-docker-in-docker.yaml` | Manual (`rosver` input) or `auto.yaml` | Same as above + installs extra packages, commits to `/docs/{version}/extra/` |
| `appyamlschemas.yaml` | Manual (`rosver` input) or `auto.yaml` | Boots CHR with extra packages, validates /app YAML schemas (exit codes 0/1/2), commits `app.json` always; commits per-version schemas only on full pass (exit 0); files GitHub issue on exit 2 |
| `deep-inspect-multi-arch.yaml` | Manual (`rosver` input) or `auto.yaml` | Boots x86 (KVM) and arm64 (TCG) CHRs with extra packages in parallel, runs live deep-inspect crawl on each, diffs results, publishes `deep-inspect.{x86,arm64}.json` and `diff-deep-inspect.json` to `/docs/{version}/extra/` |
| `manual-from-secrets.yaml` | Manual | Builds using a real router via GitHub Secrets (no QEMU) |

All builds commit schema files to `main` as `github-actions[bot]` and publish via GitHub Pages.

### `auto.yaml` — `skip_versions` Input

`auto.yaml` accepts a `skip_versions` workflow_dispatch input (comma-separated list of RouterOS
version strings, e.g. `7.23beta5,7.23beta6`). Versions in this list are excluded from **all**
build types (base, extra-packages, /app YAML schemas, and deep-inspect multi-arch) for that run.

The default for the `workflow_dispatch` input is `7.23beta5`. When triggered by the daily
schedule (cron), the same default applies via an `||` fallback in the `env:` block.

**When to add a version to `skip_versions`:**
- A beta/RC version's built-in `/app` YAML collection contains entries that fail validation,
  and the failure is due to an upstream MikroTik bug (not a missing schema pattern) — so the
  correct action is to wait for MikroTik to fix their app YAML rather than relaxing the schema.
- Common upstream bugs: duplicate YAML mapping keys (invalid pure YAML, MikroTik parser is
  permissive); `[placeholder]` values parsed as YAML arrays instead of strings.
- In these cases `appyamlschemas.yaml` will keep returning exit code 2 → filing a new GitHub
  Issue on every daily run. Adding the version to `skip_versions` stops the retry loop while
  the issue remains open.

**How to update the skip list without a code change:**
Trigger `auto.yaml` via `workflow_dispatch` in the GitHub UI and set the `skip_versions`
input explicitly (for example, `7.23beta5,7.23rc3` to skip multiple versions). Leaving this
input blank does **not** clear the skip list; the workflow treats an empty value the same as
the default (`7.23beta5`) via the `||` fallback in `auto.yaml`, which is also what the daily
cron uses. To change the default skip list used by cron, update the `||` fallback in `auto.yaml`.

### Open Process Questions — /app YAML Schema Validation in CI

These questions are deliberately **unresolved** and tracked in GitHub Issues. Do not resolve them
unilaterally; flag them in code comments and issue discussions.

1. **Duplicate YAML keys**: RouterOS `/app` can ship built-in entries with duplicate YAML mapping
   keys (seen in `lorawan-stack` in 7.23beta5). Pure YAML parsers reject this; RouterOS's own
   parser is permissive (first or last key wins — unclear which). Should the schema (or the
   validator) relax the YAML parse to allow duplicates to match RouterOS behavior?

2. **Array-typed environment variables as placeholders**: `ROUTER_HOST: [routerIP]` is valid
   YAML (single-element array) but RouterOS treats it as a string placeholder. The current
   schema allows `string | number | boolean | null` for env var values but not arrays. Should
   YAML arrays be added as an allowed type for env vars, or is the better fix to ensure
   MikroTik uses quoted strings (`ROUTER_HOST: "[routerIP]"`)?

3. **Beta/RC schema coverage and `latest`**: Should `routeros-app-yaml-schema.latest.json`
   (the public URL) ever be updated based on syntax found only in beta/RC releases? Or should
   it track only stable releases? Currently there is no policy for this.

4. **Retry vs. skip policy**: When `appyamlschemas.yaml` exits with code 2 (live validation
   failed), `auto.yaml` retries the build on every daily run (because the schema file is
   missing). The `skip_versions` mechanism is a manual escape hatch. A future improvement
   could be an automatic "pause after N failures" mechanism.

5. **Schema file naming scheme**: The current `*.latest.json` / `*.editor.json` naming conflates
   two independent dimensions: **strictness** (strict for CI validation vs. relaxed for editor
   autocompletion — regex patterns in strict schemas block VSCode YAML extension completions)
   and **version scope** (stable-only vs. including beta/RC syntax). The original `*.dev.json`
   was intended for beta/RC but was replaced by `*.editor.json` to solve the completions problem.
   Now beta versions (e.g. 7.23beta4) sometimes introduce new `/app` YAML syntax that MikroTik
   may fix before stable release, creating CI churn (`skip_versions` workarounds) and
   `docs/tikapp.html` UI clutter with per-version schemas that may be identical. A cleaner
   scheme might separate the axes explicitly — e.g. `*.stable.strict.json`,
   `*.testing.editor.json` — but this needs careful thought about: which URLs are already
   published externally (`*.latest.json` is linked from SchemaStore, forums, VSCode configs),
   whether per-version schemas should only be generated for stable releases, and how to handle
   the transition without breaking existing consumers.

## Runtime and Tooling

- **Bun** is the primary runtime for all `.js` and `.ts` scripts. Use `bun` (not `node`) and
  `bun install` (not `npm install`). The only exception is `validraml.cjs` which requires Node.js
  for the `webapi-parser` package.
- **Biome** (v2.x) is the linter: `bun run lint` (`bunx @biomejs/biome check .`). Run this after
  modifying any `.js` or `.html` file and fix reported errors in your changed code before presenting
  changes. Auto-fix fixable issues with `bun run lint:fix`. Formatter and assist (import sorting)
  are intentionally disabled in `biome.json` — linting only, no automated reformatting. Do not
  add Prettier. `bun run lint` should produce **zero errors** on a clean checkout.
  **Biome overrides in `biome.json`** suppress pre-existing patterns in legacy code:
  - `docs/*.html`: Plausible analytics boilerplate (`noCommaOperator`, `noArguments`, etc.),
    Pico CSS `role="switch"` without static `aria-checked` (`useAriaPropsForRole`),
    `forEach` callbacks with implicit returns (`useIterableCallbackReturn`)
  - `rest2raml.js`: `noDoubleEquals` (string comparisons), `useLiteralKeys` (bracket notation
    for `"get"`), `useConst`/`noVar` (legacy style). Note: `noUnusedVariables` and
    `noUnusedFunctionParameters` are intentionally kept **on** — they catch real issues and
    provide valuable double-check discipline in agentic workflows
  - `appyamlvalidate.js`: `useLiteralKeys`
  - `docs/restraml-shared.js`: `noUnusedVariables` (exports consumed by other pages)
  Fix issues in any code you add or modify. Do not add new suppressions without justification.
- Dependencies are declared in `package.json` with `bun.lock`.
- **context7 MCP** is configured in `.mcp.json`. Use it to fetch up-to-date documentation for
  `bun`, `biome`, or any third-party CDN library rather than relying on training data. These
  tools evolve quickly — prefer context7 when uncertain about an API, CLI flag, or config schema.

---

## Things That Are Known-Broken or Incomplete

### Native API `/console/inspect` Completion Non-Determinism
RouterOS 7.22.1 (and likely all 7.x) returns non-deterministic results for `request=completion`
queries via the native API binary protocol. ~20-30% of calls randomly drop entries. REST is
unaffected. See `BACKLOG.md` Phase 2.9 and `docs/mikrotik-bug-native-api-inspect.md`.
**Workaround:** All CI uses `--transport rest` (now the default). `NativeRouterOSClient` and
`ros-api-protocol.ts` remain in the codebase for potential use if MikroTik fixes the bug.
Research test files (`benchmark.test.ts`, `native-api.test.ts`) and the experimental CI
workflow (`test-transport-equivalence.yaml`) were removed as part of the REST-only decision.

---

## Environment Variables

| Variable | Where set | Purpose |
|---|---|---|
| `URLBASE` | `.env`, workflow `env:` | Base URL for RouterOS REST API, e.g. `http://localhost:9180/rest` |
| `BASICAUTH` | `.env`, workflow `env:` | Credentials as `user:pass`, e.g. `admin:` (empty password) |
| `INSPECTFILE` | Optional, local | Path to pre-fetched inspect JSON — skips live router query |

---

## Dependencies

| Package | Used by | Purpose |
|---|---|---|
| `js-yaml` | `rest2raml.js`, `appyamlvalidate.js` (Bun) | Serialize RAML output as YAML; parse /app YAML for validation |
| `ajv` | `appyamlvalidate.js` (Bun) | JSON Schema validation (draft-07) for /app YAML schemas |
| `ajv-formats` | `appyamlvalidate.js` (Bun) | AJV plugin for format validators (uri, email, etc.) |
| `@apidevtools/swagger-parser` | `validate-openapi.ts` (Bun) | OpenAPI 3.0 schema validation |
| `bun-types` | TypeScript files (dev) | Bun API type definitions for TypeScript |
| `raml2html` | _(retired)_ | Previously generated HTML from RAML; replaced by OpenAPI 3 + API Explorer |
| `raml2html-slate-theme` | _(retired)_ | Previously used as raml2html theme |
| `webapi-parser` | `validraml.cjs` | RAML validation |
| `qemu-system-x86` | CI workflows (apt) | Runs RouterOS CHR VM (Ubuntu package; provides `qemu-system-x86_64` binary) |
| `qemu-utils` | CI workflows (apt) | Provides `qemu-img` for VDI→qcow2 disk conversion |
| `qemu-system-x86_64` | `Dockerfile.chr-qemu` (Alpine apk) | Runs RouterOS CHR VM in local Docker |
| `qemu-img` | `Dockerfile.chr-qemu` (Alpine apk) | Provides `qemu-img` for VDI→qcow2 conversion |
| `restraml-shared.js` | `docs/*.html` pages | Shared JS: version parsing, theme switcher, share modal, GitHub API fetch |
| `restraml-shared.css` | `docs/*.html` pages | Shared CSS: fonts, logo swap, theme icon, page-guide, share-modal, utility classes |
