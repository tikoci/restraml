# GitHub Copilot Instructions

> This file provides context for GitHub Copilot chat and coding suggestions.
> For the full architecture guide intended for AI agents, see [CLAUDE.md](../CLAUDE.md) at the repo root.

## Project Summary

This repository (`restraml`) generates RAML 1.0 and OpenAPI 2.0 API schemas for the
[MikroTik RouterOS](https://mikrotik.com/) REST API. Schemas are built by spinning up a
RouterOS CHR (Cloud Hosted Router) VM in QEMU inside Docker, querying its `/console/inspect`
REST endpoint, and converting the result to RAML/OAS.

Generated schemas are published to https://tikoci.github.io/restraml via GitHub Pages from
the `/docs/` directory in this repository.

## Key Files

- **`rest2raml.js`** — Main schema generator (runs under Bun, not Node.js)
- **`raml2oas.cjs`** — Converts RAML 1.0 → OAS 2.0
- **`validraml.cjs`** — Validates RAML 1.0 using webapi-parser
- **`Dockerfile.chr-qemu`** — Alpine image that runs RouterOS CHR in QEMU
- **`docs/`** — Published schema files, one subdirectory per RouterOS version

## Critical Patterns

- `rest2raml.js` uses `Bun.argv` (not `process.argv`) — it **must** run under `bun`, not `node`
- RouterOS env vars: `URLBASE=http://.../rest` and `BASICAUTH=user:pass`
- **Stable** RouterOS releases (e.g. `7.22`) are on `download.mikrotik.com`; **beta/rc** (e.g. `7.22rc2`) are on `cdn.mikrotik.com` — the Dockerfile handles both with a primary+fallback wget
- A version is considered "built" when `docs/{version}/schema.raml` exists
- `auto.yaml` runs daily and checks MikroTik's `NEWESTa7.{stable,testing,development,long-term}` channels

## Running Locally

```sh
# Install Bun: https://bun.sh
bun install js-yaml
URLBASE=http://<router-ip>/rest BASICAUTH=admin: bun rest2raml.js
```
