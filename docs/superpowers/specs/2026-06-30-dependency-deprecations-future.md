# Dependency deprecation cleanup — FUTURE

**Date:** 2026-06-30
**Status:** Not started — future hygiene task. Not urgent; build & runtime are unaffected.

## Why this exists

The Docker image build emits `npm warn deprecated` for several packages. They
are **warnings, not errors** — the build succeeds and the running app is
unaffected. Captured here so the cleanup isn't lost, and so future builds don't
re-trigger an investigation from scratch.

## Observed warnings (container build, 2026-06-30)

- `prebuild-install@7.1.3` — "No longer maintained." Pulled in by native addons
  (e.g. `better-sqlite3`) to fetch prebuilt binaries. Still functional.
- `inflight@1.0.6` — "leaks memory; do not use." Transitive via old `glob`.
  Build-time/transitive, not in the app's hot path.
- `glob@7.2.3` — old major with known advisories; fixed in current major.
  Transitive.
- `eslint@8.57.1` — "no longer supported." Dev-only (lint), not in the runtime
  image.

All four are transitive dependencies of build/dev tooling, not direct app code,
and predate any recent feature work — they appear on every build.

## Scope when picked up

- Run `npm audit` / `npm outdated` to see the current tree and which direct deps
  pull the deprecated transitives.
- Update direct dependencies whose newer versions drop `inflight`/old `glob`
  (often a transitive bump resolves several at once).
- `eslint` 8 → 9 is a **major** bump: flat-config migration (`eslint.config.js`)
  and plugin compatibility may need config changes — treat as its own slice.
- `better-sqlite3` / `prebuild-install`: only bump if a newer `better-sqlite3`
  uses a maintained install path; verify the native binding still builds in the
  Docker image (Linux) AND on the Windows host (the migration scripts run there).
- Verify: clean build with fewer/zero deprecation warns, `npm test` green,
  container boots, admin + generate flows smoke-tested.

## Risks / notes

- Reflexive `npm update` can break the lockfile-pinned native build; do it
  deliberately, one cluster at a time, rebuilding the image between.
- This is pure maintenance — no user-facing change. Low priority.
