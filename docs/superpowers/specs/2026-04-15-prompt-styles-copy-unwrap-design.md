# Prompt Styles — Copy-Prompt Unwrap Design

**Date:** 2026-04-15
**Status:** Approved (brainstorming), awaiting implementation plan
**Builds on:** `docs/superpowers/specs/2026-04-15-prompt-styles-design.md` (shipped 2026-04-15)

## Problem

The shipped "Стиль" feature stores the **wrapped** prompt in history (`prefix + ". " + userPrompt + ". " + suffix`). The copy-prompt UX takes `entry.prompt` verbatim and puts it into the textarea. If the user still has a style selected, submitting wraps the already-wrapped string a second time, producing output the user didn't intend.

## Goal

When a user copies a prompt from a past generation, restore the original authoring context:
- Textarea gets the **clean** user prompt (not the wrapped version).
- Style dropdown auto-switches to the style that was used.
- Toast confirms what happened.

Old entries (pre-feature) continue to work as they did before — copy-prompt puts `entry.prompt` in the textarea, no dropdown change.

## Data Model

At generation time, `components/generate-form.tsx` serializes a `promptPayload` object into the server's `prompt_data` TEXT column (JSON blob). We add two fields:

```ts
const promptPayload = {
  prompt: composeFinalPrompt(prompt.trim(), activeStyle),  // unchanged: wrapped
  userPrompt: prompt.trim(),                                // NEW: raw user input
  styleId: activeStyle ? activeStyle.id : DEFAULT_STYLE_ID, // NEW: applied style id
  // ...existing fields unchanged
};
```

**`styleId` is written always** — even for the default style (`"__default__"`). This matters: presence of `styleId` distinguishes a post-feature record from a pre-feature one. The copy logic uses that distinction (see below).

**`HistoryEntry`** (`lib/history/types.ts`) gets two optional fields:

```ts
userPrompt?: string;
styleId?: string;
```

Both are `undefined` for pre-feature entries. That's the fallback signal.

**Hydrate path** (`lib/history/*.ts`, wherever `prompt_data` JSON is parsed into `HistoryEntry`): extract `userPrompt` and `styleId` if present; pass through untouched if missing.

**No schema migrations.** SQLite column shape is unchanged; everything rides in the existing `prompt_data` JSON.

## Copy-Prompt Behavior

A pure helper is extracted so both copy sites (output card button and sidebar button) share one code path:

**`lib/styles/apply-copied.ts`**

```ts
export interface ApplyCopiedSetters {
  setPrompt: (s: string) => void;
  setSelectedStyleId: (id: string) => void;
  toastInfo: (msg: string) => void;
  toastWarn: (msg: string) => void;
}

export function applyCopiedPrompt(
  entry: { prompt: string; userPrompt?: string; styleId?: string },
  styles: readonly Style[],
  setters: ApplyCopiedSetters
): void {
  // Pre-feature record — fallback to old behavior
  if (entry.styleId === undefined) {
    setters.setPrompt(entry.prompt);
    // dropdown untouched
    setters.toastInfo("Промпт скопирован");
    return;
  }

  // Post-feature with default style — no wrapping ever applied
  if (entry.styleId === DEFAULT_STYLE_ID) {
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleId(DEFAULT_STYLE_ID);
    setters.toastInfo("Промпт скопирован");
    return;
  }

  const existingStyle = styles.find(s => s.id === entry.styleId);
  if (existingStyle) {
    // Style still exists — normal happy path
    setters.setPrompt(entry.userPrompt ?? entry.prompt);
    setters.setSelectedStyleId(entry.styleId);
    setters.toastInfo(`Промпт скопирован, стиль «${existingStyle.name}» применён`);
    return;
  }

  // Style was deleted between generation and copy — variant B:
  // paste the wrapped prompt, reset dropdown, warn the user.
  setters.setPrompt(entry.prompt);
  setters.setSelectedStyleId(DEFAULT_STYLE_ID);
  setters.toastWarn("Стиль больше не существует, промпт вставлен как есть");
}
```

