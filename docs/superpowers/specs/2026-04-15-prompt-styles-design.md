# Prompt Styles — Design Spec

**Date:** 2026-04-15
**Status:** Approved (brainstorming), awaiting implementation plan

## Summary

Add a "Стиль" (Style) dropdown in the generation card beside the resolution/aspect/format pickers. A style wraps the user's prompt with configurable `prefix` and `suffix` text blocks using `". "` as a separator. Styles are managed in the admin panel (list on the left, editor on the right, "+" to create) and persisted as JSON files in `data/styles/`. A synthetic "Стандартный" style is always available and acts as a no-op.

Also: remove the caption string "Входные изображения · опционально (пусто = text-to-image)" above the image dropzone to free vertical space so the pickers fit in the generation settings card.

## Data Model

One JSON file per style in `data/styles/<id>.json`:

```json
{
  "id": "kinematografichnyj-a3f",
  "name": "Кинематографичный",
  "prefix": "cinematic shot, dramatic lighting",
  "suffix": "film grain, 35mm",
  "createdAt": "2026-04-15T10:00:00.000Z",
  "updatedAt": "2026-04-15T10:00:00.000Z"
}
```

- **`id`** — stable slug, generated on creation from `name` (cyrillic transliterated) + a random 3-char suffix for uniqueness. Used as filename and as `selectedStyleId` in the client store. Never changes after creation; renaming `name` is safe.
- **`name`** — 1..80 chars, trimmed.
- **`prefix`**, **`suffix`** — up to 2000 chars each, multiline allowed. Leading/trailing whitespace is trimmed only at injection time, not at storage time.

**Folder path:** resolved the same way as the history DB — respects the `HISTORY_DATA_DIR` env var, defaults to `<cwd>/data/styles/`. Directory is created on first write if missing.

**Default style:** synthetic constant `{ id: "__default__", name: "Стандартный", prefix: "", suffix: "" }`. Not stored on disk. Always rendered as the first option in the generation dropdown. Cannot be edited or deleted.

## Storage Layer

`lib/styles/store.ts` — server-only helper.

- `listStyles(): Promise<Style[]>` — reads every `*.json` in the folder, parses, sorts by `createdAt` ascending, skips invalid files with a server-log warning (no hard failure).
- `getStyle(id): Promise<Style | null>` — reads a single file; returns `null` if absent.
- `createStyle({ name, prefix, suffix }): Promise<Style>` — generates `id`, sets timestamps, atomic write (temp file + rename), returns created record. Retries slug generation up to 3 times on collision.
- `updateStyle(id, patch): Promise<Style>` — reads existing, merges patch, bumps `updatedAt`, atomic write. Throws if not found.
- `deleteStyle(id): Promise<void>` — `unlink`. Throws if not found.

`lib/styles/types.ts` — exports `Style` type and `DEFAULT_STYLE_ID = "__default__"`.

## API Endpoints

Public (no admin middleware):

- **`GET /api/styles`** → `{ styles: Style[] }`. Does not include the synthetic default; the client adds it as the first option.

Admin-only (behind the existing `/api/admin/*` middleware):

- **`POST /api/admin/styles`** — body `{ name, prefix, suffix }`. Validates, creates, returns `{ style }`.
- **`PUT /api/admin/styles/:id`** — body `{ name?, prefix?, suffix? }`. Validates, updates, returns `{ style }`. 404 if not found.
- **`DELETE /api/admin/styles/:id`** — deletes. Returns `{ ok: true }`. 404 if not found.

**Validation errors** → `400` with `{ error: string }` describing which field failed.

## Admin UI

New section in `components/admin-panel.tsx`, rendered below the existing "Активный провайдер" card. Heading: **"Стили промпта"**.

**Layout (two-column flex):**

- **Left column (~260px):**
  - Button **"+ Новый стиль"** at the top.
  - List of custom styles (`<ul>` with `<li><button>`), active one highlighted (same pattern as provider list).
  - Synthetic "Стандартный" is not shown — nothing to edit there.

- **Right column (flex-1):**
  - Text input **"Название"**.
  - Textarea **"Вставка до промпта"** (prefix).
  - Textarea **"Вставка после промпта"** (suffix).
  - **Preview line** showing `<prefix>. <ваш промпт>. <suffix>` with a placeholder for the user prompt, so the admin can see how the pieces will glue. Empty parts are omitted from the preview exactly as the runtime join does.
  - Buttons: **"Сохранить"** (primary), **"Удалить"** (destructive, opens native `confirm()`).

**States:**

