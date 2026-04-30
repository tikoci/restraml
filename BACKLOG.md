# BACKLOG.md — actionable queue

This file tracks work that is still worth doing. It should stay short enough to
work top-to-bottom without re-reading shipped implementation history.

Reference material lives elsewhere:

- Deep-inspect design, shipped Phase 3 notes, ARM64 CI baselines, and CI
  postmortem: [`docs/deep-inspect.md`](docs/deep-inspect.md)
- Native API `/console/inspect request=completion` bug report:
  [`docs/mikrotik-bug-native-api-inspect.md`](docs/mikrotik-bug-native-api-inspect.md)
- Agent operating rules and CI anti-patterns: [`CLAUDE.md`](CLAUDE.md) and
  [`AGENTS.md`](AGENTS.md)

## Guardrails for every task

These are intentionally repeated here because they affect future backlog work:

1. **Do not change `docs/{version}/inspect.json` shape as a side effect.**
   It is consumed by rosetta, lsp-routeros-ts, the HTML tools in `docs/`, and
   possibly external users. Any shape change needs its own explicit task.
2. **Deep-inspect production builds crawl live CHR instances.** Do not derive
   `deep-inspect.*.json` from `inspect.json` in CI. `--inspect-file` is only a
   developer/offline helper.
3. **Crawl failures are signals.** Crash paths, failed args, and missing paths
   should stop the build and be investigated, not skipped to make CI green.
4. **Keep per-arch outputs before merging.** `deep-inspect.x86.json` and
   `deep-inspect.arm64.json` remain independently published until a merge policy
   is designed and validated.

## Active tasks

### P1 — Backfill deep-inspect artifacts for supported channels

**Why:** `deep-inspect.{x86,arm64}.json` is now produced by CI for new builds,
but older/current supported releases need consistent artifacts for downstream
importers.

**Scope:**

- Regenerate `deep-inspect.x86.json`, `deep-inspect.arm64.json`,
  `openapi.x86.json`, `openapi.arm64.json`, and `diff-deep-inspect.json` under
  `docs/{version}/extra/`.
- Cover all current RouterOS channels, back to at least the current long-term
  release.
- Prioritize development → stable → long-term → testing unless a release is
  known-broken upstream.

**Acceptance criteria:**

- Each backfilled version has both per-arch deep-inspect files and a diff report.
- CI or workflow logs show extra packages installed for both arches.
- The diff has plausible arch-specific output; a near-zero arm64 delta is a
  failure signal, not success.

**Reference:** [`docs/deep-inspect.md`](docs/deep-inspect.md)

### P1 — Define downstream import contract for rosetta

**Why:** `tikoci/rosetta` expects `deep-inspect.x86.json` and
`deep-inspect.arm64.json` in `docs/{version}/extra/` to enrich its SQL/RAG
database. restraml should make the published contract explicit before consumers
depend on accidental file shape.

**Scope:**

- Document the stable fields rosetta can rely on.
- Decide which `_meta` fields are contract vs diagnostic.
- Clarify whether downstream consumers should prefer arm64, x86, both, or a
  future merged file.

**Acceptance criteria:**

- A reference section or docs page describes the per-arch file contract.
- `CLAUDE.md` and `AGENTS.md` point agents to that contract.
- No consumer is told to read `inspect.json` when it needs completion-enriched
  data.

### P2 — Design multi-arch merge (`deep-inspect.json`)

**Why:** Per-arch files are useful for validation, but many consumers will want a
single enriched tree.

**Likely shape:**

- `mergeInspectTrees()` combines x86 and arm64 files.
- Sparse `_source: "x86" | "arm64"` annotations only on arch-unique nodes.
- `--merge` CLI mode for local generation.
- `_meta.mergeStats` with counts for shared, arch-only, and conflict buckets.
- Explicit conflict policy for shared-node `_completion` disagreements.

**Acceptance criteria:**

- Merge policy is documented before implementation.
- Tests cover arch-unique nodes, shared identical nodes, completion enum drift,
  type mismatches, and metadata.
- Published per-arch files remain available after any merged file is introduced.

**Reference:** [`docs/deep-inspect.md`](docs/deep-inspect.md)

### P2 — Verify `openapi.json` replacement path

**Why:** `openapi.html` consumes `openapi.json`, while the deep-inspect pipeline
can also generate per-arch OpenAPI files. Replacing or deriving the public
OpenAPI schema needs an equivalence check.

**Scope:**

- Compare existing `openapi.json` output with `openapi.x86.json` and
  `openapi.arm64.json`.
- Decide whether the public API explorer should use x86, arm64, a merged file,
  or keep the current file.
- Document any intentional differences.

**Acceptance criteria:**

- Differences are categorized as expected arch/package coverage or true schema
  regressions.
- `docs/openapi.html` behavior is unchanged unless a deliberate migration task
  changes it.

### P2 — Evaluate docs pages that could use deep-inspect

**Why:** The browser tools currently use `inspect.json`, which is intentionally
stable but lacks completion-enriched details.

**Candidate pages:**

- `docs/lookup.html`
- `docs/diff.html`
- future command/property reference views

**Acceptance criteria:**

- Each candidate has a clear reason to stay on `inspect.json` or migrate to
  `deep-inspect.*.json`.
- Any migration preserves query-string behavior, published URL compatibility,
  and static GitHub Pages operation.

### P3 — Investigate per-package provenance

**Why:** RouterOS does not expose a package-to-command mapping, but knowing which
extra package adds a command would improve docs and downstream search.

**Likely approach:**

- Install extra packages one at a time.
- Crawl after each install/reboot.
- Diff command trees to infer package ownership.

**Acceptance criteria:**

- A prototype proves the method on a small package subset.
- Runtime and reboot cost are measured before adding CI automation.
- The output format does not pollute `inspect.json`.

### P3 — Resolve `/app` schema naming and release-scope policy

**Why:** Current `*.latest.json` and `*.editor.json` names mix two dimensions:
strict vs editor-friendly, and stable-only vs beta/testing syntax. The public
URLs are already linked externally, so any change needs a compatibility plan.

**Questions to answer:**

- Should `*.latest.json` track stable only, or include beta/RC syntax?
- Should per-version schemas be generated for every testing build?
- Is a clearer future naming scheme worth adding beside the existing public
  URLs?

**Acceptance criteria:**

- Existing public schema URLs continue to work.
- `docs/tikapp.html`, README examples, and SchemaStore/editor guidance agree.
- `CLAUDE.md` no longer has unresolved process questions that should be GitHub
  issues.

## Completed / reference-only items

| Item | Status | Canonical reference |
|---|---|---|
| Phase 1 completion metadata fixes | Shipped | Git history; `docs/deep-inspect.md` summary |
| Phase 2 native API transport | Shipped but unused in CI | `CLAUDE.md`, native API bug report |
| Phase 2.9 native API non-determinism finding | Resolved: REST only | `docs/mikrotik-bug-native-api-inspect.md` |
| Phase 3 ARM64 per-arch enrichment | Shipped | `docs/deep-inspect.md` |
| ARM64 CI memory/TCG postmortem | Resolved: use 1024 MB for extra-package jobs | `docs/deep-inspect.md`, `CLAUDE.md` |
