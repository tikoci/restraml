# AGENTS.md — GitHub Copilot Agent Instructions for restraml

> This file provides instructions for GitHub Copilot coding agents (Claude Sonnet) working on
> this repository via GitHub Actions. For the full architecture reference, see `CLAUDE.md`.

## What This Repository Does

**restraml** auto-generates RAML 1.0 and OpenAPI 2.0 schemas for the MikroTik RouterOS REST API
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
- `raml2oas.cjs` and `validraml.cjs` run under **Node.js 18**.
- `URLBASE` and `BASICAUTH` env vars configure the RouterOS REST API connection.

### Web Pages (`docs/`)
All pages in `docs/` are static HTML files served by GitHub Pages. Rules:
- **Pico CSS** (`@picocss/pico@2`) — only CSS framework allowed.
- **JetBrains Mono** — required font. Can be used creatively for visual effects.
- **Semantic HTML** — use proper elements (`<header>`, `<main>`, `<section>`, etc.).
- **No web frameworks** — no React, Vue, Svelte, etc. Vanilla JavaScript only.
- **Client-side SPA** — no backend, no server-side code. GitHub Pages is static hosting only.
- **GitHub API/GraphQL** — use for dynamic data (version lists, schema contents, inspect JSON).
- **Single `.html` file** — keep JS inline unless there is a very strong reason for separation.
- **Minimal CDN dependencies** — only add libraries that meaningfully solve a problem.

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
4. Link back to `docs/index.html` for navigation.
5. Keep all JS in the single HTML file.

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
| `raml2oas.cjs` | RAML → OAS 2.0 converter (Node.js) |
| `validraml.cjs` | RAML 1.0 validator (Node.js) |
| `Dockerfile.chr-qemu` | Local dev: RouterOS CHR in QEMU via Docker |
| `scripts/entrypoint.sh` | QEMU launcher for local Docker use |
| `docs/index.html` | Main GitHub Pages SPA (reference for new pages) |
| `.github/workflows/auto.yaml` | Daily cron: detect new RouterOS versions, trigger builds |
| `.github/workflows/manual-using-docker-in-docker.yaml` | Build: base RouterOS schema |
| `.github/workflows/manual-using-extra-docker-in-docker.yaml` | Build: schema + extra packages |
| `.github/workflows/manual-from-secrets.yaml` | Build: using a real RouterOS device |
| `CLAUDE.md` | Full architecture guide for AI agents |
| `AGENTS.md` | This file — Copilot agent-specific instructions |