- Empty list, nothing selected → placeholder: "Создайте первый стиль, нажав +".
- Non-empty list, nothing selected → placeholder: "Выберите стиль из списка или создайте новый".
- New unsaved style → shown in the list with a "●" indicator; save triggers `POST`, file gets `id`, list refreshes.
- Existing style with unsaved edits → same "●"; switching to another style pops a `confirm("Отменить изменения?")`.

**Saving flow:**
- Create: `POST /api/admin/styles` → update local list, select the new style.
- Update: `PUT /api/admin/styles/:id` → replace in local list.
- Delete: `confirm()` → `DELETE /api/admin/styles/:id` → remove from list, clear selection.

## Generation Card UI

Edit `components/generate-form.tsx`.

**New dropdown placement:** inside the existing grid of pickers (around lines 566–598). Order: **Resolution · Aspect · Format · Стиль**. Uses the same native `<select>` styling as the other pickers for consistency. Label: **"Стиль"**.

**Options:**

- First option always: **"Стандартный"** with `value="__default__"`.
- Then custom styles from `GET /api/styles`, in order returned by the API (sorted by `createdAt` ascending).

**List loading:**

- `GET /api/styles` fires on `GenerateForm` mount, response kept in component state.
- Re-fetch on `window` `focus` event — cheap way to pick up changes made in the admin tab.
- No SSE, no BroadcastChannel — admin-edit cadence is low; rigging realtime is overkill.

**Selection persistence:**

- New field `selectedStyleId: string` in `useSettingsStore` (zustand, same store that persists resolution/aspect/etc.), localStorage-backed — matches the existing pattern used for the model picker.
- On mount, after the styles list loads: if the stored `selectedStyleId` refers to a style that no longer exists (deleted in admin), silently reset to `DEFAULT_STYLE_ID` and update the store. No error UI — just quiet recovery. (This is "variant C" from the brainstorming — stable across sessions, resilient to deletion.)

**Caption removal:**

- Remove the string `"Входные изображения · опционально (пусто = text-to-image)"` around line 551 in `components/generate-form.tsx`.
- Keep `<ImageDropzone>` — functionality untouched.

## Prompt Injection

Happens on the client, immediately before `fetch('/api/generate/submit', ...)` in `GenerateForm.handleSubmit()` (around line 441).

```ts
const userPrompt = prompt.trim();
const style = styles.find(s => s.id === selectedStyleId);

const finalPrompt = style && (style.prefix?.trim() || style.suffix?.trim())
  ? [style.prefix?.trim(), userPrompt, style.suffix?.trim()]
      .filter(part => part && part.length > 0)
      .join(". ")
  : userPrompt;
```

**Rules:**

- Empty `prefix` or `suffix` contribute no separator. `"prefix. user_prompt"` (no trailing `. `) when suffix is empty.
- `__default__` or unknown `id` → `finalPrompt === userPrompt`.
- Empty `userPrompt` → left empty; existing form validation handles it. Style does not substitute a missing prompt.
- `trim()` is applied to `prefix`/`suffix` only at injection time (to guard against trailing newlines in the admin textarea breaking the separator). Interior newlines are preserved.

**Server side** (`/api/generate/submit`) is **not modified**. It receives the already-wrapped prompt. This avoids double-wrapping and keeps the injection rule in one place.

**History record:** the wrapped `finalPrompt` is what gets stored in history (as today). The original `userPrompt` is not separately persisted.

## File Layout

```
lib/styles/
  types.ts
  store.ts
app/api/styles/route.ts                     # GET (public)
app/api/admin/styles/route.ts               # POST
app/api/admin/styles/[id]/route.ts          # PUT, DELETE
components/admin-panel.tsx                  # add "Стили промпта" section
components/generate-form.tsx                # add dropdown, remove caption, inject prompt
lib/stores/settings.ts (or equivalent)      # add selectedStyleId to useSettingsStore
data/styles/                                # runtime-created; .gitignore'd
```

## Validation

- `name`: required, `trim()`-ed, 1..80 chars.
- `prefix`, `suffix`: strings (any length up to 2000 chars), may be empty.
- `id` (URL param): must match `/^[a-z0-9-]+$/` before touching the filesystem (defence against path traversal).

## Non-Goals

- No per-style metadata beyond name/prefix/suffix (no color, icon, category, ordering control).
- No import/export UI — JSON files in `data/styles/` are already human-editable/copyable.
- No realtime sync between admin tab and generation tab — focus rehydrate is enough.
- No server-side enforcement of style on `/api/generate/submit` — client composes the final prompt.
- No migration or seeding — starting state is "no custom styles, only 'Стандартный'".

## Open Questions

None at brainstorming close. All four clarifications resolved:
1. Storage: JSON files.
2. Delete: full delete with `confirm()`.
3. Caption removal: text only, dropzone stays.
4. Selection memory: persist + silent fallback if deleted (variant C).
