# DB retention / archival — FUTURE (Variant 1)

**Date:** 2026-06-29
**Status:** Not started — future work. This is a placeholder to preserve intent,
not a design. When picking it up, run the brainstorming skill first.

## Why this exists

This is **Variant 1** of the two-part `prompt_data` slimming plan. Variant 2
(prompt de-duplication — drop the persisted wrapped prompt) shipped on
2026-06-29 (see `2026-06-29-prompt-dedup-style-normalization-design.md` and the
`prompt-dedup-wrapped` memory). Variant 2 shrinks each row *now*; Variant 1
bounds DB growth *over time*. They are independent and deliberately separate
specs.

## The problem it addresses

Even after Variant 2, `prompt_data` is plain text that grows roughly linearly
with usage. Generations accrue at ~17–20k rows/month (measured: ~24.8k rows in
~43 days as of late June 2026). With no retention policy the hot DB keeps
growing indefinitely. The original slowness ([[db-prompt-data-bloat]]) is fixed
architecturally (covering index `idx_generations_user_created_status` makes the
hot admin query index-only, and rows are now ~1 KB), so **size alone will not
reproduce that problem** — but unbounded growth still affects backups, cold
queries that must read `prompt_data`, and general operability. Retention is the
"bound it regardless of rate" answer.

## Current facts to start from (re-measure when resuming)

- After Variant 2 migration: prod `history.db` ~44 MB, ~24.8k generations.
- DB path: `C:\viewcomfy_data\database\history.db` (host == dev machine;
  read-only queryable with `sqlite3 -readonly`).
- Hot admin query is already index-only; do not regress that.

## Open design questions (for the brainstorm, do NOT pre-decide)

- **What to archive:** generations older than N months? Per-user caps? Only
  `completed`/`deleted`?
- **Where:** separate archive SQLite file / cold table / export to disk / delete
  outright? Reversible vs one-way?
- **Image files:** the on-disk outputs + inputs (`HISTORY_IMAGES_DIR`,
  `HISTORY_INPUTS_DIR`, variants) for archived rows — archive/delete those too,
  or leave?
- **Runtime interaction:** history reads, the cross-device-delete invariant
  (see `serverGenToEntry`/`applyServerList` in `lib/history/store.ts`), admin
  stats, SSE — what breaks if rows vanish from the hot table?
- **Automation:** one-time + manual rerun (like the migration scripts) vs a
  scheduled job? Operator-gated like prior migrations.
- **Backups:** does archival change the backup story?

## How to resume

Start a session and paste a prompt like:

> Возвращаемся к Варианту 1 из плана сжатия `prompt_data` — retention/архивация
> старых генераций, чтобы ограничить рост прод-базы во времени. Контекст в
> `docs/superpowers/specs/2026-06-29-db-retention-archival-future.md` и в памяти
> `prompt-dedup-wrapped` / `db-prompt-data-bloat`. Вариант 2 (де-дупликация
> промпта) уже в проде. Прогони brainstorming по Варианту 1: сначала перемерь
> текущий размер/темп роста базы, потом разложи открытые вопросы из future-дока
> (что архивировать, куда, что с файлами картинок, как не сломать
> cross-device-delete и админ-статистику, автоматизация vs ручной запуск).

The brainstorming skill will re-read this file, re-measure the DB, and turn the
open questions above into a real spec → plan → implementation cycle.
