# Caddy 502 — Post-Ship Handoff

**Date:** 2026-05-25
**Branch:** `main` (single commit `0f1d946` ahead of origin)
**Status:** Shipped to prod (localgen.maxkdiffused.org). 3-minute post-restart window with 5 distinct client IPs of normal traffic showed **zero** `reverseproxy.statusError` 502s; only routine SSE client-cancellations remain (`reading: context canceled` WARN level — these are user-initiated tab closes / navigations and are normal). 24h+ confirmation still pending at time of writing.
**Intended readers:** any future agent or engineer touching the deploy pipeline, the reverse-proxy setup, Node HTTP timeouts, or anything that walks the upstream socket path.

## Quick-nav

- [What users saw](#what-users-saw)
- [Two-part problem](#two-part-problem)
- [Root cause — the keep-alive race in 30 seconds](#root-cause--the-keep-alive-race-in-30-seconds)
- [Diagnosis path — what didn't work, what did](#diagnosis-path--what-didnt-work-what-did)
- [What shipped](#what-shipped)
- [How to verify the fix is live](#how-to-verify-the-fix-is-live)
- [Pitfalls](#pitfalls)
- [Open follow-ups](#open-follow-ups)

---

## What users saw

A user on a browser tab that had been open since before the day's deploys reported `Upload failed: HTTP 502` toasts during normal img2img generations. Comfy provider, mid-day, intermittent. Generation file ended up on disk (provider's `downloadAndSave` already wrote it), but the `generations` row was never created → image was invisible in history and "Сгенерировано сегодня".

Caddy access log corroborated: 6+ `ERROR` `reverseproxy.statusError` 502 entries in a 16-minute window, on POSTs to `/api/history` and `/api/generate/submit`, from three distinct client IPs. SSE GETs (`/api/history/stream`) were aborting in parallel with `reading: context canceled`.

## Two-part problem

This branch fixed two separate issues that surfaced through the same symptom:

1. **Infra — keep-alive race between Caddy and Node** (the actual root cause of the 502s, see next section).
2. **App — non-idempotent retry path** (orthogonal; even if 502s reappear in the future, retries now recover gracefully instead of dropping the generation).

The two are deployed together but are logically independent and could be reverted separately.

## Root cause — the keep-alive race in 30 seconds

Caddy reverse-proxies `localgen.maxkdiffused.org → 127.0.0.1:3000` (Next.js standalone container). The Caddyfile has no explicit `transport http` block, so Caddy uses Go's `net/http.Transport` defaults — including `IdleConnTimeout ≈ 120s` and a per-host idle conn pool.

Node.js `http.Server` defaults `keepAliveTimeout = 5000ms`. Next.js standalone doesn't override this. So:

- Caddy keeps an idle upstream conn for up to ~120s.
- Node closes its end (sends FIN) after 5s of idleness.
- For the next ~115s, Caddy's pool holds a connection that is half-dead from Node's perspective.
- When Caddy pulls that conn to forward a new POST, the first body write hits a half-closed socket → kernel returns RST → Caddy logs `readfrom tcp ... write tcp ...: use of closed network connection` (or Windows-specific `wsasend: An existing connection was forcibly closed by the remote host`) and responds 502 to the client.

Why POSTs and not GETs: GETs are small enough that Caddy reads the response (or notices the close) before its write hits the dead socket. POSTs with multi-MB bodies put bytes onto the stale socket immediately, so the failure surfaces during the request, not after.

Why bursts: under activity the pool accumulates idle conns, all of which Node closes at 5s. The bursts of 502s correspond to bursts of pool-reuse with bursts of stale conns.

Why no Node logs: Node just closes the idle TCP conn. There's no handler error, no exception, no `console.log` from any application code. The only Node-side trace is the occasional `[Error: aborted] { code: 'ECONNRESET' }` from request bodies that *were* mid-read when the proxy closed its end — and those happen far away in time from the Caddy 502 window (they're regular client-disconnect noise).

This is a textbook Node-behind-reverse-proxy bug. The canonical write-up is the AWS ALB version: https://adamcrowder.net/posts/node-express-api-and-aws-alb-502/ — same mechanism applies to Caddy, nginx, or any pooling proxy.

## Diagnosis path — what didn't work, what did

The path mattered as much as the conclusion. Future-you should mirror it when chasing similar incidents.

**Eliminated by `docker inspect` + `docker logs` (run on host, not inside container):**

- Process crash. `RestartCount=0`, `OOMKilled=false`, `ExitCode=0`, container uptime 4 days. Not a crash.
- Memory pressure. `docker stats` showed 108MB / 15GB limit, no leak.
- Heap OOM. No `JavaScript heap out of memory`, no stack traces, no unhandled rejections in 2038 lines of an 8-hour log window.

**Eliminated by curl reproduction (`Invoke-WebRequest` from PowerShell):**

- Initial leading hypothesis: "Handler returns 401 early on invalid session, Node closes socket while Caddy still writes body". Tested by POSTing 5MB to `/api/history` with (a) no cookie (hits middleware 401), (b) garbage cookie (hits route-handler 401). **Both returned 401 cleanly, no 502.** Hypothesis dead. The simple "early-401 with large body" pattern is NOT how Node + Caddy interact on localhost loopback.

**Confirmed by Caddyfile inspection + load pattern:**

- User shared the Caddyfile. No `transport http` override → Go defaults → 120s upstream idle. Math:  `Caddy idle 120s vs Node idle 5s = 115s race window`. Matches symptom exactly: POST-only, no Node logs, intermittent.

The instinct on first reading the Caddy errors was to suspect application-level early termination. **It wasn't.** When you see `use of closed network connection` from a Caddy → Node loopback in front of a never-crashing Node process, the keep-alive race is the leading hypothesis. Validate Node `keepAliveTimeout` against proxy `IdleConnTimeout` *first*, before touching app code.

## What shipped

Single commit `0f1d946 fix(history,infra): recover from Caddy 502 — retry + idempotent POST + Node keep-alive`. Six files:

### `server-wrap.js` (new file, repo root)

Wraps Next.js's generated standalone `server.js`. Before requiring it, patches both `http.createServer` and `https.createServer` (defense in depth — `node_modules/next/dist/server/lib/start-server.js:169` picks one based on a `selfSignedCertificate` flag) so that every server instance gets:

- `keepAliveTimeout = 120_000ms` — must exceed Caddy upstream idle (~120s default).
- `headersTimeout = 125_000ms` — Node requires this to be strictly greater than `keepAliveTimeout`.

The wrapper re-applies the timeouts on the server's `'listening'` event in case anything mutates them after `createServer` returns.

### `Dockerfile` + `simple_build/Dockerfile`

Both runner stages now `COPY --from=builder /app/server-wrap.js ./server-wrap.js` and `CMD ["node", "server-wrap.js"]` instead of directly invoking `server.js`. The wrapper then `require('./server.js')` after the patches are installed.

### `lib/history-db.ts` — `findGenerationByOutputPath(user_id, filepath)`

New helper. Joins `generations` ⨝ `generation_outputs` and returns the row matching `(user_id, output filepath, status != 'deleted')`. Filepath embeds the uuid (`<email>/YYYY/MM/<uuid>.<ext>`) so it's globally unique. Used for DB-level idempotency on `/api/history` POST.

### `app/api/history/route.ts` — DB-idempotent POST

Before the `saveGeneration` INSERT, the handler now calls `findGenerationByOutputPath(user.id, outputFilepath)`. On hit, it returns the existing row's id without inserting. The `generation.created` + `admin.user_generated` SSE broadcasts are gated on `!existing` so retries don't inflate admin counters.

Combined with the pre-existing file-level idempotency (`oExists` skip on the original write), the entire POST `/api/history` is now safely retriable: same uuid → same row, no duplicate files, no duplicate SSE events.

### `lib/history-upload.ts` — client retry on 502/503/504

`uploadHistoryEntry()` now retries up to 2 times (3 attempts total) with `5s → 10s → 15s` backoff on:

- HTTP status 502 / 503 / 504.
- Network errors (`TypeError: Failed to fetch`, abort-by-network, etc.).

`AbortError` from the user's explicit cancel is surfaced immediately and never retried. The backoff sleep is itself `AbortSignal`-aware via `sleepWithSignal()` — the user can cancel during the wait. Mirrors the server-side `fetchWithRetry` pattern in `lib/providers/comfy.ts`.

This is the "even if the keep-alive race resurfaces, users don't lose history rows" safety net.

## How to verify the fix is live

After a rebuild + restart of the container, two checks confirm the wrapper actually applied:

```cmd
:: Wrapper file is in the image
docker exec wavespeed-claude ls -la /app/server-wrap.js

:: Server's runtime keepAliveTimeout is now 120s, not the Node default 5s
docker exec wavespeed-claude node -e "const h=require('node:http');const s=h.createServer((q,r)=>r.end());console.log('keepAlive:',s.keepAliveTimeout,'headers:',s.headersTimeout);s.close()"
```

Expected: `keepAlive: 120000 headers: 125000`. If you see `5000 / 60000`, the wrapper didn't get applied — either the commit wasn't pushed before `start.ps1` ran, or `CACHEBUST` wasn't refreshed and Docker reused the cached git-clone layer.

For longer-term confirmation, watch Caddy's access log for `reverseproxy.statusError`:

```cmd
type "<caddy access log>" | findstr /C:"reverseproxy.statusError"
```

Before the fix this fired multiple times per active minute. After the fix it should approach zero. (Routine `aborting with incomplete response` WARNs with `reading: context canceled` on `/api/history/stream` are normal client-disconnect SSE behavior — different signal, leave them alone.)

## Pitfalls

**Don't use `docker compose up -d` from a different working directory without setting `ENV_FILE` AND `CACHEBUST`.** The user hit `env file not found: ./env` because the compose default `env_file: ${ENV_FILE:-./env}` looks for a literal `./env` (no dot) relative to the compose file. The `start.ps1` / `start.sh` scripts set both `ENV_FILE` and `CACHEBUST` correctly — prefer those over raw `docker compose`. If you must invoke compose directly: `$env:ENV_FILE = "...\\.env.local"` and `$env:CACHEBUST = [int][double]::Parse((Get-Date -UFormat %s))` first. Without a fresh `CACHEBUST`, Docker reuses the cached `git clone` layer in `simple_build/Dockerfile` and you build with stale code — the wrapper won't even be in the image.

**`simple_build/` builds from GitHub HEAD, not local files.** The `git clone --depth=1 --branch=${REPO_BRANCH}` line clones the public repo `wikinikiwings/api_generation_interface`. Any commit you want in the image must be pushed first. Forgetting this manifests as "I fixed it but the bug is still there" — your local commit isn't on origin yet.

**Don't lower Caddy's `keepalive_idle_conns_timeout` instead of raising Node's `keepAliveTimeout`.** Same effect on the race window, but if the operator later changes the proxy (nginx, Cloudflare Tunnel, etc.), the fix has to be re-discovered. Raising Node's timeout is portable across proxies.

**`headersTimeout` must be strictly greater than `keepAliveTimeout`.** Node has internal logic that compares them; if they're equal or inverted, keep-alive starts dropping prematurely. We use 120s vs 125s.

**The wrapper relies on `require('./server.js')` finding the Next.js standalone entry at `/app/server.js`.** If a future Next.js version moves the standalone entry, the wrapper will break with `Cannot find module './server.js'`. Easy to catch — container won't start. Easy to fix — adjust the path. But be aware the wrapper is a thin shim over Next.js's generated server, not an independent server.

## Open follow-ups

- **Caddyfile lint warnings.** Caddy logs two cosmetic WARNs on startup: `Unnecessary header_up X-Forwarded-Proto` and `Unnecessary header_up X-Forwarded-For` — Caddy v2 passes these by default. Drop the two `header_up` lines from `localgen.maxkdiffused.org { reverse_proxy ... }` and run `caddy fmt --overwrite` + reload. Zero functional impact.

- **24h confirmation.** At time of post-ship, only 3 minutes of post-restart traffic observed without 502. Keep eye on Caddy access log for the next day or two before fully closing.

- **Orphan recovery for pre-fix incidents.** The retry + idempotency are forward-looking — pre-existing orphaned files (image on disk, no DB row from a past 502) need to be reconciled via the admin "Превью / History state" tab's orphan tools. Not done automatically; admin-triggered.

- **`/api/generate/submit` retries.** Client retry was added only to `/api/history`. If `/api/generate/submit` 502s in the future (it can — same race), we *don't* retry because the underlying provider call (Gemini, WaveSpeed, Fal) is non-idempotent and would charge API credits twice. The keep-alive fix prevents this from happening in the first place, but if it ever does, the loss is at most one credit per stuck request, not a duplicated history row.
