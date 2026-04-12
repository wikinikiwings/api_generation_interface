# Copy-Prompt → Apply to Textarea Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user clicks a "Copy prompt" button in `OutputArea` or `HistorySidebar`, the prompt is both copied to the clipboard AND written into the `GenerateForm` textarea (overwriting whatever is there).

**Architecture:** Introduce a tiny zustand store (`stores/prompt-store.ts`) holding the current prompt text. `GenerateForm` subscribes to read/write (replacing its local `useState`). The two Copy buttons call `usePromptStore.getState().setPrompt(...)` inside their existing `onClick` handlers, only on clipboard success, and the two toast strings are unified.

**Tech Stack:** Next.js 15, React 19, zustand 5, sonner (toasts). No test framework in this project — verification is via `npm run lint`, `npm run build`, and manual browser testing.

**Spec:** `docs/superpowers/specs/2026-04-12-copy-prompt-apply-design.md`

---

## File Structure

**Created:**
- `stores/prompt-store.ts` — new zustand store with `{ prompt, setPrompt }`.

**Modified:**
- `components/generate-form.tsx` — replace local `useState` with store subscription.
- `components/output-area.tsx` — in the Copy button's `onClick`, call `setPrompt` on clipboard success + change toast text.
- `components/history-sidebar.tsx` — in `handleCopy`, call `setPrompt` on clipboard success + change toast text.

No shared helper is introduced; two callsites × two lines each does not justify an abstraction.

---

## Task 1: Create the prompt store

**Files:**
- Create: `stores/prompt-store.ts`

- [ ] **Step 1: Create the store file**

Create `stores/prompt-store.ts` with the following exact content:

```ts
"use client";

import { create } from "zustand";

/**
 * Holds the current text in the prompt textarea of GenerateForm.
 *
 * Lives in a store (not local component state) so that the
 * "Copy prompt" buttons in OutputArea and HistorySidebar can
 * push a prompt directly into the form on click — the user
 * shouldn't have to paste manually to re-run a prior generation.
 *
 * Not persisted: the form's prompt is ephemeral UI state, same
 * as before. Initial value matches the prior hard-coded default
 * in components/generate-form.tsx.
 */
interface PromptState {
  prompt: string;
  setPrompt: (p: string) => void;
}

export const usePromptStore = create<PromptState>()((set) => ({
  prompt: "Make the hamburger made of glass.",
  setPrompt: (prompt) => set({ prompt }),
}));
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`

Expected: no new errors related to `stores/prompt-store.ts`. (Pre-existing warnings unrelated to this change may remain.)

- [ ] **Step 3: Commit**

```bash
git add stores/prompt-store.ts
git commit -m "feat(prompt-store): add zustand store for form prompt text"
```

---

## Task 2: Wire `GenerateForm` to the store

**Files:**
- Modify: `components/generate-form.tsx` (imports at top; prompt state around line 130)

- [ ] **Step 1: Add the store import**

In `components/generate-form.tsx`, find the block of store imports (around line 10):

```ts
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
```

Add a line for the new store immediately after `useSettingsStore`:

```ts
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePromptStore } from "@/stores/prompt-store";
```

- [ ] **Step 2: Replace the local `useState` with store subscriptions**

In the same file, find line 130:

```ts
const [prompt, setPrompt] = React.useState(
  "Make the hamburger made of glass."
);
```

Replace with:

```ts
const prompt = usePromptStore((s) => s.prompt);
const setPrompt = usePromptStore((s) => s.setPrompt);
```

Leave the textarea usage (around lines 592–595) untouched — the identifiers
`prompt` and `setPrompt` keep the same call signatures, so `value={prompt}`
and `onChange={(e) => setPrompt(e.target.value)}` still work.

- [ ] **Step 3: Type-check**

Run: `npm run lint`

Expected: no new errors. TypeScript should accept `setPrompt(string)` at every existing callsite.

- [ ] **Step 4: Quick manual smoke check**

Run: `npm run dev`

Open the app in the browser, confirm:
- The prompt textarea renders with the initial text "Make the hamburger made of glass." (same as before).
- Typing in the textarea updates the visible value.
- Submitting a generation uses the typed prompt.

Stop the dev server once confirmed.

- [ ] **Step 5: Commit**

```bash
git add components/generate-form.tsx
git commit -m "refactor(generate-form): read prompt from zustand store"
```

---

## Task 3: Update `OutputArea` copy handler

**Files:**
- Modify: `components/output-area.tsx` (imports at top; Copy button `onClick` around lines 369–384)

- [ ] **Step 1: Add the store import**

In `components/output-area.tsx`, find the existing store import (line 8):

```ts
import { useHistoryStore } from "@/stores/history-store";
```

Add below it:

```ts
import { useHistoryStore } from "@/stores/history-store";
import { usePromptStore } from "@/stores/prompt-store";
```

- [ ] **Step 2: Update the Copy button handler and toast text**

Find the Copy button (around lines 369–384). The current `onClick` looks like:

```tsx
onClick={async (e) => {
  e.stopPropagation();
  e.preventDefault();
  const ok = await copyToClipboard(entry.prompt);
  if (ok) toast.success("Промпт скопирован", { duration: 1500 });
}}
```

Replace it with:

