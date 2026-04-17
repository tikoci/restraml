# AGENTS.md — GitHub Copilot Agent Instructions for restraml

> This file provides instructions for GitHub Copilot coding agents (Claude Sonnet) working on
> this repository via GitHub Actions. For the full architecture reference, see `CLAUDE.md`.

## What This Repository Does

**restraml** auto-generates RAML 1.0 schemas for the MikroTik RouterOS REST API
by booting RouterOS CHR in QEMU on GitHub Actions runners, querying its `/console/inspect` endpoint,
and publishing the results to GitHub Pages at https://tikoci.github.io/restraml.

---

## Agent Ground Rules

1. **Read `CLAUDE.md` first** — it has the full architecture, gotchas, and common task guides.
2. **Make the smallest possible change** that fully addresses the issue or PR feedback.
3. **Do not break existing build workflows** — validate YAML syntax before committing.
4. **Do not commit secrets** — never hardcode tokens, passwords, or credentials.
5. **No new dependencies unless necessary** — prefer built-in tools and existing CDN libraries.

---

## Technology Constraints

### GitHub Actions Workflows (`.github/workflows/`)
- Workflows run on `ubuntu-latest` GitHub-hosted runners with KVM available.
- RouterOS CHR runs in QEMU (direct, not Docker-in-Docker). See `CLAUDE.md` for CHR boot details.
- Git operations that push to `main` **must** use the retry-with-rebase pattern to handle
  concurrent builds (see `CLAUDE.md` → "Concurrent Build Push — Retry Pattern").
- The apt package for QEMU is `qemu-system-x86` (not `qemu-system-x86_64`); also install
  `qemu-utils` for `qemu-img`.

### Testing

- `bun test` runs all `*.test.ts` files — **no router or QEMU needed**, runs in CI.
  After modifying `.ts` files, run `bun test` to confirm all unit tests pass.
