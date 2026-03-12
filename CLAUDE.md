# CLAUDE.md — AI Agent Guide for restraml

> This file is written for future AI coding agents (Copilot, Claude, etc.) working on this repository.
> It explains the architecture, key patterns, common tasks, and critical gotchas so you can be
> productive immediately without extensive archaeology of the codebase.

## What This Repository Does

**restraml** generates API schema documentation for the [MikroTik RouterOS](https://mikrotik.com/) REST API.

The pipeline is:
1. Boot a RouterOS CHR (Cloud Hosted Router) directly in QEMU on the GitHub Actions runner
2. Query the router's `/console/inspect` REST endpoint to extract the full command/API tree
3. Convert that tree to [RAML 1.0](https://raml.org/) schema format
4. Convert RAML → OpenAPI 2.0 (OAS2)
5. Generate an HTML reference page from RAML
6. Commit everything to `/docs/` and publish via GitHub Pages

The generated schemas live at https://tikoci.github.io/restraml — with per-version folders in `/docs/`.

---

## Repository Layout

```
restraml/
├── rest2raml.js          # Main script: connects to RouterOS REST API → RAML 1.0
├── raml2oas.cjs          # Converts RAML 1.0 → OAS 2.0 (uses webapi-parser)
├── validraml.cjs         # Validates RAML 1.0 (uses webapi-parser)
├── Dockerfile.chr-qemu   # Alpine image that runs RouterOS CHR in QEMU (for local use)
├── scripts/
│   └── entrypoint.sh     # QEMU launcher used by Dockerfile.chr-qemu (user-mode networking)
├── .env                  # Local dev env vars (URLBASE, BASICAUTH) — not committed secrets
├── docs/                 # GitHub Pages root; one subdirectory per RouterOS version
│   ├── {version}/
│   │   ├── schema.raml   # RAML 1.0 schema (presence = "this version is built")
│   │   ├── inspect.json  # Raw /console/inspect output from RouterOS
│   │   ├── oas2.json     # OpenAPI 2.0 schema
│   │   └── docs/
│   │       └── index.html  # Generated HTML documentation
│   └── {version}/extra/  # Same files, but built with all_packages (extra features)
└── .github/
    └── workflows/
        ├── auto.yaml                            # Daily cron: detect new versions, trigger builds
        ├── manual-using-docker-in-docker.yaml   # Build: base RouterOS schema
        └── manual-using-extra-docker-in-docker.yaml  # Build: schema with extra packages
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

### RouterOS Image Download — Critical Gotcha
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

### Two Build Variants
- **Base** (`manual-using-docker-in-docker.yaml`): base RouterOS only
- **Extra** (`manual-using-extra-docker-in-docker.yaml`): all_packages including container, iot, zerotier, etc.
  - Extra packages are downloaded separately from `download.mikrotik.com/routeros/{ver}/all_packages-x86-{ver}.zip`
  - Uploaded to CHR root via SCP, then CHR is rebooted to activate them

### CHR Boot Pattern — Direct QEMU on GitHub Runner
CI workflows run RouterOS CHR **directly in QEMU on the ubuntu-latest runner** (no Docker-in-Docker,
no docker-compose). The key steps are:

1. Install `qemu-system-x86_64` via apt
2. Enable KVM via udev rules (`/dev/kvm` is available on GitHub hosted runners)
3. Download the CHR `.vdi` image (primary: `download.mikrotik.com`, fallback: `cdn.mikrotik.com`)
4. Launch QEMU in background with user-mode networking and port forwarding:
   - host:9180 → VM:80 (RouterOS REST API)
   - host:9122 → VM:22 (RouterOS SSH, used for SCP in extra-packages workflow)
5. Wait up to **5 minutes** (30 × 10s) for the API to respond — fail fast if not up in time
6. Cleanup: `kill` the QEMU PID stored in `/tmp/qemu.pid`

**KVM is critical for performance** — without it CHR boots very slowly in software emulation.
If the wait loop times out, check `/tmp/qemu.log` in the artifact or CI logs for QEMU errors.

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
docs/{rosver}/{schema.raml,inspect.json,oas2.json}
docs/{rosver}/docs/index.html
docs/{rosver}/extra/{schema.raml,...}   # extra-packages build only
```

---

## Common Tasks for AI Agents

### "A new RouterOS version was released, build it"
The `auto.yaml` workflow runs daily and handles this automatically. If you need to trigger it
manually, dispatch `auto.yaml` via `workflow_dispatch` with no inputs. Alternatively, dispatch
`manual-using-docker-in-docker.yaml` directly with the version string as `rosver`.

### "The build failed for version X"
1. Check the GitHub Actions logs for the failed workflow run
2. Common failures:
   - **Image download fails**: The CHR `.vdi.zip` couldn't be fetched — check if `download.mikrotik.com`
     and `cdn.mikrotik.com` both serve the version. Workflows try both with primary+fallback.
   - **Wait loop times out (5 min)**: CHR didn't boot — check `/tmp/qemu.log` in CI output for
     QEMU errors. Most likely KVM is unavailable or the image is corrupt.
   - **`rosver` output is empty**: The `bun rest2raml.js --version` step's output parsing failed;
     check the `xargs` command in the `connection-check` step
   - **`cp ros-oas2*.json` fails**: `raml2oas.cjs` produces `ros-oas20.json`, not `ros-oas2*.json`

### "Add support for a new RouterOS version format"
RouterOS versions follow `MAJOR.MINOR[QUALIFIER]` where qualifier is one of:
- _(none)_ — stable release, e.g. `7.22`
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
bun install js-yaml
URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js

# Just get the RouterOS version:
URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js --version

# Generate schema for a subtree only:
URLBASE=http://192.168.88.1/rest BASICAUTH=admin: bun rest2raml.js ip address

# Use a cached inspect.json (skip live router):
INSPECTFILE=./ros-inspect-all.json URLBASE=http://unused/rest BASICAUTH=x: bun rest2raml.js
```

### "Validate or convert the generated RAML"
```sh
npm install webapi-parser
node validraml.cjs ros-rest-all.raml
node raml2oas.cjs ros-rest-all.raml
```

---

## CI/CD Workflow Summary

| Workflow | Trigger | What it does |
|---|---|---|
| `auto.yaml` | Daily cron + manual | Checks all 4 RouterOS channels, dispatches builds for new versions |
| `manual-using-docker-in-docker.yaml` | Manual (`rosver` input) or `auto.yaml` | Installs QEMU, boots CHR, builds base schema, commits to `/docs/{version}/` |
| `manual-using-extra-docker-in-docker.yaml` | Manual (`rosver` input) or `auto.yaml` | Same as above + installs extra packages, commits to `/docs/{version}/extra/` |
| `manual-from-secrets.yaml` | Manual | Builds using a real router via GitHub Secrets (no QEMU) |

All builds commit schema files to `main` as `github-actions[bot]` and publish via GitHub Pages.

---

## Things That Are Known-Broken or Incomplete

- `--validate` flag in `rest2raml.js` is not implemented (TODO in code)
- OAS 3.0 (`oas30`) generation is commented out in `raml2oas.cjs` — it generates output but
  has 3000+ validation errors; use OAS 2.0 instead
- `webapi-parser` is installed twice in some workflows (once for validate, once for convert)
  — harmless but redundant
- The `manual-from-secrets.yaml` workflow uses `ros-rest-generated.html` not `index.html`
  and doesn't produce `oas2.json`, so it's not fully consistent with the QEMU-based workflows

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
| `js-yaml` | `rest2raml.js` (Bun) | Serialize RAML output as YAML |
| `raml2html` | CI workflows | Generate HTML from RAML |
| `raml2html-slate-theme` | CI workflows | Slate theme for raml2html |
| `webapi-parser` | `validraml.cjs`, `raml2oas.cjs` | RAML validation and OAS conversion |
| `qemu-system-x86_64` | CI workflows (apt), `Dockerfile.chr-qemu` | Runs RouterOS CHR VM |
