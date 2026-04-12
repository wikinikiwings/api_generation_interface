# Copy-prompt → also apply to prompt textarea

**Date:** 2026-04-12
**Status:** Design approved, awaiting implementation plan

## Problem

The "Copy prompt" buttons in `OutputArea` and `HistorySidebar` currently only
write the prompt text to the clipboard. Users who want to re-run a prior
generation with a small tweak have to then manually paste it into the form's
prompt textarea. Both steps happen together often enough that the button
should do both.

## Goal

Clicking either Copy-prompt button:

1. Copies the prompt to the OS clipboard (unchanged behavior).
2. Also writes the prompt into the `GenerateForm` textarea, replacing whatever
   is currently there.
3. Shows a single toast confirming both actions.

## Non-goals

- Not adding a confirm-dialog before overwriting existing textarea content.
- Not appending, only overwriting.
- Not adding persistence — the prompt stays client-only UI state, the same as
  today.
- Not adding unit/integration tests (no existing test infra for this surface).

## Architecture

### New store: `stores/prompt-store.ts`

Small zustand slice holding the current prompt text. Matches the project
convention already established by `stores/settings-store.ts` and
`stores/history-store.ts`.

```ts
"use client";
import { create } from "zustand";

interface PromptState {
  prompt: string;
  setPrompt: (p: string) => void;
}

export const usePromptStore = create<PromptState>()((set) => ({
  prompt: "Make the hamburger made of glass.",
  setPrompt: (prompt) => set({ prompt }),
}));
```

- No `persist` middleware. Prompt is ephemeral UI state.
- No server hydration. Fully client-side.
- Initial value matches the current hard-coded default in
  `components/generate-form.tsx:131`.

## Component changes

### `components/generate-form.tsx`

Replace the local React state with store subscriptions:

- Line 130 (current):
  ```ts
  const [prompt, setPrompt] = React.useState("Make the hamburger made of glass.");
  ```
- Becomes:
  ```ts
  const prompt = usePromptStore((s) => s.prompt);
  const setPrompt = usePromptStore((s) => s.setPrompt);
  ```

The textarea usage at lines 592–595 does not change: the identifiers `prompt`
and `setPrompt` keep the same call signatures.

### `components/output-area.tsx` (lines 369–384)

In the Copy button's `onClick`, after `copyToClipboard` resolves `true`, call
`usePromptStore.getState().setPrompt(entry.prompt)`. Using `.getState()` (not
the hook) because this is a one-shot action in an event handler — no
subscription needed, no re-renders caused. Also update the toast text.

### `components/history-sidebar.tsx` (`handleCopy`, ~line 370)

Same pattern: after `copyToClipboard` resolves `true`, call
`usePromptStore.getState().setPrompt(data.prompt)`. Update toast text.

### Atomicity: only on clipboard success

`setPrompt` is called only inside the `if (ok)` branch. Either both the
clipboard and the textarea update (and the toast fires), or neither does. This
avoids a silently-mutated textarea with no user-visible feedback.

### No shared helper

Two callsites, two lines each. Extracting a helper would be premature
abstraction per project conventions.

## Toast text

Both existing toasts change from `"Промпт скопирован"` to
`"Промпт применён и скопирован"`. Duration (1500 ms) and `toast.success` level
are unchanged.

## Edge cases

- **Empty prompt.** Both buttons already guard against this: `OutputArea`
  renders the button only when `entry.prompt` is truthy
  (`output-area.tsx:361`); `HistorySidebar` disables the button via
  `disabled={!data.prompt}` (line 449). No new guard needed.
- **Clipboard API failure.** `copyToClipboard` returns `false` — current
  behavior is "no toast." `setPrompt` is only called on success, so the
  textarea also stays untouched. The user sees no toast and can retry.
- **Generation in-flight.** `GenerateForm` does not block the form during
  active generations (see comment at `generate-form.tsx:151–156`). Overwriting
  `prompt` does not affect any already-submitted request — each pipeline
  captures its own `prompt` value at submit time. Safe.
- **SSR / hydration.** Zustand store without `persist` has a static default
  value. No hydration mismatch possible.

## Manual test plan

1. Generate an image → in `OutputArea`, click Copy on the result card.
   - Expect: prompt text appears in the form's textarea, is in the OS
     clipboard, toast "Промпт применён и скопирован" is shown.
2. Open `HistorySidebar`, click Copy on an older entry.
   - Expect: same as above.
3. Type custom text into the textarea, then click Copy on any prior entry.
   - Expect: custom text is overwritten by the copied prompt.
4. Start a generation, and while it's in flight click Copy on another entry.
   - Expect: in-flight generation is unaffected; the form's textarea updates
     for the next submit.
5. Revoke clipboard permission (or test in a context where it fails) and click
   Copy.
   - Expect: textarea unchanged, no toast. (Matches existing behavior.)
