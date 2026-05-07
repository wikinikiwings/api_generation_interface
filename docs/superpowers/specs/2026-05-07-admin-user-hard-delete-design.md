# Жёсткое удаление пользователя из админки

**Дата:** 2026-05-07
**Ветка:** `auth/google-oauth`
**Статус:** design (готов к написанию плана)

## 1. Проблема

Soft-delete пользователя через PATCH `status='deleted'` (`app/api/admin/users/[id]/route.ts`) сохраняет ряд в `users`. Поскольку `email` имеет `UNIQUE COLLATE NOCASE` (`lib/history-db.ts:50`), повторное добавление того же email через POST `/api/admin/users` упирается в UNIQUE-constraint и возвращает 409 → тост «Уже существует».

Текущий выход — включить «Показать удалённых» и нажать «Восстановить». Но это разные семантики: «восстановить старого» ≠ «начать с чистого листа». Сейчас второго варианта нет вообще.

## 2. Цель

Дать админу действие «Стереть навсегда»:
- освобождает email-слот в БД (можно завести нового юзера с тем же адресом);
- сохраняет физический архив сгенерированного контента на диске под отдельным именем (`deleted_{email}/`) на случай ручного восстановления;
- сбрасывает рядом со архивом сводный CSV-отчёт о тратах юзера (по моделям, по месяцам), чтобы биллинг-историю можно было реконструировать без БД;
- защищён двухступенчатым жестом и подтверждением вводом email.

## 3. UX

### 3.1 Триггер кнопки

