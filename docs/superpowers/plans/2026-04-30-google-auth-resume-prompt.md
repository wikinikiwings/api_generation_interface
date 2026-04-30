# Continuation prompt — Google OAuth, branch `auth/google-oauth`

> Paste this as your first message in a fresh Claude Code session at this repo. Pick the path that matches what you've already done.

---

## Status snapshot (as of branch HEAD)

**Auth flow smoke-tested locally on 2026-04-30** by the user with real Google OAuth credentials. Login works, generations persist correctly, history hydrates with proper thumbs. Three small hotfixes landed during smoke:

- `864202c` — middleware: allow anonymous GET `/api/settings` (Providers hydrate on /login).
- `7427632` — history util/store: fix `extractUuid` regex + `serverGenToEntry` thumb/mid URL composition for the new `<email>/YYYY/MM/<uuid>.<ext>` layout (was matching only legacy flat layout).
- `b4c275a` — docs: setup guide + this resume-prompt.

Branch state: 51+ commits ahead of `main`, 220/220 vitest pass, `tsc --noEmit` clean. Ready for prod rollout per `2026-04-30-google-auth-rollout.md` (manual smoke list itself was NOT exhaustively run yet — only the basic login+generate path).

---

## Path A — coming back BEFORE you've configured Google OAuth

```
Возвращаемся к Google-OAuth работе на ветке auth/google-oauth. Все 38 задач плана реализованы (220 тестов проходят, ветка чистая, 48 коммитов ahead of main). Осталось:

1. Я настраиваю Google Cloud Console и .env.local впервые.
2. Прохожу manual smoke list (13 пунктов из спеки §11.3).
3. Если что-то ломается — фиксим вместе.
4. Если всё ок — мержим в main и катим на прод.

Прочитай:
- memory/project_google_auth_in_progress.md (статус-снэпшот)
- docs/superpowers/plans/2026-04-30-google-auth-setup-guide.md (полная инструкция dev→prod, шаги 1-7)
- docs/superpowers/plans/2026-04-30-google-auth-rollout.md (operator's deploy doc)

Я начинаю с шага 1 setup-guide (создание Cloud Console проекта + OAuth client). Помоги, если застряну, и напомни команды для смены DB / проверки auth_events.
```

---

## Path B — Google OAuth уже настроен, иду по smoke list

```
Возвращаемся к auth/google-oauth. Google Cloud Console + .env.local уже настроены, npm run dev работает, я могу залогиниться.

Сейчас прохожу manual smoke list (13 пунктов в docs/superpowers/plans/2026-04-30-google-auth-setup-guide.md шаг 7). Помогай по ходу:
- если какой-то пункт фейлит — анализируй auth_events table + server console + код, чини и коммить
- если всё проходит — финализируем (merge в main + апдейт MEMORY.md)

Прочитай memory/project_google_auth_in_progress.md для контекста. Начинаю с пункта [N].
```

---

## Path C — smoke прошёл, готовимся к проду

```
Возвращаемся к auth/google-oauth. Smoke list пройден локально. Готовимся катить на прод (lgen.maxkdiffused.org).

Прочитай docs/superpowers/plans/2026-04-30-google-auth-rollout.md и проведи меня по чек-листу:
- [ ] Google Cloud Console: добавить prod redirect URI
- [ ] Прод env vars (5 новых) + удалить ADMIN_PASSWORD
- [ ] Wipe history.db + WAL files на проде
- [ ] Deploy
- [ ] Первый admin login + invite остальных через /admin

Также проверь, что ветка ещё чистая (git status), 220 тестов проходят (npm test), и tsc clean (npx tsc --noEmit) — на случай если какие-то deps протухли или main двинулся вперёд.

Если хочешь — после успешного rollout сделай PR из auth/google-oauth в main и закрой задачу в MEMORY.md.
```

---

## Path D — что-то пошло не так в проде, нужен rollback

```
Прод сломался после rollout. Вижу [error message / behavior].

Прочитай:
- docs/superpowers/plans/2026-04-30-google-auth-rollout.md секция "Rollback (if needed)"
- последние 5 строк auth_events table на проде

Помоги: либо откатить на пред-OAuth коммит (восстановить ADMIN_PASSWORD env, вернуть legacy DB из бэкапа), либо хотфикс на ветке — выбираем по серьёзности.
```

---

## Path E — UI polish, auth уже работает

```
Auth flow на auth/google-oauth работает локально (smoke-tested). Сейчас хочу заняться UI polish — сделать визуально аккуратнее и удобнее. На данный момент:

- /login — простая карточка с кнопкой "Войти через Google" (app/login/page.tsx, минималистично)
- header — HeaderUserMenu (avatar + dropdown: email, Админка, Выйти; components/header-user-menu.tsx)
- /admin — 4 таба (Settings/Styles/Users/Models): components/admin-panel.tsx + components/admin/{users-tab,models-tab,styles-section}.tsx
- sidebar — 2 таба (История | Мои лимиты): components/history-sidebar.tsx + components/my-quotas-tab.tsx
- generate-form — кнопка с дизейблом по quota + status line под ней (components/generate-form.tsx ~190+)

Прочитай memory/project_google_auth_in_progress.md для контекста того что было сделано и как устроен flow.

Я хочу улучшить: [конкретные пункты]
- например: квота-карточки в sidebar выглядят сухо, можно добавить иконки/цвета
- например: admin-панель таблицы — slick row hover, sticky header, лучше empty states
- например: header avatar dropdown — анимация открытия, лучше typography

Помоги brainstorm + реализовать. Не трогай auth логику и API routes — они работают и протестированы. Только presentational слой.
```

---

## Что точно НЕ нужно делать в новой сессии

- Перезапускать с Task 1.1. Все 38 задач закрыты, не хочется случайно перезаписать `lib/auth/`.
- Удалять existing коммиты на `auth/google-oauth`. Ветка готова к merge.
- Запускать тесты, падающие по сетевым причинам (ничто на ветке не делает реальных HTTP-запросов в тестах — все используют `fetchImpl` injection).
- Отвечать вопросом "может, разделим работу на два PR?" — она уже сделана единым согласованным набором из 48 коммитов; делить уже поздно.

## Полезные команды

```bash
# Где мы:
git checkout auth/google-oauth && git log --oneline ^main | wc -l   # должно быть 48
git status                                                          # должно быть clean

# Проверка что ничего не сгнило:
npm test                                                            # 220/220
npx tsc --noEmit                                                    # exit 0

# Состояние DB после login:
sqlite3 data/history.db "SELECT id,email,role,status,last_login_at FROM users;"
sqlite3 data/history.db "SELECT id,event_type,email,timestamp FROM auth_events ORDER BY id DESC LIMIT 10;"

# Свежий SESSION_COOKIE_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Сброс dev DB (если что-то непоправимое в схеме):
rm -f data/history.db data/history.db-shm data/history.db-wal && npm run dev
```