- Integration + stress tests require a local [mikropkl](https://github.com/tikoci/mikropkl) CHR machine:
  - `bun run test:ros-api` (`scripts/test-ros-api.sh`) — wire protocol unit + integration + 50-concurrent
    cancel stress test against live RouterOS CHR. The post-batch probe is the regression canary for the
    ghost-command bug (unissued `/cancel` → 60 s queue stall).
  - `bun run test:qemu` (`scripts/test-with-qemu.sh`) — `deep-inspect` integration tests.
  - `bun run test:benchmark` (`scripts/benchmark-qemu.sh`) — REST vs native API timing benchmark.
- **Short-term limitation**: Integration scripts resolve mikropkl machines from
  `~/Lab/mikropkl/Machines/` or `~/GitHub/mikropkl/Machines/` (or `MIKROPKL_DIR`).
  This is a local convenience — the long-term goal is for `test:ros-api` and `test:qemu` to run
  in CI using the same QEMU+CHR+KVM infrastructure already used by the build workflows.
  **Do not rely on local machine paths in new code; contribute CI jobs instead.**

### Testing

- `bun test` runs all `*.test.ts` files — **no router or QEMU needed**, runs in CI.
  After modifying `.ts` files, run `bun test` to confirm all unit tests pass.
- Integration + stress tests require a local [mikropkl](https://github.com/tikoci/mikropkl) CHR machine:
  - `bun run test:ros-api` (`scripts/test-ros-api.sh`) — wire protocol unit + integration + 50-concurrent
    cancel stress test against live RouterOS CHR. The post-batch probe is the regression canary for the
    ghost-command bug (unissued `/cancel` → 60 s queue stall).
  - `bun run test:qemu` (`scripts/test-with-qemu.sh`) — `deep-inspect` integration tests.
  - `bun run test:benchmark` (`scripts/benchmark-qemu.sh`) — REST vs native API timing benchmark.
- **Short-term limitation**: Integration scripts resolve mikropkl machines from
  `~/Lab/mikropkl/Machines/` or `~/GitHub/mikropkl/Machines/` (or `MIKROPKL_DIR`).
  This is a local convenience — the long-term goal is for `test:ros-api` and `test:qemu` to run
  in CI using the same QEMU+CHR+KVM infrastructure already used by the build workflows.
  **Do not rely on local machine paths in new code; contribute CI jobs instead.**

### Linting

- **Biome** (v2.x) is the linter for all `.js` and `docs/*.html` files. Run `bun run lint` after
  modifying any `.js` or `.html` file. Fix all reported errors before committing. Auto-fix: `bun run lint:fix`.
- Formatter is disabled — biome is used for code quality checks only, not formatting.
- Do not add Prettier or any other formatter/linter.

### Documentation / context7

- A **context7 MCP server** is configured in `.mcp.json`. Use it to look up current docs for
  `bun`, `biome`, or any CDN library (Monaco, Ajv, js-yaml, Pico CSS, diff2html, etc.) instead
  of guessing from training data. Example: `use context7 to look up bun Bun.file API`.
- Prefer context7 over WebFetch for library documentation — it returns structured, version-aware
  content that's more reliable for API/config questions.

---

### Schema Generation
- `rest2raml.js` runs under **Bun** (not Node.js). Uses `Bun.argv` for CLI args.
- `validraml.cjs` runs under **Node.js 18**.
- `appyamlvalidate.js` runs under **Bun**. Validates /app YAML schemas and live /app entries.
- `deep-inspect.ts` runs under **Bun**. Enriches inspect trees with completion data. Uses REST transport.
- `URLBASE` and `BASICAUTH` env vars configure the RouterOS REST API connection.

### ⚠️ Native API Transport — REST Only for Schema Generation
All schema generation uses the REST API. The native API (`--transport native`) is NOT used in CI
due to a RouterOS bug where `/console/inspect` with `request=completion` returns non-deterministic
results via the native protocol (~20-30% of calls randomly drop entries). REST is 100% deterministic.
**Do not change CI workflows to `--transport native`.** See `CLAUDE.md` and `BACKLOG.md` Phase 2.9
for full details. `ros-api-protocol.ts` and `NativeRouterOSClient` remain for potential future use
if MikroTik fixes the bug; `benchmark.test.ts` and `native-api.test.ts` were removed (research artifacts)
and `test-transport-equivalence.yaml` was deleted (proven moot). `--transport rest` is the default.

### /app YAML Schema Files (`docs/`)
RouterOS 7.22+ includes `/app` — a `docker-compose`-lite YAML format for custom container apps.
The schema files in `docs/` validate this format:

- **`routeros-app-yaml-schema.latest.json`** — stable public URL, linked externally. **Do not rename.**
- **`routeros-app-yaml-schema.editor.json`** — relaxed variant for editor autocompletion (SchemaStore). **Do not rename.**
- **`routeros-app-yaml-store-schema.latest.json`** — schema for `app-store-urls=` arrays. **Do not rename.**
- **`{version}/routeros-app-yaml-schema.json`** — per-version schema (version-specific `$id`)
- **`{version}/routeros-app-yaml-store-schema.json`** — per-version store schema

Per-version schemas reference each other (store → single) using version-specific `$id` URLs.
The `appyamlschemas.yaml` workflow generates and validates them using `appyamlvalidate.js`.

**VSCode / Editor notes:**
- The schemas work with the [RedHat YAML VSCode extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml).
- Strict `pattern` regex in the schema prevents VSCode autocompletion. 
- The schemas may be submitted to [SchemaStore](https://www.schemastore.org) — which auto-applies
  schemas to matching filenames in editors like VSCode. Ensure `$id`, `$schema`, and `title` are
  correct before submitting.
- More detail on the /app YAML format: https://forum.mikrotik.com/t/amm0s-manual-for-custom-app-containers-7-22beta/268036/22

### Web Pages (`docs/`)
All pages in `docs/` are static HTML files served by GitHub Pages. Rules:

> **Dark mode, diff2html gotchas, Tools nav dropdown, shareable URL, and Share modal patterns are documented in `CLAUDE.md`**
> under the relevant sections. Read those sections before touching dark mode logic, adding diff rendering,
> adding query string support, or creating new pages.
- **Pico CSS** (`@picocss/pico@2`) — only CSS framework allowed.
- **JetBrains Mono + Manrope** — required fonts for all pages. Both must be loaded via Google Fonts.
- **Semantic HTML** — use proper elements (`<header>`, `<main>`, `<section>`, etc.).
- **No web frameworks** — no React, Vue, Svelte, etc. Vanilla JavaScript only.
- **Avoid submit buttons** — use JS event listeners (`input`, `change`, `keydown`) instead of
  explicit submit/lookup buttons. Debounce text input (~400 ms); fire immediately on `change`
  events for checkboxes and selects. See `docs/lookup.html` for the canonical example.
- **Client-side SPA** — no backend, no server-side code. GitHub Pages is static hosting only.
- **GitHub API/GraphQL** — use for dynamic data (version lists, schema contents, inspect JSON).
- **Single `.html` file** — keep JS inline unless there is a very strong reason for separation.
- **`restraml-shared.css`** — all pages load shared CSS (fonts, logo swap, theme icon, page-guide,
  share-modal, utility classes) via `<link rel="stylesheet" href="restraml-shared.css">` after
  Pico CSS and before page `<style>`. Shared visual patterns go here, not inline.
- **`restraml-shared.js`** — all pages load shared utilities (version parsing, theme switcher,
  share modal, GitHub API fetch) via `<script src="restraml-shared.js"></script>`. Modify shared
  behavior in this file, not inline. New pages must include this script.
- **Minimal CDN dependencies** — only add libraries that meaningfully solve a problem.
- **Tools nav dropdown** — every page must include the shared Tools `<details class="dropdown">` in the nav.
  When adding a new tool page, update the dropdown in `index.html`, `lookup.html`, and `diff.html` too.
- **Shareable URLs** — use `history.replaceState()` to keep the URL current as the user interacts.
  Read query params after the async version list loads (so `<select>` options exist). See `CLAUDE.md`
  for the full parameter list per page.
- **Share modal** — use `<dialog>` with `showModal()` / `close()`. Show URL + copy button.
  See `diff.html` or `lookup.html` for the canonical implementation.

---

## Common Agent Tasks

### Fix a failing build workflow
1. Use GitHub MCP tools to get the failed job logs (`get_job_logs`).
2. Identify the failing step and error message.
3. Fix the workflow YAML or the referenced script.
4. Validate YAML syntax locally if possible.
5. **Read `BACKLOG.md` and `CLAUDE.md` → "CI Anti-Patterns" before changing timeouts or
   adding workarounds.** Never increase a timeout without first understanding why the step is
   slow. Never skip a crawl or enrichment step to make a build "pass".
6. **For `deep-inspect-multi-arch.yaml`:** The ARM64 job now works under both KVM and TCG.
   The previous failures were caused by insufficient RAM (256 MB → 1024 MB fix). See
   `CLAUDE.md` → "ARM64 CI (RESOLVED)" for measured timings and implementation details.

### Create a custom docs page (from a GitHub Issue)
1. Read the issue for the desired feature/view.
2. Create `docs/{custom-name}.html` following the web page conventions above.
3. Include `<link rel="stylesheet" href="restraml-shared.css">` (after Pico CSS, before page `<style>`) and `<script src="restraml-shared.js"></script>`. Call `initThemeSwitcher()` and optionally `initShareModal({...})`. Use `fetchVersionList()` and `RESTRAML.pagesUrl` from the shared utilities. See `docs/index.html` as a reference for page-specific patterns.
4. Add the shared **Tools nav dropdown** to the new page (see `CLAUDE.md` → "Tools Nav Dropdown").
5. Also add the new page to the dropdown list in `index.html`, `lookup.html`, and `diff.html`.
6. Keep all JS in the single HTML file.

### Update /app YAML schema
1. Edit `docs/routeros-app-yaml-schema.latest.json` for the single /app schema.
2. Edit `docs/routeros-app-yaml-store-schema.latest.json` for the store schema.
3. Run `bun install js-yaml ajv ajv-formats` then `bun appyamlvalidate.js <version>` to validate.
4. If testing against a live router: `URLBASE=http://<ip>/rest BASICAUTH=admin: bun appyamlvalidate.js <version>`
5. Per-version files (`docs/{version}/routeros-app-yaml-schema.json`) are regenerated automatically
   by the `appyamlschemas.yaml` workflow when schemas change.

### Update schema generation
1. Edit `rest2raml.js` — runs under Bun, not Node.js.
2. Test locally: `URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js`
3. Use `INSPECTFILE` env var to test with a cached inspect JSON (offline testing).

### Update CLAUDE.md / AGENTS.md
- Keep these files current with any architectural changes you make.
- After fixing a known bug or adding a new pattern, add a note under the appropriate section.

---

## PR Conventions

- Branch naming: `copilot/{short-description}` (auto-created by GitHub Copilot agent).
- Commit messages: imperative mood, short, descriptive (e.g., "Fix concurrent push race condition").
- PR description: include a checklist of changes made.
- Do not modify unrelated files or fix unrelated issues.

---

## Key File Reference

| File | Purpose |
|---|---|
| `rest2raml.js` | Main schema generator (Bun runtime) |
| `validraml.cjs` | RAML 1.0 validator (Node.js) |
| `appyamlvalidate.js` | /app YAML schema validator and per-version schema generator (Bun) |
| `deep-inspect.ts` | Crawls live CHR + enriches with completion data → deep-inspect.json / openapi.json (Bun) |
| `ros-api-protocol.ts` | Vendored RouterOS native API wire protocol (Bun) |
| `ros-api-protocol.test.ts` | Unit + integration + stress tests for `ros-api-protocol.ts` |
| `Dockerfile.chr-qemu` | Local dev: RouterOS CHR in QEMU via Docker |
| `scripts/entrypoint.sh` | QEMU launcher for local Docker use |
| `scripts/test-with-qemu.sh` | Integration tests (deep-inspect) against local QEMU CHR |
| `scripts/test-ros-api.sh` | Integration + stress tests (ros-api-protocol) against local CHR |
| `scripts/benchmark-qemu.sh` | REST vs native API timing benchmark against local CHR |
| `scripts/deep-inspect-multi-arch.ts` | Per-arch deep-inspect orchestrator (quickchr, x86 + arm64) |
| `scripts/diff-deep-inspect.ts` | Diff two deep-inspect.<arch>.json files (enum drift + path delta) |
| `docs/index.html` | Main GitHub Pages SPA (reference for new pages) |
| `docs/lookup.html` | RouterOS command search tool — fully event-driven, no submit buttons |
| `docs/routeros-app-yaml-schema.latest.json` | /app YAML schema — stable public URL, do not rename |
| `docs/routeros-app-yaml-store-schema.latest.json` | /app store schema — do not rename |
| `.github/workflows/auto.yaml` | Daily cron: detect new RouterOS versions, trigger builds |
| `.github/workflows/manual-using-docker-in-docker.yaml` | Build: base RouterOS schema |
| `.github/workflows/manual-using-extra-docker-in-docker.yaml` | Build: schema + extra packages |
| `.github/workflows/appyamlschemas.yaml` | Build: validate and publish /app YAML schemas per-version |
| `.github/workflows/deep-inspect-multi-arch.yaml` | Build: per-arch deep-inspect (x86 KVM + arm64 TCG) with diff |
| `.github/workflows/manual-from-secrets.yaml` | Build: using a real RouterOS device |
| `docs/restraml-shared.js` | Shared JS utilities for all tool pages (version parsing, theme, share modal) |
| `docs/restraml-shared.css` | Shared CSS for all tool pages (fonts, logo, theme, guide, modal, utilities) |
| `CLAUDE.md` | Full architecture guide for AI agents |
| `AGENTS.md` | This file — Copilot agent-specific instructions |
