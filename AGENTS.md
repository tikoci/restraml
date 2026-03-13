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

### Schema Generation
- `rest2raml.js` runs under **Bun** (not Node.js). Uses `Bun.argv` for CLI args.
- `validraml.cjs` runs under **Node.js 18**.
- `appyamlvalidate.js` runs under **Bun**. Validates /app YAML schemas and live /app entries.
- `URLBASE` and `BASICAUTH` env vars configure the RouterOS REST API connection.

### /app YAML Schema Files (`docs/`)
RouterOS 7.22+ includes `/app` — a `docker-compose`-lite YAML format for custom container apps.
The schema files in `docs/` validate this format:

- **`routeros-app-yaml-schema.latest.json`** — stable public URL, linked externally. **Do not rename.**
- **`routeros-app-yaml-schema.dev.json`** — dev/testing version. **Do not rename.**
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

### Create a custom docs page (from a GitHub Issue)
1. Read the issue for the desired feature/view.
2. Create `docs/{custom-name}.html` following the web page conventions above.
3. Use `docs/index.html` as a reference for patterns (GitHub API fetch, Pico CSS, dark mode, etc.).
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
| `Dockerfile.chr-qemu` | Local dev: RouterOS CHR in QEMU via Docker |
| `scripts/entrypoint.sh` | QEMU launcher for local Docker use |
| `docs/index.html` | Main GitHub Pages SPA (reference for new pages) |
| `docs/lookup.html` | RouterOS command search tool — fully event-driven, no submit buttons |
| `docs/routeros-app-yaml-schema.latest.json` | /app YAML schema — stable public URL, do not rename |
| `docs/routeros-app-yaml-schema.dev.json` | /app YAML schema — dev/testing, do not rename |
| `docs/routeros-app-yaml-store-schema.latest.json` | /app store schema — do not rename |
| `.github/workflows/auto.yaml` | Daily cron: detect new RouterOS versions, trigger builds |
| `.github/workflows/manual-using-docker-in-docker.yaml` | Build: base RouterOS schema |
| `.github/workflows/manual-using-extra-docker-in-docker.yaml` | Build: schema + extra packages |
| `.github/workflows/appyamlschemas.yaml` | Build: validate and publish /app YAML schemas per-version |
| `.github/workflows/manual-from-secrets.yaml` | Build: using a real RouterOS device |
| `CLAUDE.md` | Full architecture guide for AI agents |
| `AGENTS.md` | This file — Copilot agent-specific instructions |
