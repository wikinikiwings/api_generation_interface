# Prompt de-duplication (drop persisted wrapped prompt)

**Date:** 2026-06-29
**Status:** Design approved, pending spec review → implementation plan

## Problem

After the input-images-disk-storage migration shrank the production DB from
~1 GB to ~85 MB, `generations.prompt_data` is still the dominant table content
at ~54 MB across 24,753 rows (avg ~2.2 KB/row). Measurement shows ~30 MB of
that is the **wrapped `prompt`** field — the final prompt sent to the API,
composed from `userPrompt` + active style prefixes/suffixes + negative
boilerplate. This text is fully derivable from `userPrompt` + `styleIds` + the
persisted style catalog, so storing it is redundant.

This is variant 2 of a two-part plan. Variant 1 (retention/archival) is a
separate, later spec.

### Measured facts (prod DB, read-only)

| Group | Rows | Note |
|---|---|---|
| Rows with `userPrompt` | 24,753 (all) | Migration is homogeneous; no real pre-feature rows |
| `styleIds === []` (no style) | 14,597 | `prompt === userPrompt` verbatim → recompose = `userPrompt` |
| Real styles applied | 10,156 | `prompt = composeFinalPrompt(userPrompt, styles)` |
| `SUM(LENGTH(prompt))` where userPrompt present | ~30.4 MB | Strippable |
| `SUM(LENGTH(userPrompt))` | ~14 MB | Retained |

## Goal

Stop persisting the wrapped `prompt`; recompose it on demand from `userPrompt` +
`styleIds` + the live style catalog. Reclaim existing space via a one-time
operator-run migration.

**Projected effect:** `prompt_data` ~54 → ~24 MB; DB ~85 → ~50–55 MB after
VACUUM; avg row ~2.2 → ~1 KB; future text growth ~halved.

## Key decisions

1. **Fidelity = hybrid.** On restore/copy, recompose from the *current* style
   definitions (styles are live reusable presets — applying the current version
   is the intended behavior, matching the existing restore UX where a style
   re-activates as a menu option rather than being baked into the prompt text).
2. **Edit detection = notify only.** A style edited after generation still
   applies its current version, but restore shows an informational toast
   ("стиль был изменён со времени прошлой генерации"). This requires storing a
   minimal per-generation style fingerprint.
3. **Deleted style = degrade to `userPrompt`.** Restore pastes `userPrompt`,
   selects only the resolvable styles, and warns about the deleted one. No
   stored wrapped prompt is needed as a fallback.
4. **Recomposition placement = lazy client-side at the consumer** (chosen over
   server-side GET recomposition and ingestion-time recomposition). The client
   already holds the styles store and `composeFinalPrompt` is already a pure
   client function. No hot-path cost on the server; display is already
   `userPrompt`-first, so only copy + tooltips change.

## Schema change: `prompt_data`

- **Remove** `prompt` (wrapped).
- **Keep** `userPrompt`, `styleIds`.
- **Add** optional `styleVersions: Record<string, string>` — map of
  `styleId → style.updatedAt` captured at generation time, for edit detection.

```jsonc
// before: { "prompt": "<userPrompt + style + negative>", "userPrompt": "...", "styleIds": ["x"], ... }
// after:  { "userPrompt": "...", "styleIds": ["x"], "styleVersions": {"x":"2026-06-29T..."}, ... }
```

The prompt sent to the generation API (`/api/generate/submit`) is still
composed at submit time and is unchanged — it is never the persistence concern.

## Write path (`components/generate-form.tsx`)

- `promptPayload` (~line 276): drop `prompt:`; add
  `styleVersions` from `activeStyles.map(s => [s.id, s.updatedAt])`.
- `NewPendingInput` (~line 501): same — the optimistic entry no longer carries
  the wrapped `prompt`.
- Submit call (~line 528): **unchanged** — still sends
  `composeFinalPrompt(prompt.trim(), activeStyles)`.

## Read path (`lib/history/store.ts`)

- `serverGenToEntry`: parse optional `styleVersions`. `entry.prompt` becomes a
  derived value — when absent in JSON (new/migrated rows) it stays empty; legacy
  rows that still contain `prompt` keep reading it as-is.
- New pure helper `resolveWrappedPrompt(entry, styles): string`:
  - if `entry.userPrompt` present → `composeFinalPrompt(userPrompt, resolved)`,
    where `resolved` filters out any `styleId` no longer in the catalog;
  - else → `entry.prompt` (legacy fallback).

## Consumers of the wrapped prompt

- **Copy** (`history-sidebar.tsx:310`, `output-area.tsx:353`):
  `copyToClipboard(resolveWrappedPrompt(entry, styles))`.
- **Tooltips** `alt`/`title`: same helper.
- **Display** (`userPrompt ?? prompt`): unchanged (already `userPrompt`-first).

## Restore + toast (`lib/styles/apply-copied.ts`)

`CopiedEntry.prompt` becomes optional. Branches:

1. `styleIds` undefined (legacy, ~0 rows) → paste `entry.prompt ?? userPrompt`.
2. `styleIds === []` → paste `userPrompt`, clear selection.
3. **All ids resolve** → paste `userPrompt`, activate styles. **New:** compare
   each style's current `updatedAt` against `entry.styleVersions[id]`; if any
   differ, append "стиль(и) изменён(ы) с момента генерации" to the toast. If
   `styleVersions` is absent (migrated rows), skip the edit check.
4. **Some id missing** → paste `userPrompt` (not the wrapped prompt), select
   only the resolvable styles, warn that style X was deleted. (This is the
   agreed hybrid behavior and removes the dependency on a stored wrapped prompt.)

## Migration (`scripts/migrate-strip-wrapped-prompt.mjs`)

Modeled on `scripts/migrate-input-thumbnails.mjs`: idempotent, `--dry-run`,
VACUUM at the end.

- For each row whose `prompt_data` contains `userPrompt`: delete the `prompt`
  key, preserve everything else.
- Rows without `userPrompt` (legacy, ~0): leave `prompt` intact.
- Do **not** backfill `styleVersions` (historical `updatedAt` is unknown;
  absence means "edit detection not available for this row").
- Operator-run, manual, irreversible: dry-run on a copy → stop container →
  back up DB → migrate → verify (0 rows with a `prompt` key among rows that have
  `userPrompt`) → VACUUM → restart.

## Testing

- `apply-copied.test.ts`: edit-detection toast (branch 3), `userPrompt` fallback
  on deleted style (branch 4).
- `resolveWrappedPrompt`: styled / unstyled / deleted-style cases.
- `serverGenToEntry`: parses `styleVersions`; handles absent `prompt`.
- Migration test (mirror `migrate-input-thumbnails.test.ts`): strips `prompt`,
  idempotent, preserves legacy rows, VACUUMs.
- Manual/E2E: copy button copies recomposed prompt; restore re-activates styles
  and shows the edit toast when a style changed since generation.

## Out of scope

- Variant 1 (retention/archival) — separate spec.
- The 2 leftover `data:image` rows from the input-images migration — separate
  cleanup.
- Style boilerplate normalization beyond dropping the duplicate (storing styles
  by reference is already the model; no further change needed here).