Callers (`output-area.tsx`, `history-sidebar.tsx`) construct the setters object from their existing imports:
- `setPrompt` → `usePromptStore.getState().setPrompt`
- `setSelectedStyleId` → `useSettingsStore.getState().setSelectedStyleId`
- `toastInfo` → `toast.success`
- `toastWarn` → `toast.warning` (or `toast` with `warning` variant, per sonner)

## Display in History Cards

In both the sidebar and the output area, wherever the prompt text is rendered (currently as `entry.prompt`), use:

```ts
function displayPromptText(entry: HistoryEntry): string {
  return entry.userPrompt ?? entry.prompt;
}
```

Pre-feature entries get `entry.prompt` (unchanged behavior). Post-feature entries show just the clean part.

**Style badge** rendered only when a non-default style was actually applied:

```tsx
{entry.styleId && entry.styleId !== DEFAULT_STYLE_ID && (
  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
    <Sparkles className="h-3 w-3" />
    Стиль: {styles.find(s => s.id === entry.styleId)?.name ?? entry.styleId}
  </span>
)}
```

If the style was deleted after generation, fall back to the raw `styleId` as label text. Honest: the record still remembers *that* a style was applied.

**Alt-text on images** keeps `entry.prompt` (the wrapped version) — richer context for a11y/SEO; no behavior change.

## Lifting Styles State

Currently `styles` are fetched inside `GenerateForm`. Copy buttons live in `OutputArea` / `HistorySidebar`, which don't see that state. Two paths considered:

- **Chosen: prop drilling from the common parent.** The parent that composes `GenerateForm`, `OutputArea`, `HistorySidebar` (the playground/page component) holds `styles` state, fetches `/api/styles`, runs the focus listener and `reconcileSelectedStyle`, and passes `styles` down to all three consumers.
- Rejected: a dedicated `useStylesStore`. Cleaner in isolation, but a new global store for three prop holders is heavier than lifting state by one level.
- Fallback if the parent turns out to be hard to touch: keep fetch local to `GenerateForm` AND add a minimal second fetch in `OutputArea`/`HistorySidebar`. Duplication, but zero risk to the parent. **Decide in the plan** after reading the parent file.

## Backward Compatibility

- Old history records lack `styleId` and `userPrompt` → `entry.userPrompt === undefined` → `displayPromptText` returns `entry.prompt`, no badge, copy-prompt behaves exactly as today.
- No DB migration, no data backfill, no flag.
- Nothing about the generation submit path or the server-side prompt handling changes.

## Testing

- `lib/styles/__tests__/apply-copied.test.ts` — unit tests for the four branches of `applyCopiedPrompt` (pre-feature undefined; post-feature default; post-feature existing; post-feature deleted). Assertions against mock setters.
- Existing tests for `composeFinalPrompt` and the styles store remain untouched.
- UI render tests: not added (no such tests exist in this project; manual browser smoke covers it).

## File Layout

```
lib/styles/apply-copied.ts                   # new
lib/styles/__tests__/apply-copied.test.ts    # new
lib/history/types.ts                         # +2 optional fields on HistoryEntry
lib/history/*.ts (hydrate parser)            # read userPrompt/styleId from prompt_data
components/generate-form.tsx                 # write userPrompt/styleId into promptPayload;
                                             #   accept styles as prop (if lifted)
components/output-area.tsx                   # use displayPromptText, badge, applyCopiedPrompt
components/history-sidebar.tsx               # same as above
components/<parent of GenerateForm>          # lift styles state (if path A chosen)
```

## Non-Goals

- No changes to `/api/generate/submit` body shape or server route logic.
- No search/filter changes (search over `entry.prompt` still works the same).
- No tooltip showing the full wrapped prompt on hover (YAGNI).
- No migration of old entries to include `userPrompt`/`styleId` retroactively.
- No "reapply deleted style" feature (the deletion branch just warns the user).

## Open Questions

None at brainstorming close. Three clarifications resolved:
1. Deleted-style copy → variant B (paste wrapped, reset dropdown, warn).
2. Sidebar display → clean text + style badge (with fallback for pre-feature).
3. Storage → `prompt_data` JSON additions, no schema change.
