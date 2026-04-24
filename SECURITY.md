# Security Policy

## Supported Versions

Security fixes are made on `main` and flow into regenerated published artifacts from there.

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| Published `docs/` snapshots | Best effort via regeneration from `main` |

## Reporting a Vulnerability

Please use GitHub's **Private vulnerability reporting** / **Security Advisories** for this repository.

- Do **not** open a public GitHub issue for an undisclosed vulnerability.
- Include the affected files or workflows, reproduction details, impact, and any mitigations you know about.
- If the issue affects generated `docs/` content, report the source file or workflow that produced it when possible.

We will review reports, validate impact, and fix them on `main` before regenerating any affected published artifacts.
