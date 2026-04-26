# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/restraml/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include the affected files or workflow, reproduction details, and impact. If the issue affects generated `docs/` content, name the source file or workflow that produced it. Initial response within a few business days; fixes land on `main` and flow into regenerated published artifacts from there.

## Scope

restraml generates RouterOS REST API schemas in CI by booting a CHR VM under QEMU on the GitHub Actions runner, querying its `/console/inspect` endpoint, and committing the output to `docs/<version>/`. Runtime-relevant pieces:

- CI workflows hold a `GITHUB_TOKEN` with write access to `main` and push generated schema files as `github-actions[bot]`.
- `manual-from-secrets.yaml` connects to a real router via repository secrets; all other workflows use a transient QEMU CHR.
- `docs/*.html` pages are static client-side SPAs (Pico CSS, vanilla JS, no backend); they call MikroTik public endpoints and the GitHub API from the user's browser.

## Code scanning

The repository's [Security tab](https://github.com/tikoci/restraml/security) is the live source of current alerts and advisories. This section describes *what* runs and *why*.

- **CodeQL** — repo-managed workflow at [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) with config [`.github/codeql/codeql-config.yml`](.github/codeql/codeql-config.yml). Query suite: `security-and-quality` (security-extended + code-quality). Languages: `javascript-typescript`, `actions`. Schedule: push to `main`, pull requests to `main`, weekly cron.
- **Code Quality (AI findings, preview)** — enabled. AI findings are noisy and self-contradicting; we accept the noise because the second-opinion catches real issues that the static suite misses. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract.
- **Dependency review** — [`.github/workflows/dependency-review.yml`](.github/workflows/dependency-review.yml), `fail-on-severity: high` on pull requests.
- **Dependabot security updates** — enabled.
- **Secret scanning** — enabled, with push protection.
- **Private vulnerability reporting** — enabled.

The CodeQL config sets `paths-ignore: docs/*/**` so generated, versioned schema snapshots don't drown the alert list — the maintained top-level `docs/*.html` pages are still scanned.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| Published `docs/` snapshots | Best effort via regeneration from `main` |