В `components/admin/users-tab.tsx` на строке с `status='deleted'` (видна только при включённой галке «Показать удалённых») рядом с «Восстановить» появляется новая кнопка **«Стереть навсегда»** (текст красный, отдельная от существующего блока сегментированных действий или внутри него — на усмотрение implementer'а, важно визуальное отличие от обратимых операций).

Кнопка недоступна (или скрыта) для строки текущего админа: `u.id === me.id` → ничего не показываем. (Защита от случая, когда другой админ ранее soft-delete'нул этого админа, тот залогинился до деактивации сессии и теперь видит свою же строку — практически невозможно, но проще исключить.)

### 3.2 Модалка подтверждения

Отдельный компонент (не `window.confirm`). Содержит:
- заголовок «Стереть пользователя навсегда»;
- предупреждение красным: «Это действие необратимо. Будет удалено из базы: пользователь, N генераций, M файлов оверрайдов квот.»;
- предпросмотр: «Папка `{email}/` на диске будет переименована в `{target}/` (CSV-сводка останется внутри).» Здесь `{target}` — заранее вычисленное на клиенте на основе ответа сервера или, проще, просто `deleted_{email}` (точное имя финализируется на сервере; если нумерация сместится из-за конкурентного доступа — это косметика);
- поле ввода: «Для подтверждения введите email пользователя:»;
- кнопка «Стереть» дизейблится, пока введённый текст (после `.trim().toLowerCase()`) не совпадёт ровно с `u.email`;
- кнопка «Отмена».

После успеха — toast «Пользователь стёрт навсегда», список пользователей перефечится по SSE-эвенту (см. §7).

## 4. API контракт

Новый метод в `app/api/admin/users/[id]/route.ts`:

```
DELETE /api/admin/users/[id]
Body: { confirmation_email: string }
```

### 4.1 Валидация

1. requireAdmin (как в существующих handler'ах).
2. `userId === me.id` → 400 `{ error: "self_purge_forbidden" }`.
3. SELECT user; если не найден — 404 `{ error: "not_found" }`.
4. Если `status !== 'deleted'` → 409 `{ error: "must_be_soft_deleted_first" }`.
5. `confirmation_email.trim().toLowerCase() !== user.email` → 400 `{ error: "confirmation_mismatch" }`.

### 4.2 Успешный ответ

```json
{
  "ok": true,
  "purged": {
    "email": "alice@tapclap.com",
    "generations_deleted": 117,
    "folder_renamed_to": "deleted_alice@tapclap.com",
    "summary_csv_written": true
  }
}
```

### 4.3 Ошибки серверной фазы

- 500 `{ error: "summary_write_failed", detail }` — не смогли записать CSV до DB-удаления; БД не тронута.
- 500 `{ error: "db_delete_failed", detail }` — ничего не зафиксировано (всё в одной транзакции). CSV-файл мог остаться внутри `{email}/` — это ок, на повторе будет перезаписан.
- 200 с предупреждением `{ ok: true, purged: {...}, warning: "rename_failed", target: "..." }` — БД зачистилась, но переименование папки упало. Клиент показывает дополнительный toast с инструкцией ручного rename'а (см. §6).

## 5. Серверная логика — порядок операций

Внутри handler'а:

```
1. Валидация (4.1).
2. Прочитать сводку:
     SELECT strftime('%Y', g.created_at) AS yr,
            strftime('%m', g.created_at) AS mo,
            g.model_id,
            COALESCE(m.display_name, g.model_id) AS display_name,
            COUNT(*) AS cnt
     FROM generations g
     LEFT JOIN models m ON m.model_id = g.model_id
     WHERE g.user_id = ?
       AND g.status IN ('completed','deleted')
     GROUP BY yr, mo, g.model_id
     ORDER BY yr DESC, mo DESC, cnt DESC;
   Также SELECT COUNT(*) для total.
3. Если есть хотя бы одна гена (total > 0):
     - Убедиться что папка `history_images/{email}/` существует
       (если нет — пропустить запись CSV: гены есть в БД, но файлов
       уже нет физически; такое возможно после ручного вмешательства
       и не должно блокировать operation).
     - Сформировать содержимое CSV (см. §5.2).
     - Записать в `history_images/{email}/_SUMMARY.csv` через fs.writeFile.
       Если запись падает → return 500 summary_write_failed. БД не трогаем.
4. DB-транзакция (better-sqlite3 db.transaction):
     a. DELETE FROM generation_outputs
          WHERE generation_id IN (SELECT id FROM generations WHERE user_id=?);
     b. DELETE FROM generations WHERE user_id=?;
     c. DELETE FROM users WHERE id=?;     -- CASCADE добивает sessions/quotas/preferences
   Транзакция автоматически роллбекает при любой ошибке. Если упало →
   500 db_delete_failed; CSV в `{email}/_SUMMARY.csv` остался — это
   приемлемо.
5. writeAuthEvent({
     event_type: 'admin_user_purged',
     user_id: me.id,
     email: user.email,           // зафиксировано отдельной колонкой
     details: {
       target_id: userId,
       target_email: user.email,
       generations_purged: total,
       folder_rename_target: target,   // имя, которое попытаемся применить
     }
   });
6. fs.rename(`{HISTORY_IMAGES_DIR}/{email}`, `{HISTORY_IMAGES_DIR}/{target}`).
   Где target — первое свободное имя из последовательности
   `deleted_{email}` → `deleted_2_{email}` → `deleted_3_{email}` → ...
   (выбирается ПЕРЕД rename'ом через fs.access на каждом кандидате).
   Если папки `{email}/` не существует (юзер не генерил) → пропустить.
   Если rename упал → лог + не валим ответ; в JSON приходит
   `warning: "rename_failed"` с сохранённым target'ом.
7. broadcastToAllAdmins({ type: 'admin.user_purged', user_id: userId }).
   (См. §7.)
```

### 5.1 Свобода от race-условий

К моменту hard-delete `status='deleted'` уже стоит, сессии вычищены через `deleteSessionsForUser` (см. soft-delete path в `app/api/admin/users/[id]/route.ts:64`). Это значит юзер не может писать в свою папку или создавать новые ряды в `generations` параллельно с операцией. Параллельный hard-delete двумя админами одновременно теоретически возможен — second win получит 404 (юзер уже удалён) и корректно отвалится; SSE довытолкнет обновление.

### 5.2 Формат CSV

Файл `_SUMMARY.csv`. Подчёркивание в начале — чтобы файл всплывал в листинге папки.

```
# email: alice@tapclap.com
# purged_at: 2026-05-07T13:45:00.123Z
# total_generations: 117
year,month,model_id,model_display_name,generations
2026,05,nano-banana-pro,Nano Banana Pro,42
2026,05,seedream-4-5,Seedream 4.5,17
2026,04,nano-banana-pro,Nano Banana Pro,55
2026,04,seedream-5-0-lite,Seedream 5.0 Lite,3
...
```

Три комментарных строки (`#`) в начале — это нестрогое расширение CSV. Excel/Numbers/LibreOffice через мастер импорта позволяют указать `#` как символ комментария. Pandas: `pd.read_csv('_SUMMARY.csv', comment='#')`. В чистом текстовом виде файл остаётся читаемым человеком.

Сортировка: год DESC, месяц DESC, count DESC внутри месяца — самые свежие траты сверху, и в каждом месяце — самая «жирная» модель первой.

Кодировка — UTF-8 без BOM. Перенос строк — `\n` (LF), кросс-платформенно.

### 5.3 Generations с `model_id = NULL`

Старые ряды (до 2025) могут не иметь model_id. В CSV для них `model_id = ""` (пустая строка), `model_display_name = "(unknown)"`. Это даёт человекочитаемую подсказку при просмотре файла и не ломает CSV-парсеры.

## 6. Схема имён `deleted_*`

Алгоритм поиска свободного имени:

```ts
let target = `deleted_${email}`;
let n = 2;
while (await exists(path.join(HISTORY_IMAGES_DIR, target))) {
  target = `deleted_${n}_${email}`;
  n++;
}
```

- 1-е удаление: `deleted_alice@tapclap.com/`
- 2-е удаление того же email: `deleted_2_alice@tapclap.com/`
- 3-е: `deleted_3_alice@tapclap.com/`

Если админ вручную удалил с диска `deleted_2_alice@tapclap.com/`, то на 4-м удалении мы займём слот «2» (первый свободный) — это компактнее и не заставляет помнить «всю историю» удалений. Это поведение принято при дизайне.

Edge case: пустая папка `{email}/` (юзер ничего не генерил, но папка как-то создалась) → rename всё равно произойдёт. Папка останется пустой под именем `deleted_*`. Безвредно.

Edge case: rename упал (Windows file lock, busy handle) → юзер уже удалён из БД, email слот свободен. Если админ заведёт нового с тем же email и тот сразу пойдёт генерить → новые файлы попадут в ту же папку `{email}/`. Коллизий имён не будет (uuid + collision-check в `app/api/history/route.ts:143`), но сводный CSV старого юзера окажется рядом со свежими файлами. Митигация:
- сервер вернёт `warning: "rename_failed"` с target'ом;
- клиент покажет toast «Папка не переименована, переименуйте вручную: `{email}/` → `{target}/`»;
- audit-запись `admin_user_purged` уже зафиксировала намерение.

## 7. Audit и SSE

### 7.1 Audit

Новый `event_type: 'admin_user_purged'`. Запись делается **до** rename'а (между шагами 5 и 6 из §5), чтобы в логе осталась запись намерения даже если rename упадёт.

`details` JSON фиксирует email удалённого юзера в поле `target_email` (мирроринг существующего паттерна `admin_user_created` в `app/api/admin/users/route.ts:47`) — это важно, потому что через секунду user-row в БД исчезнет, и связь по `auth_events.user_id` (без FK) станет «мёртвой», а `target_email` сохранит имя для последующего разбора.

Полный `details`: `target_id`, `target_email`, `generations_purged`, `folder_rename_target`.

### 7.2 SSE

Новый эвент `admin.user_purged` фанаутится через тот же путь, что и `admin.user_generated` (см. `lib/sse-broadcast.ts` или ту же helper-функцию). Payload: `{ user_id: number }`.

В `components/admin/users-tab.tsx` добавляем listener: на `admin.user_purged` дёргаем `refetch()` — строка уйдёт из таблицы естественным образом (юзер удалён из БД).

Существующая обёртка try/catch вокруг admin SSE fan-out (см. шипнутый паттерн `feat(sse): wrap admin fan-out helpers in try/catch` — коммит `e3ad6a3`) распространяется и на новый эвент.

## 8. Изменения схемы БД

Никаких. Все необходимые FK уже на месте:
- `sessions.user_id` → CASCADE
- `user_quotas.user_id` → CASCADE
- `user_preferences.user_id` → CASCADE
- `generations.user_id` → RESTRICT (намеренно оставляем; ручной DELETE generations внутри транзакции до DELETE users)
- `auth_events.user_id` — без FK (нужно для сохранения paper trail)

Миграция не требуется.

## 9. План тестов

Юнит/интеграционные на новый handler:

- ✅ DELETE на юзера с `status='active'` → 409 `must_be_soft_deleted_first`.
- ✅ DELETE на самого себя → 400 `self_purge_forbidden`.
- ✅ DELETE без `confirmation_email` или с неверным → 400 `confirmation_mismatch`.
- ✅ DELETE на корректную цель → user/gen/outputs ушли из БД, sessions/quotas/preferences тоже (CASCADE), `auth_events` остались (бесфковая запись + новая `admin_user_purged`).
- ✅ DELETE на юзера без ген → пропуск шагов 2-3, чистая работа.
- ✅ DELETE на юзера с генами → `_SUMMARY.csv` записан с корректным агрегатом, папка переименована в `deleted_{email}`.
- ✅ Повторный DELETE того же email после re-add + re-soft-delete → папка переименована в `deleted_2_{email}`.
- ✅ Симуляция fs.rename failure → 200 с `warning: "rename_failed"`, БД зачищена, audit-запись присутствует.
- ✅ Симуляция fs.writeFile failure (CSV) → 500 `summary_write_failed`, БД не тронута.
- ✅ Email слот после успешного DELETE → POST `/api/admin/users` с тем же email → 201 ok (новый id).

## 10. Вне скоупа

- Hard-delete без предварительного soft-delete (одноступенчатое стирание) — намеренно не делаем; двухступенчатость защищает от случайного клика.
- Восстановление из `_SUMMARY.csv` обратно в БД (импорт сводки в `generations`) — слишком много допущений; если когда-нибудь понадобится, делаем отдельной задачей.
- Bulk-purge нескольких юзеров одной операцией.
- Архивация/упаковка папки `deleted_{email}/` в zip.
- Очистка `deleted_*` папок старше N дней по расписанию (можно добавить отдельной cron-задачей позже).
- Sentinel-юзер для агрегатной аттрибуции — отвергнуто, замещено CSV-сводкой на диске.