```tsx
onClick={async (e) => {
  e.stopPropagation();
  e.preventDefault();
  const ok = await copyToClipboard(entry.prompt);
  if (ok) {
    usePromptStore.getState().setPrompt(entry.prompt);
    toast.success("Промпт применён и скопирован", { duration: 1500 });
  }
}}
```

Rationale for the specifics:
- `.getState().setPrompt(...)` (not the hook) — this is a one-shot action in a click handler; we don't want to re-render the card on every `prompt` change in the form.
- `setPrompt` is inside the `if (ok)` branch — atomicity: either both clipboard and textarea update (with toast), or neither does.
- Toast text changes to reflect both actions.

- [ ] **Step 3: Type-check**

Run: `npm run lint`

Expected: no new errors.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open the app in the browser.

Generate (or reuse a recent) image so a card appears in `OutputArea`. Click the Copy button on the card's prompt row. Confirm:
- The textarea in the form now contains the clicked card's prompt.
- The OS clipboard contains the same text (paste into another app to verify).
- Toast reads "Промпт применён и скопирован".

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add components/output-area.tsx
git commit -m "feat(output-area): copy-prompt also writes to form textarea"
```

---

## Task 4: Update `HistorySidebar` copy handler

**Files:**
- Modify: `components/history-sidebar.tsx` (imports at top; `handleCopy` around line 370)

- [ ] **Step 1: Add the store import**

In `components/history-sidebar.tsx`, find the existing store import (line 17):

```ts
import { useHistoryStore } from "@/stores/history-store";
```

Add below it:

```ts
import { useHistoryStore } from "@/stores/history-store";
import { usePromptStore } from "@/stores/prompt-store";
```

- [ ] **Step 2: Update `handleCopy` and toast text**

Find `handleCopy` (around lines 370–374):

```ts
async function handleCopy() {
  if (!data.prompt) return;
  const ok = await copyToClipboard(data.prompt);
  if (ok) toast.success("Промпт скопирован", { duration: 1500 });
}
```

Replace with:

```ts
async function handleCopy() {
  if (!data.prompt) return;
  const ok = await copyToClipboard(data.prompt);
  if (ok) {
    usePromptStore.getState().setPrompt(data.prompt);
    toast.success("Промпт применён и скопирован", { duration: 1500 });
  }
}
```

- [ ] **Step 3: Type-check**

Run: `npm run lint`

Expected: no new errors.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open the app in the browser.

Open the `HistorySidebar` (click the "История" button). Click the Copy icon next to "Prompt:" on an entry. Confirm:
- The textarea in the form now contains that entry's prompt.
- Clipboard matches.
- Toast reads "Промпт применён и скопирован".

Also test the overwrite case: type arbitrary text into the textarea, then click Copy on a history entry — the textarea should be replaced by the history entry's prompt, no confirm dialog.

Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add components/history-sidebar.tsx
git commit -m "feat(history-sidebar): copy-prompt also writes to form textarea"
```

---

## Task 5: End-to-end verification

**Files:** none modified

- [ ] **Step 1: Full build**

Run: `npm run build`

Expected: build succeeds. If it fails with errors referencing any of the files modified in this plan, stop and fix before proceeding.

- [ ] **Step 2: Manual test plan walk-through**

Run: `npm run dev`. Work through the spec's manual test plan
(`docs/superpowers/specs/2026-04-12-copy-prompt-apply-design.md`, section
"Manual test plan"):

1. Generate an image → Copy from the `OutputArea` card → textarea updated + clipboard + toast.
2. Open `HistorySidebar` → Copy on an older entry → same.
3. Type custom text → Copy on a prior entry → custom text overwritten.
4. Start a generation; while in-flight click Copy on a different entry → in-flight generation unaffected; next submit uses the new prompt.
5. If possible, force a clipboard failure (e.g. DevTools → deny clipboard permission) and click Copy → textarea unchanged, no toast.

Stop the dev server once all pass.

- [ ] **Step 3: Final commit is already done in Task 4**

No extra commit here. If Task 5 surfaces a fix, that fix gets its own commit.

---

## Self-Review

Spec coverage check against `2026-04-12-copy-prompt-apply-design.md`:

- **"New store `stores/prompt-store.ts`"** → Task 1. ✓
- **"`GenerateForm` replaces local `useState` with store"** → Task 2. ✓
- **"`OutputArea` calls `setPrompt` on clipboard success + new toast text"** → Task 3. ✓
- **"`HistorySidebar` calls `setPrompt` on clipboard success + new toast text"** → Task 4. ✓
- **"Atomicity: `setPrompt` only inside `if (ok)`"** → Tasks 3 & 4 explicitly show this. ✓
- **"No shared helper"** → Honored; two inline callsites. ✓
- **"Toast text unified to `Промпт применён и скопирован`"** → Tasks 3 & 4. ✓
- **"Manual test plan"** → Task 5. ✓
- **Edge cases (empty prompt, clipboard fail, in-flight generation, SSR)** → pre-existing guards cover the first three; store has no persist so the fourth is structurally impossible. No task needed — this matches the spec's "no new guard needed" stance.

Placeholder scan: none.

Type consistency: `setPrompt: (p: string) => void` is defined in Task 1 and called with a string in Tasks 2–4. Identifiers `usePromptStore`, `prompt`, `setPrompt` are used consistently throughout.
