# Resume Prompt — Input Images Disk Storage (subagent-driven execution)

**Use this to continue execution in a fresh session.** Paste the "PROMPT" block below as the first message.

---

## PROMPT

Continue the subagent-driven execution of the **input-images-disk-storage** feature. Invoke the `superpowers:subagent-driven-development` skill and resume from the progress ledger — do NOT re-dispatch completed tasks.

**Workspace (critical):**
- All implementation happens in the git worktree at **C:/dev/aig-input-images**, branch `feat/input-images-disk-storage`. This is a SEPARATE directory from the default project `C:/dev/api_generation_interface`. Every subagent you dispatch must be told to `cd "C:/dev/aig-input-images"` and do all work there.
- Git identity is already configured in this repo (`wikinikiwings <weaking1@gmail.com>`). Deps are installed in the worktree (`better-sqlite3` builds & loads). Node 25.
- Helper scripts (run them from inside the worktree so they resolve the worktree workspace):
  `C:/Users/Maxim_Korneev/.claude/plugins/cache/claude-plugins-official/superpowers/6.0.3/skills/subagent-driven-development/scripts/{task-brief,review-package,sdd-workspace}`

**State:**
- Plan: `docs/superpowers/plans/2026-06-22-input-thumbnails-disk-storage.md` (in the worktree).
- Ledger: `.superpowers/sdd/progress.md`. **Tasks 1, 2, 3 are COMPLETE** (review-clean), branch HEAD = `84b4f02`. **Resume at Task 4.**
- Check the ledger and `git log --oneline 01133a8..HEAD` first; trust them over memory.

**Process per task (from the skill):**
1. `task-brief PLAN N` → brief file. Record BASE = current branch HEAD before dispatching.
2. Dispatch ONE implementer (general-purpose) — tell it the worktree dir, the brief path, the report path (`.superpowers/sdd/task-N-report.md`), and any cross-task interfaces/decisions. It does TDD, commits, self-reviews, reports status.
3. `review-package BASE HEAD` → diff file. Dispatch a task reviewer (general-purpose) with brief + report + diff paths + the plan's Global Constraints (copy verbatim). It returns spec + quality verdicts.
4. Dispatch a fix subagent for any Critical/Important findings; re-review. Record Minor findings in the ledger for the final review.
5. Append `Task N: complete (commits <base7>..<head7>, review clean)` to the ledger. Next task.

**Model selection (specify explicitly every dispatch):**
- Implementers on tasks whose brief contains complete code = transcription+testing → **haiku**.
- Implementers on tasks with mock/integration/auth-stub nuance → **sonnet**.
- Reviewers → **sonnet** (mid-tier floor).
- Final whole-branch review → most capable model.

**Remaining tasks (4–10) and their gotchas:**
- **Task 4** — upload contract (`lib/history-upload.ts`): add `inputImages`/`inputThumbs` params + `inputCount`/`inputfull_<i>`/`inputthumb_<i>` parts. Complete code in brief → haiku. BASE = `84b4f02`.
- **Task 5** — POST `/api/history` writes full+thumb, injects `inputThumbnails`+`inputImages` URLs; new pure helper `app/api/history/input-asset-urls.ts`. Has a route-level integration test with an **auth-mock ordering caveat** (the brief NOTEs it — `vi.doMock` after import may not apply; may need top-of-file `vi.mock`). → sonnet.
- **Task 6** — read side: `serverGenToEntry` parses both arrays; add `inputImages?: string[]` to `HistoryEntry` (`lib/history/types.ts`). → sonnet (touches store + types).
- **Task 7** — wire `generate-form.tsx`: upload `images[i].file` (full) + thumb blob; remove base64 `inputThumbnails` from stored payload. **No unit test** (React glue); verified by `npx tsc --noEmit` + `npx vitest run` + `npx next build` (build is slow). → sonnet.
- **Task 8** — hard-delete renames the inputs root too (`app/api/admin/users/[id]/route.ts`); test has admin auth-stub. → sonnet.
- **Task 9** — **operator-gated verification gate, NOT code**: (a) check whether `viewcomfy-claude` (shared DB) reads `inputThumbnails`/`inputImages` from `prompt_data` — ask the user for its checkout path; if it does and can't resolve the URLs, STOP before Task 10. (b) forward-path E2E. Do not run the Task-10 backfill until this clears.
- **Task 10** — backfill script `scripts/migrate-input-thumbnails.mjs` (legacy thumbnails → disk + URLs, VACUUM) + tests → haiku/sonnet. **Steps 5-8 (dry-run on a prod copy, real run, and the PRODUCTION runbook) are operator-gated — present them, do not run the prod migration yourself.**

After Task 10's code lands and review is clean: run a final whole-branch review (`review-package $(git merge-base main HEAD) HEAD`, most-capable model), dispatch ONE fix subagent for any findings, then use `superpowers:finishing-a-development-branch`.

**Key decisions already locked (do not re-litigate):**
- Per input: store BOTH full-res (`input_<uuid>_<n>.<ext>`, for faithful restore) AND 240px thumbnail (`input_thumb_<uuid>_<n>.jpg`, for display). Two `prompt_data` fields: `inputThumbnails` (display) + `inputImages` (restore).
- Legacy rows only ever had 240px base64 thumbnails → backfill writes thumbnails only, no `inputImages`.
- Backward-compatible read: `inputThumbnails` may be base64 (legacy) or URL (new) — both valid `<img src>`.
- The **restore-inputs UI is a deliberate follow-up**, NOT part of this plan. This plan only lays the data foundation (both arrays surfaced on `HistoryEntry`).

**Separate, unrelated:** the users-tab performance fix (covering index + GROUP BY rewrite + SSE debounce) is left **uncommitted in the main working tree** at `C:/dev/api_generation_interface` by the user's choice. Do not touch it from this worktree.

---

## Quick status snapshot (at handoff)

| Task | State |
|---|---|
| Plan + Tasks 1–3 | ✅ committed & review-clean (HEAD `84b4f02`) |
| Task 4 | brief generated (`.superpowers/sdd/task-4-brief.md`), NOT dispatched |
| Tasks 5–10 | not started |

Branch base: `01133a8` (main). Merge target: `main`.
