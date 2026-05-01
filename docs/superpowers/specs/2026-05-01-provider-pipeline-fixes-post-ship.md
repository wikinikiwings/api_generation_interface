# Provider Pipeline Fixes — Post-Ship Handoff

**Date:** 2026-05-01
**Branch:** `auth/google-oauth` (continuation, not merged)
**Status:** Shipped to local dev. 221/221 vitest pass, `tsc --noEmit` clean. Not yet deployed to prod.
**Intended readers:** any future agent or engineer editing `lib/providers/*`, `lib/image-storage.ts`, `app/api/generate/submit`, `app/api/history`, or the polling loop in `components/generate-form.tsx`.

## Quick-nav

- [Scope of this session](#scope-of-this-session)
- [Fix 1 — Comfy upload-stage retry + structured logs](#fix-1--comfy-upload-stage-retry--structured-logs)
- [Fix 2 — Sync-provider output broken by OAuth path layout](#fix-2--sync-provider-output-broken-by-oauth-path-layout)
- [Fix 3 — Polling timeout removed for slow Wavespeed generations](#fix-3--polling-timeout-removed-for-slow-wavespeed-generations)
- [Fix 4 — Theme toggle moved into Настройки sidebar](#fix-4--theme-toggle-moved-into-настройки-sidebar)
- [File map](#file-map)
- [Open follow-ups](#open-follow-ups)
- [Pitfalls — easy ways to re-break things](#pitfalls--easy-ways-to-re-break-things)

---

## Scope of this session

Three discrete provider-pipeline bugs surfaced in the same conversation. Two of them were latent regressions left behind by the OAuth migration that the original "all 38 tasks done, smoked" pass missed because that smoke ran only against Wavespeed (which is async and never touches `saveBinary`). The third was a pre-existing fragility that became user-visible because nano-banana-pro on Wavespeed started taking 7-8 minutes per generation.

No new dependencies, no schema changes, no auth changes, no UI re-layout. Provider-internal hardening only.

---

## Fix 1 — Comfy upload-stage retry + structured logs

### Symptom

Logs showed sporadic `[/api/generate/submit] error: fetch failed` and `error: aborted` — about 10-15 entries spread across two weeks. A user reported "failed to fetch" on nano-banana-pro generations. The reporter could not reproduce on demand and had a flaky internet connection at home.

### Root cause

`lib/providers/comfy.ts` makes up to **four sequential server-side `fetch()` calls** per generation: one POST `/customers/storage` and one signed-URL PUT per input image (×10 max), then one POST `/proxy/vertexai/gemini/...`. Asymmetric retry coverage:

| Stage | Retried? |
|---|---|
| `createUploadSlot` | no |
| `uploadBinaryToSignedUrl` | no |
| `postGeminiWithRetry` | retried on 5xx but **not** on network errors thrown by `fetch()` itself |

A single `ECONNRESET`, DNS blip, or body-stream `aborted` on any of up to 10 sequential PUTs sank the whole submit — no recovery, error message gave no stage / size / timing context.

### Fix

Extracted a single `fetchWithRetry(stage, op)` helper that:

- Retries on **both** retriable HTTP statuses (408/500/502/503/504) **and** network errors thrown by `fetch()`.
- Same backoff as the existing inline retry: 5s → 15s, max 2 retries.
- Returns the `Response` so callers can read the body for stage-specific error messages.

Threaded through three call sites:

```ts
// lib/providers/comfy.ts

const res = await fetchWithRetry(`upload-slot i=${index}`, () =>
  fetch(STORAGE_CREATE_ENDPOINT, { ... })
);

const res = await fetchWithRetry(`put i=${index} size=${kb}KB`, () =>
  fetch(signedUrl, { method: "PUT", body: buffer, ... })
);

const res = await fetchWithRetry(`gemini bodySize=${kb}KB`, () =>
  fetch(endpoint, { method: "POST", body: serializedBody, ... })
);
```

Each successful stage logs `[comfy/<stage>] <action> in <Xms>`. Each retry logs `[comfy/<stage>] retry N/2 after Yms (previous: ...)`. Each persistent failure throws with stage + size + duration context.

### Why this is "defensive cleanup" not "hypothesis fix"

The fix did **not** address a confirmed root cause — without repro we never proved network jitter caused the original "failed to fetch". But the existing code asymmetry was a clear smell: `postGeminiWithRetry` already proved the retry pattern works in this exact file, and the upload stages literally lacked it. Copying the pattern carries no risk worse than the status quo (worst case: one extra ~20s on a permanent failure). See `feedback_dont_withhold_defensive_fixes.md` in user memory for the rule of thumb.

### What this fix does **not** cover

If the complainer's *browser → our server* connection is the flaky leg (not server → comfy.org), this server-side retry helps zero. The client-side submit fetch in `components/generate-form.tsx:468` has no retry, and a 50+ MB JSON body is unforgiving on TCP resets. Resumable / chunked upload is the proper future fix; not done here.

---

## Fix 2 — Sync-provider output broken by OAuth path layout

### Symptom

User generated with Comfy provider + nano-banana-pro and saw toast "Could not prepare thumbnail". Network tab: `GET /api/history/image/<UUID>.png 400`. Body: `{"error":"Invalid path"}`. Card disappeared (`deleteEntry` fired). Same after the variant generation — "Скачать" downloaded a 24-byte file (the JSON error response), "Открыть в новой вкладке" showed the JSON.

The user's previous OAuth smoke test had only covered Wavespeed (`isAsync: true`), which returns the upstream URL directly and never invokes our local saving path. Comfy and Fal (both `isAsync: false`) were silently broken since the OAuth migration shipped.

### Root cause — two related bugs in path encoding

The OAuth migration (Task 7.3) changed history-image storage layout from flat `<UUID>.<ext>` to per-owner `<email>/<YYYY>/<MM>/<UUID>.<ext>`, and the route at `app/api/history/image/[...path]/route.ts` now requires **at least 2 path segments** with `s.includes("/")` blocked per segment. The hotfix list mentioned in user memory (`thumb URLs`, `extractUuid`, `settings public`) covered the user-history side but missed two writers:

**Bug 2a:** `lib/image-storage.ts:saveBinary` still wrote to the **flat** directory and returned `/api/history/image/<UUID>.<ext>` — one segment → 400. This affected every Comfy and Fal generation (output saved transiently before history upload).

**Bug 2b:** `app/api/history/route.ts:224-226` (POST handler that finalises history entries) constructed URLs with `encodeURIComponent(relDir)` where `relDir = "<email>/<YYYY>/<MM>"`. `encodeURIComponent` escapes `/` → `%2F`, Next.js sees the result as **one segment** containing literal `/` after decoding → the route's `s.includes("/")` check returns 400. This broke the download / open-in-new-tab buttons even when the in-page `<img src>` worked (because the rendered preview was a `blob:` URL, not the server URL).

### Fix

**1. Pass user email through to providers.** Server-only `userEmail: string` added to `EditInput`; `GenerateSubmitBody = Omit<EditInput, "userEmail">` so the client cannot supply it. `app/api/generate/submit/route.ts` populates from the authenticated session:

```ts
const input: EditInput = { ...body, userEmail: user.email };
const result = await provider.submit(input);
```

**2. `saveBinary` / `downloadAndSave` / `saveBase64` now require `userEmail`** and write to `<HISTORY_IMAGES_DIR>/<email>/<YYYY>/<MM>/<UUID>.<ext>`. URL is built per-segment:

```ts
function buildPublicUrl(userEmail, yyyy, mm, filename) {
  return `/api/history/image/${encodeURIComponent(userEmail)}/${yyyy}/${mm}/${encodeURIComponent(filename)}`;
}
```

Per-segment encoding is the key invariant: encode each segment that may contain reserved chars (email, filename), but keep the `/` separators raw so the catch-all `[...path]` route splits cleanly into 4 segments.

**3. `app/api/history/route.ts` POST response** uses the same per-segment pattern:

```ts
const urlPrefix = `/api/history/image/${encodeURIComponent(user.email)}/${yyyy}/${mm}`;
return NextResponse.json({
  fullUrl: `${urlPrefix}/${encodeURIComponent(originalFilename)}`,
  thumbUrl: `${urlPrefix}/${encodeURIComponent(thumbFilename)}`,
  midUrl:  `${urlPrefix}/${encodeURIComponent(midFilename)}`,
});
```

**4. Provider call sites** (`comfy.ts` ×3, `fal.ts` ×1) pass `input.userEmail` through to `saveBinary`/`downloadAndSave`.

### Invariant going forward

> **Any code path that writes into `HISTORY_IMAGES_DIR` MUST place files under `<email>/<YYYY>/<MM>/`. Any code path that builds a URL pointing at `/api/history/image/...` MUST encode per-segment (email and filename separately), never `encodeURIComponent` the whole `<email>/<YYYY>/<MM>` slug.**

This is non-negotiable: the catch-all route's traversal check (`s.includes("/")`) and the auth check (`segs[0] === user.email`) both rely on per-segment cleanness.

### Orphan files

Pre-fix Comfy/Fal generations wrote files to flat `<HISTORY_IMAGES_DIR>/<UUID>.png`. Those files still exist and remain unservable (route requires ≥2 segments). They're orphans — no DB row points at them either, since the corresponding history entries were aborted by the variant-prep failure. Cleanup is optional. A one-time script could enumerate flat-layout files and `rm` them; not done in this session.

---

## Fix 3 — Polling timeout removed for slow Wavespeed generations

### Symptom

User saw "Polling timed out" after generating with Wavespeed + nano-banana-pro + text-to-image. No errors in server logs (correct: the polling loop is purely client-side). Image **did successfully complete** on Wavespeed's side (verified at https://wavespeed.ai/history): status `completed`, time taken **449.47s** (7m 29s), cost $0.14. Result never reached our local history — `pollUntilDone` threw before `saveToServerHistory` could run.

### Root cause

`components/generate-form.tsx:96` had `POLL_TIMEOUT = 5 * 60 * 1000`. nano-banana-pro on Wavespeed currently runs 7-8 minutes (cause unknown, possibly Vertex AI peak load on their side). Our 5-minute ceiling kicked in, threw `Polling timed out`, the error path marked the entry `failed` and never wrote to server history. The user paid for a generation we discarded.

The status-mapping branch (class C from the diagnosis) was ruled out: Wavespeed's reported status was `completed` — the same string our enum uses — so polling would have returned successfully had it been allowed to continue.

### Fix

Removed the cap. `pollUntilDone` is now `while (true)` with the same exit conditions:

- `handle.cancelled` → `throw new Error("cancelled")` (user clicked the cancel button on the OutputCard)
- `res.ok === false` → throws with the upstream error
- `data.status === "completed" || data.status === "failed"` → returns
- Page unload → polling loop dies naturally

There is no cap. If a task wedges genuinely on the upstream provider, the user cancels manually — same UX as before, but no false aborts on slow-but-progressing tasks.

### Two pieces of instrumentation added alongside

**Status-transition logging in `pollUntilDone`** — logs only when `data.status` changes from the previous value, not every poll. On a 7-minute generation that's 2-3 lines, not 300.

```
[poll] taskId=9a51c3ba... provider=wavespeed status=— → pending elapsed=1.5s
[poll] taskId=9a51c3ba... provider=wavespeed status=pending → processing elapsed=4.5s
[poll] taskId=9a51c3ba... provider=wavespeed status=processing → completed elapsed=449.5s
```

**Unknown-status warning in `wavespeed.getStatus`** — `WSPredictionResult.status` was type-asserted as `TaskStatus` but never validated. If Wavespeed ever returns a status string outside our enum (e.g. `"succeeded"`, `"queued"`), `pollUntilDone` would loop forever waiting for `"completed"`/`"failed"` that never come. The new warning surfaces the unknown string immediately:

```ts
const KNOWN: TaskStatus[] = ["pending", "processing", "completed", "failed", "cancelled"];
if (!KNOWN.includes(data.status)) {
  console.warn(`[wavespeed] unknown status "${data.status}" for taskId=${taskId} ...`);
}
```

### Open question — why is Wavespeed slow now?

Until recently the same model finished in ~1-2 minutes. Today's 449s is unusual. Possible causes (none actionable on our side):

- Pile-up at Vertex AI on Wavespeed's backend.
- Wavespeed routing slow generations through a discount-priority queue.
- Specific prompt content triggering longer Vertex AI compute.

If timings stay 7-8 min for nano-banana-pro long-term, consider auto-fallback to Comfy or Fal after a threshold. Don't ship that until you see >5% of generations exceeding 5 min.

---

## Fix 4 — Theme toggle moved into Настройки sidebar

### Symptom

Not a bug — UX cleanup. The theme toggle (sun/moon icon) lived in the form-card header alongside the model picker and user menu, contributing to header clutter. The user wanted to consolidate it with other "settings"-like controls.

### Change

Moved `<ThemeToggle />` from `components/playground.tsx` (form-card header at line 238) into `components/history-sidebar.tsx` header — placed on the right of the same `flex items-center justify-between` row as the close-button + Wrench icon + "Настройки" label.

```
Before (form card header):
[ Model selector .....................] [ ☀/🌙 ] [ User menu ]

After (form card header):
[ Model selector ........................................] [ User menu ]

After (Настройки sidebar header):
[ ← ] [ 🔧 ] Настройки                                    [ ☀/🌙 ]
```

### UX consequence to remember

The toggle is now reachable **only when the sidebar is open**. Users who keep the sidebar collapsed must open it to switch theme. The user accepted this trade-off as part of the consolidation request. If complaints surface, the simplest mitigation is to expose a second toggle in the sidebar's collapsed state (where the open-button currently lives in `OutputArea`).

---

## File map

```
lib/providers/
  comfy.ts          ← fetchWithRetry, upload-slot/PUT/Gemini all retried + logged
  fal.ts            ← downloadAndSave now passes userEmail
  wavespeed.ts      ← getStatus warns on unknown TaskStatus
  types.ts          ← EditInput.userEmail, GenerateSubmitBody Omit-ted

lib/
  image-storage.ts  ← saveBinary/downloadAndSave/saveBase64 require userEmail
                       layout: <HISTORY_IMAGES_DIR>/<email>/<YYYY>/<MM>/<uuid>.<ext>
                       URL: /api/history/image/<email>/<YYYY>/<MM>/<uuid>.<ext> (per-segment encoded)

app/api/
  generate/submit/route.ts  ← builds EditInput from body + user.email
  history/route.ts          ← POST returns per-segment-encoded URLs

components/
  generate-form.tsx ← pollUntilDone is while(true) with cancel/error escapes,
                       status-transition logging
  playground.tsx    ← form-card header dropped ThemeToggle
  history-sidebar.tsx ← Настройки header gained ThemeToggle on the right
```

---

## Open follow-ups

| Item | Why deferred | Trigger to revisit |
|---|---|---|
| Recovery for Wavespeed orphans (paid-for tasks completed upstream but lost locally) | One-time incident; no UI for it; would need a "restore by taskId" admin tool | If users start reporting "I paid for X and never got it" repeatedly |
| Cleanup script for flat-layout orphans in `HISTORY_IMAGES_DIR` | Cosmetic; orphans take disk space but harm nothing | Any time storage audit happens |
| Client-side submit retry / chunked upload | The original "failed to fetch" might be browser→server, not server→comfy. Server-side retry doesn't help that leg | If "failed to fetch" reports persist after the next reproducer with logs |
| Auto-fallback to Comfy/Fal when Wavespeed is slow | Architectural change with provider-routing implications | If >5% of Wavespeed generations exceed 5 min over a week |
| Per-model `POLL_INTERVAL` tuning (e.g. slower polling for slow models) | Premature optimisation; 1.5s × 7min = 280 polls is fine for one user | If polling load becomes measurable on the status route |

---

## Pitfalls — easy ways to re-break things

1. **Flat-layout writes to `HISTORY_IMAGES_DIR`.** If any new code calls `fs.writeFile` directly into the history images dir without the `<email>/<YYYY>/<MM>/` prefix, the resulting URL will 400. **Always go through `saveBinary` or follow its layout.**

2. **`encodeURIComponent` on a multi-segment slug.** Doing `encodeURIComponent("a/b/c")` produces `a%2Fb%2Fc` — one segment after Next.js decodes. The catch-all `[...path]` route's `s.includes("/")` check then blocks it as path traversal. **Always encode per-segment.**

3. **Casting upstream response status to our `TaskStatus` enum without runtime check.** `wavespeed.ts` already has the warn-on-unknown guard; if you add a third async provider, copy that pattern. Without the guard, an unrecognised status silently makes `pollUntilDone` infinite.

4. **Adding `POLL_TIMEOUT` back.** Don't. If a task wedges, the user has the cancel button. Adding a hard cap reintroduces the orphan-paid-task class of bugs.

5. **Forgetting to thread `userEmail`** when adding a new provider. `EditInput.userEmail` is required (not optional) precisely so TypeScript fails at compile time if a new provider's submit signature drops it.

6. **Skipping `fetchWithRetry` on a new upstream call in `comfy.ts` or `fal.ts`.** The asymmetry that caused Fix 1 was a single retry-bare call site. Any new `fetch(...)` to comfy.org / fal.run / s3-signed URL **must** go through `fetchWithRetry` (or a similar wrapper if the call's status semantics differ).
