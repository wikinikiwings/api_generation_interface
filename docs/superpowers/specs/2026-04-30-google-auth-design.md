# Google OAuth + Per-Model Monthly Quotas — Design

**Status:** Approved (brainstorm 2026-04-30)
**Owners:** weaking1@gmail.com (admin), AI implementer
**Replaces:** ник-based identity (`viewcomfy_username` cookie) и отдельный admin-пароль (`admin_auth` cookie)

## 1. Goal

Заменить текущий механизм идентификации (пользователь вводит произвольный ник в `UsernameModal`, ник пишется plain-text в cookie и в `generations.username`) на аутентификацию через Google. После замены:

- В сервис могут войти **только пользователи из allowlist'а email-адресов**, который ведёт админ
- Идентификация админа — через ту же Google-сессию (`role='admin'` в таблице `users`); отдельного admin-пароля больше нет
- Каждая генерация привязана к стабильному `user_id INTEGER` вместо строки-ника
- Админ может через админку выставлять **месячные лимиты количества генераций per-user, per-model**, а также повышать/снимать ограничения

Старая БД и старые файлы изображений будут перенесены пользователем в архив; миграция данных и совместимость со старой схемой **не требуется** — новый сервер стартует с пустой БД и новой схемой.

## 2. Key decisions (резюме брейнсторма)

| Развилка | Решение | Почему |
|---|---|---|
| Кому разрешён вход | Email allowlist (вариант A) | Закрытый сервис, ~20 человек, список уже собран |
| Admin auth | Единый Google login + `role='admin'` в БД | Не дублировать identity между двумя системами |
| OAuth library | Полностью руками + `jose` для verify id_token | Auth.js плохо ложится на raw-SQL; Lucia deprecated; один провайдер не требует фреймворка |
| TTL сессии | 30 дней + sliding renewal | Активные пользователи не разлогиниваются; украденная кука не живёт вечно |
| UX для анонима | Жёсткая стена → `/login` (вариант A) | Нет смысла светить UI/модели/стили чужим |
| Bootstrap первого админа | Env `BOOTSTRAP_ADMIN_EMAILS` | Идемпотентно, не теряется, не требует SQL-команд |
| Тип квот | Календарный месяц UTC, **count** генераций per-user-per-model | Простая семантика, легко объяснить, легко считать |
| Default-policy | `default_monthly_limit` per-model + override per-user | Минимум кликов в админке, easy "временно блокнуть всех" через override |
| Стили в БД | Остаются в `prompt_data` JSON | Не предмет регулярных запросов; YAGNI; SQLite JSON1 справится с ad-hoc |
| Удаление пользователя | Soft delete (`status='deleted'`), файлы и генерации остаются | Файлы — архив для админа; FK не ломаем |
| `sub` mismatch | 403 + лог, требует ручного вмешательства | Безопасный default; защита от смены владельца email |
| Workspace `@tapclap.com` | Опциональный `ALLOWED_HD` env + рекомендация `Internal` user_type в Google Console | Defense-in-depth |

## 3. File layout (новый каталог `data/history_images/`)

```
data/history_images/
├── alice@tapclap.com/
│   ├── 2026/
│   │   ├── 04/
│   │   │   ├── <uuid>.png
│   │   │   ├── thumb_<uuid>.jpg
│   │   │   └── mid_<uuid>.jpg
│   │   └── 05/...
│   └── 2027/...
└── bob@tapclap.com/...
```

- **Имя user-папки** — email **в lowercase, как пришёл от Google** (символы `@`, `.`, `+` валидны на всех FS)
- **Подпапки `YYYY/MM`** — двухуровневые, UTC-границы месяца (см. §6.4)
- **`generation_outputs.filepath`** теперь хранит **относительный путь** от `HISTORY_IMAGES_DIR`: `alice@tapclap.com/2026/04/<uuid>.png`. Раньше хранил только filename — это ломающее изменение, но миграции не делаем (БД пустая)
- **Endpoint `/api/history/image/[filename]/route.ts`** превращается в catch-all `/api/history/image/[...path]/route.ts`. Защита: запрет `..`, проверка `path.resolve(joined).startsWith(path.resolve(baseDir))`
- **Авторизация на чтение картинки**: `pathSegments[0] === currentUser.email || currentUser.role === 'admin'`. Анонимный или чужой запрос → 401/403
- **Старые файлы в плоском `data/history_images/`** не трогаем — пользователь сам переносит в архив до деплоя

## 4. Database schema

Чистый rewrite `lib/history-db.ts` (старый код `CREATE TABLE` целиком заменяется).

### 4.1 Новые таблицы

```sql
-- 4.1.a Идентичности из allowlist'а
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  google_sub      TEXT    UNIQUE,
  name            TEXT,
  picture_url     TEXT,
  role            TEXT    NOT NULL DEFAULT 'user'
                          CHECK (role IN ('user','admin')),
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','banned','deleted')),
  created_at      TEXT    DEFAULT (datetime('now')),
  last_login_at   TEXT
);

-- 4.1.b Активные сессии (opaque random ids, НЕ JWT)
CREATE TABLE sessions (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  created_at    TEXT    DEFAULT (datetime('now')),
  expires_at    TEXT    NOT NULL,
  last_seen_at  TEXT,
  user_agent    TEXT,
  ip            TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- 4.1.c Каталог моделей с глобальным дефолтным лимитом
CREATE TABLE models (
  model_id              TEXT    PRIMARY KEY,
  display_name          TEXT    NOT NULL,
  default_monthly_limit INTEGER,         -- NULL = unlimited
  is_active             INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT    DEFAULT (datetime('now')),
  updated_at            TEXT    DEFAULT (datetime('now'))
);

-- 4.1.d Per-user override
CREATE TABLE user_quotas (
  user_id        INTEGER NOT NULL,
  model_id       TEXT    NOT NULL,
  monthly_limit  INTEGER,                -- NULL = unlimited override
  updated_at     TEXT    DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, model_id),
  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
  FOREIGN KEY (model_id) REFERENCES models(model_id) ON DELETE CASCADE
);

-- 4.1.e Audit log событий аутентификации
CREATE TABLE auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT    DEFAULT (datetime('now')),
  event_type  TEXT    NOT NULL,
  email       TEXT,
  user_id     INTEGER,
  ip          TEXT,
  user_agent  TEXT,
  details     TEXT                       -- JSON
);
CREATE INDEX idx_auth_events_ts ON auth_events(timestamp DESC);
```

**Допустимые `event_type` для `auth_events`** (closed enum для отчётности):

`login_ok` · `login_denied_invalid_state` · `login_denied_invalid_token` · `login_denied_email_unverified` · `login_denied_not_in_allowlist` · `login_denied_banned` · `login_denied_account_deleted` · `login_denied_sub_mismatch` · `login_denied_wrong_hd` · `logout` · `quota_exceeded` · `session_revoked_ban` · `session_revoked_role_change` · `admin_user_created` · `admin_user_role_changed` · `admin_user_status_changed` · `admin_quota_changed` · `admin_model_default_changed`

### 4.2 Изменённые таблицы

```sql
-- generations: username TEXT  ⟶  user_id INTEGER FK + model_id + provider
CREATE TABLE generations (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL,
  model_id                TEXT,
  provider                TEXT,
  workflow_name           TEXT    DEFAULT '',
  prompt_data             TEXT    DEFAULT '{}',
  execution_time_seconds  REAL    DEFAULT 0,
  created_at              TEXT    DEFAULT (datetime('now')),
  status                  TEXT    DEFAULT 'completed',
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT  -- защита от случайного DELETE FROM users
);
CREATE INDEX idx_generations_user_id            ON generations(user_id);
CREATE INDEX idx_generations_created_at         ON generations(created_at);
CREATE INDEX idx_generations_user_model_created ON generations(user_id, model_id, created_at);
CREATE INDEX idx_generations_provider           ON generations(provider);

-- user_preferences: PK по user_id вместо username
CREATE TABLE user_preferences (
  user_id        INTEGER PRIMARY KEY,
  selected_model TEXT,
  updated_at     TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- generation_outputs: схема та же; смысл filepath меняется (см. §3)
-- app_settings: без изменений
```

### 4.3 Гарантии сохранности существующих данных

При генерации сейчас в `prompt_data` JSON пишется (см. `components/generate-form.tsx:255-266`):
`prompt`, `userPrompt`, `styleIds`, `resolution`, `aspectRatio`, `outputFormat`, `provider`, `modelId`, `model`, `inputThumbnails`. Плюс `workflow_name` = `wavespeed:<provider>/<model>/<edit|t2i>`. Плюс `execution_time_seconds`.

**Все эти поля сохраняются слово-в-слово в новой схеме.** Колонки `model_id` и `provider` поднимаются "наверх" как явные TEXT-колонки (для индексов и удобной выгрузки), но остаются и в `prompt_data` тоже — двойная запись намеренна. SQL-выгрузки админа продолжат работать без изменений.

### 4.4 Засев `models` при старте

В `initHistoryDb()` для каждой модели из `ModelId` union (`lib/providers/types.ts:9-14`):

```sql
INSERT OR IGNORE INTO models (model_id, display_name) VALUES (?, ?);
```

`default_monthly_limit` остаётся NULL (unlimited) — админ выставляет вручную в `Models` вкладке. Если модель ушла из кода — строка остаётся (нужна для FK с `user_quotas` и для исторических `generations.model_id`).

### 4.5 Bootstrap первого админа

В `initHistoryDb()` после засева моделей:

```ts
const csv = process.env.BOOTSTRAP_ADMIN_EMAILS ?? ""
for (const email of csv.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) {
  db.prepare(`
    INSERT INTO users (email, role, status) VALUES (?, 'admin', 'active')
    ON CONFLICT (email) DO UPDATE
      SET role='admin', status='active'
      WHERE status != 'deleted'
  `).run(email)
}
```

Идемпотентно — env можно держать включённой постоянно либо убрать после первого запуска. **Не воскрешает soft-deleted записи** (`WHERE status != 'deleted'`): если админ был явно удалён через UI и его email остался в `BOOTSTRAP_ADMIN_EMAILS`, рестарт сервера не вернёт его в active автоматически — это требует ручного `UPDATE users SET status='active'`. Защита от случайного "rollback'а" удаления через рестарт.

## 5. OAuth flow

### 5.1 Endpoints

```
GET  /api/auth/google     старт — генерим state/nonce/PKCE, redirect в accounts.google.com
GET  /api/auth/callback   обмен code→tokens, верификация id_token, allowlist, создание сессии
POST /api/auth/logout     удаляем сессию из БД, чистим cookie, redirect /login
GET  /api/auth/me         для клиентского UserProvider — возвращает {id, email, name, picture_url, role} или 401
GET  /api/me/quotas       возвращает массив {model_id, limit, used, unlimited} для UI лимитов
```

### 5.2 Полный flow логина

```
1. Browser GET /private-page (без cookie)
   → middleware: 307 → /login?next=/private-page

2. Browser GET /login → клик "Войти через Google"
   → GET /api/auth/google?next=/private-page
     • state         = randomBytes(32).b64url
     • nonce         = randomBytes(32).b64url
     • code_verifier = randomBytes(32).b64url
     • code_challenge = b64url(sha256(code_verifier))
     • next' = safeNext(next)        — только относительные пути
     • Set-Cookie oauth_tx (HMAC-signed JSON {state,nonce,code_verifier,next:next',ts}, 10 min)
     • 302 → https://accounts.google.com/o/oauth2/v2/auth?
              client_id, redirect_uri, response_type=code,
              scope=openid+email+profile,
              state, nonce,
              code_challenge, code_challenge_method=S256,
              prompt=select_account, access_type=online

3. User picks account in Google → Google 302 → /api/auth/callback?code=...&state=...

4. /api/auth/callback:
   a. Прочитать oauth_tx, проверить HMAC, парсить JSON
      Если HMAC битый или TS старше 10min → 400 + auth_event(login_denied_invalid_state)
   b. Проверить state из query == state из oauth_tx → иначе 400 + login_denied_invalid_state
   c. POST https://oauth2.googleapis.com/token
      grant_type=authorization_code, code, client_id, client_secret,
      redirect_uri, code_verifier
      → { id_token, ... }
   d. jose.jwtVerify(id_token, JWKS, { issuer: 'https://accounts.google.com',
                                        audience: GOOGLE_CLIENT_ID })
      Если падает → 400 + login_denied_invalid_token
   e. payload checks (если падает — 403 + соответствующий event):
      - nonce == oauth_tx.nonce                        else login_denied_invalid_token
      - email_verified === true                        else login_denied_email_unverified
      - if ALLOWED_HD: payload.hd === ALLOWED_HD       else login_denied_wrong_hd
   f. Allowlist:
      row = SELECT id, role, status, google_sub FROM users WHERE email = LOWER(payload.email)
      - row отсутствует                                → 403 + login_denied_not_in_allowlist
      - row.status='banned'                            → 403 + login_denied_banned
      - row.status='deleted'                           → 403 + login_denied_account_deleted
      - row.google_sub IS NOT NULL AND ≠ payload.sub   → 403 + login_denied_sub_mismatch
   g. UPDATE users SET google_sub=?, name=?, picture_url=?, last_login_at=?
   h. session_id = randomBytes(32).b64url
      INSERT INTO sessions (id, user_id, expires_at=now+30d, ip, user_agent, last_seen_at=now)
   i. Set-Cookie session (см. §5.3)
   j. Set-Cookie oauth_tx=; Max-Age=0   (чистим транзакционную)
   k. auth_event(login_ok)
   l. 303 → oauth_tx.next (или '/' если пусто)
```

### 5.3 Cookies

| Имя в prod | Имя в dev | Назначение | Контент | TTL | Флаги |
|---|---|---|---|---|---|
| `__Host-oauth_tx` | `oauth_tx` | CSRF/PKCE между шагами 2→4 | HMAC(`{state,nonce,code_verifier,next,ts}`, SESSION_COOKIE_SECRET) | 10 min | httpOnly, Secure (prod), SameSite=Lax, Path=/ |
| `__Host-session` | `session` | id сессии | opaque base64url (256 bit) | 30 days (sliding) | httpOnly, Secure (prod), SameSite=Lax, Path=/ |

`__Host-` префикс работает только при `Secure` — поэтому в dev (HTTP localhost) имена короче. Имя выбирается по `process.env.NODE_ENV`.

### 5.4 `safeNext` (защита от open redirect)

```ts
function safeNext(raw: string | null): string {
  if (!raw) return '/'
  if (!raw.startsWith('/')) return '/'   // абсолютные https://evil.com
  if (raw.startsWith('//')) return '/'   // protocol-relative //evil.com
  if (raw.includes('\\')) return '/'     // \\evil.com на Windows-парсерах
  return raw
}
```

Применяется на входе (`/api/auth/google?next=...`) и на выходе (`/api/auth/callback`).

### 5.5 Logout

`POST /api/auth/logout`:
```sql
DELETE FROM sessions WHERE id = ?;
```
+ `Set-Cookie session=; Max-Age=0; ...` + `auth_event(logout)` + 303 → `/login`. Не зовём Google revocation — мы не храним `access_token`/`refresh_token`.

## 6. Sessions, middleware, server-side auth

### 6.1 Middleware (edge runtime)

`middleware.ts` работает в edge runtime, поэтому **не ходит в БД**. Только presence-check куки и роутинг:

```ts
export function middleware(req) {
  const path = req.nextUrl.pathname
  const sid = req.cookies.get(SESSION_COOKIE_NAME)?.value

  // Public paths
  if (path === '/login' || path.startsWith('/api/auth/')) return next()

  // Защищённые
  if (!sid) {
    if (path.startsWith('/api/')) return new Response(null, { status: 401 })
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', req.nextUrl.pathname + req.nextUrl.search)
    return Response.redirect(url, 307)
  }
  return next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
}
```

**Двухуровневая проверка** (presence в edge + реальная в Node): необходима потому, что edge не умеет `better-sqlite3`. Анонимный с фейковой кукой получит 401 от handler, не от middleware — эквивалентно по безопасности.

### 6.2 `getCurrentUser(req)` — Node.js runtime

Используется во всех Server Components, Route Handlers и API endpoints. Реализует sliding renewal с throttling.

```ts
async function getCurrentUser(req): Promise<User | null> {
  const sid = readCookie(req, SESSION_COOKIE_NAME)
  if (!sid) return null

  const row = db.prepare(`
    SELECT s.id, s.expires_at, s.last_seen_at, s.created_at,
           u.id AS user_id, u.email, u.name, u.picture_url, u.role, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).get(sid)

  if (!row) return null
  if (new Date(row.expires_at) < new Date()) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sid)
    return null
  }
  if (row.status !== 'active') {
    db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(row.user_id)
    return null
  }

  // Sliding renewal: продлеваем не чаще раза в час
  const lastSeenIso = row.last_seen_at ?? row.created_at
  const ageMs = Date.now() - new Date(lastSeenIso).getTime()
  if (ageMs > 60 * 60 * 1000) {
    const newExpires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    db.prepare(`UPDATE sessions SET expires_at=?, last_seen_at=? WHERE id=?`)
      .run(newExpires, new Date().toISOString(), sid)
  }

  return {
    id: row.user_id, email: row.email, name: row.name,
    picture_url: row.picture_url, role: row.role
  }
}
```

**Throttling важен**: без `ageMs > 1h` мы делали бы `UPDATE` на каждый запрос (включая каждый `/api/history/image/...`). Час — баланс между точностью "когда был последний раз" и нагрузкой на БД.

### 6.3 Quota enforcement

Вставляется в `POST /api/generate/submit` сразу после проверки auth:

```ts
const user = await getCurrentUser(req)
if (!user) return 401

if (user.role !== 'admin') {
  const limit = applicableLimit(user.id, body.modelId)
  if (limit !== null) {
    const used = usageThisMonth(user.id, body.modelId)
    if (used >= limit) {
      writeAuthEvent({
        event_type: 'quota_exceeded',
        user_id: user.id,
        details: { model_id: body.modelId, used, limit }
      })
      return NextResponse.json(
        { error: 'quota_exceeded', model_id: body.modelId, limit, used },
        { status: 429 }
      )
    }
  }
}
// ... дальше как сейчас (provider.submit)
```

```ts
function applicableLimit(user_id, model_id): number | null {
  const override = db.prepare(`
    SELECT monthly_limit FROM user_quotas WHERE user_id=? AND model_id=?
  `).get(user_id, model_id)
  if (override) return override.monthly_limit                 // NULL = unlimited override

  const def = db.prepare(`
    SELECT default_monthly_limit FROM models WHERE model_id=?
  `).get(model_id)
  if (!def) return 0          // неизвестная модель → блок (closed by default for unknown)
  return def.default_monthly_limit                            // NULL = unlimited
}

function usageThisMonth(user_id, model_id): number {
  const [start, end] = currentMonthBoundsUTC()
  return db.prepare(`
    SELECT COUNT(*) AS n FROM generations
    WHERE user_id=? AND model_id=?
      AND created_at >= ? AND created_at < ?
      AND status = 'completed'
  `).get(user_id, model_id, start, end).n
}
```

### 6.4 `currentMonthBoundsUTC()`

```ts
function currentMonthBoundsUTC(now = new Date()): [string, string] {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const start = new Date(Date.UTC(y, m,     1, 0, 0, 0)).toISOString()
  const end   = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0)).toISOString()
  return [start, end]
}
```

Та же UTC-семантика используется для определения подпапки `YYYY/MM` при записи файлов в `POST /api/history`. **Граница месяца — единая** для квот и для раскладки на диске; иначе возможны парадоксы вида "файл в апрельской папке, но в мае по квоте".

### 6.5 Race-condition в квотах — намеренно НЕ закрываем

Если пользователь одновременно жмёт Generate 5 раз и осталось 2 — все 5 пройдут проверку и превысят лимит на 3. На сервисе для 20 знакомых это нереалистично. Если в будущем понадобится строгая атомарность — введём `pending`-rows со status='pending' при сабмите, и `usageThisMonth` будет считать `pending+completed`. Это +20 строк кода. См. §10.

### 6.6 Failed-генерации не списывают квоту

`usageThisMonth` фильтрует по `status='completed'`. Если провайдер упал — лимит не списан. Это намеренное поведение, входит в smoke-тесты (§11).

### 6.7 `POST /api/history` повторно квоту НЕ проверяет

Генерация уже состоялась (юзер потратил время/токены провайдера). Принять и записать результат — обязательно. Если админ снизил лимит между submit и save — это его ответственность.

## 7. Admin UI

К существующим вкладкам `Settings`, `Styles` (компоненты `app/admin/page.tsx` + дочерние) добавляются:

### 7.1 Вкладка `Users`

- **Таблица**: `email · name · role · status · last_login_at · #generations этого месяца`
- **Фильтр** (по умолчанию): `active + banned`. Чекбокс "показать удалённых" раскрывает все
- **Кнопки сверху**: `+ Добавить email` (поле email; роль `user`, статус `active`)
- **Действия per-row**:
  - `Изменить роль` (toggle `user` ↔ `admin`)
  - `Забанить / Разбанить` (toggle `active` ↔ `banned`)
  - `Удалить` (с confirm-диалогом → `status='deleted'`; FK не нарушается, файлы остаются на диске)
  - Для удалённых: `Восстановить` → `status='active'`
- **Раскрытие row** показывает inline-блок **"Лимиты этого пользователя"** — таблица `модель × applicable limit × usage this month × source(default|override)`. Источник лимита админ видит (в отличие от пользователя):
  - `1000 (override)` — есть строка в `user_quotas`
  - `500 (default)` — нет override, берётся из `models`
  - `unlimited (default)` / `unlimited (override)` — для NULL
- Per-row `[edit]` рядом с лимитом → инпут с числом + чекбокс "unlimited" + кнопка "сбросить override → использовать default"

### 7.2 Вкладка `Models`

- **Таблица**: `model_id · display_name · default_monthly_limit · is_active · #total генераций (за всё время)`
- **Действия per-row**: `Изменить default_monthly_limit` (число или unlimited), `Скрыть из UI` (`is_active=0`)
- **Удалять руками нельзя** — список засеивается из кода при старте сервера; ручное удаление сломало бы FK с `user_quotas` и историю. Если модель ушла из кода — строка остаётся (можно скрыть через `is_active=0`)

### 7.3 Admin API endpoints

Все требуют `getCurrentUser().role === 'admin'`.

```
GET    /api/admin/users
POST   /api/admin/users                    body: { email, role? }
PATCH  /api/admin/users/:id                body: { role?, status? }
                                           — пишет admin_user_*_changed events
                                           — при role/status changes broadcast'им user_role_changed/user_banned

GET    /api/admin/models
PATCH  /api/admin/models/:model_id         body: { default_monthly_limit?, is_active? }
                                           — если default_monthly_limit изменился, broadcast quota_updated всем
                                             у кого нет override по этой модели

GET    /api/admin/users/:id/quotas         список с applicable + source + usage
PUT    /api/admin/users/:id/quotas/:model  body: { monthly_limit: number|null }
                                           — broadcast quota_updated целевому юзеру
DELETE /api/admin/users/:id/quotas/:model  удалить override → broadcast quota_updated
```

## 8. Client UX — лимиты для обычного пользователя

### 8.1 Селектор модели (на главной)

- Исчерпанные модели (`used >= limit`) — **disabled** в выпадающем списке, серым цветом, рядом иконка ⛔ и тултип *"Лимит исчерпан в этом месяце"*
- Модели с `is_active=0` — не показываются вовсе
- Цифры `47/100` рядом с моделями **не показываем** в селекторе — чтобы не загромождать (пользователь видит свой остаток ниже, в строке под Generate)

### 8.2 Под кнопкой Generate

Подпись (мелкая, subtle):
- `47 / 100 в апреле` — обычный режим
- `Без ограничений` — для unlimited
- `Лимит исчерпан · сбросится 1 мая` — при 100%

Цвет: серый <80%, оранжевый 80–99%, красный 100%. При 100% **кнопка Generate дизейблится** + тултип.

### 8.3 Тост при 429 (back-stop)

`"Лимит модели X исчерпан в этом месяце (Y/Y). Сбросится 1 мая. Можно попросить админа увеличить лимит."`

### 8.4 Вкладка "Мои лимиты" в `history-sidebar`

Шапка sidebar превращается в табы:

```
┌──────────────────────────────────────┐
│ 👤 alice@tapclap.com [admin] [↪]     │  ← header: email, бэдж роли (если admin), logout
├──────────────────────────────────────┤
│ [ История ]  [ Мои лимиты ]          │  ← tab switcher
├──────────────────────────────────────┤
│  …content активной вкладки…         │
└──────────────────────────────────────┘
```

- **Дефолтная вкладка** — `История` (без изменений по содержанию относительно текущего sidebar)
- **Клик по email в шапке** = клик на таб `Мои лимиты` (shortcut)
- **Клик по `↪`** = `POST /api/auth/logout`
- **Бэдж `admin`** появляется только у роли admin, рядом с ним маленький линк на `/admin`

Содержимое таба `Мои лимиты` — список карточек по одной на каждую активную модель (`is_active=1`):

```
┌─ Nano Banana Pro ──────────────────────┐
│ ████████████░░░░░░░░  47 / 100         │
│ В этом месяце · сбросится через 5 дн.  │
└────────────────────────────────────────┘
```

- Прогресс-бар: зелёный <80%, оранжевый 80–99%, красный 100%
- Источник лимита (default vs override) **не показываем** пользователю — это внутренняя кухня админки
- Сортировка: исчерпанные / "доступ не настроен" — в конец, активные с остатком — наверх
- При получении SSE `quota_updated` — карточка плавно перерисовывается

### 8.5 Откуда берутся данные

- `GET /api/me/quotas` — возвращает массив `{ model_id, limit, used, unlimited }`
- UserProvider при mount делает один fetch и кладёт в Context
- После каждой **успешной** генерации клиент локально инкрементит `used` в Context (оптимистично)
- После 429 — refetch `/api/me/quotas`
- При visibility-change (вкладка вернулась в фокус) — refetch
- При получении SSE `quota_updated` — refetch (мгновенно, не дожидаясь polling'а)

## 9. SSE — расширение существующего `/api/history/stream`

В `lib/sse-broadcast.ts` (текущий `broadcastToUser` принимает username) переименовываем/переписываем на `broadcastToUserId(user_id: number, payload)`. Существующие event-types `generation.created` / `generation.deleted` остаются. Добавляем:

| Event type | Когда стреляет | Что делает клиент |
|---|---|---|
| `quota_updated` | (a) админ изменил `models.default_monthly_limit` для модели, у которой пользователь не имеет override — **только если значение реально изменилось** (no-op PATCH не шлёт) **или** (b) админ изменил/удалил его override в `user_quotas` | refetch `/api/me/quotas` |
| `user_banned` | админ изменил `users.status` с `active` на `banned` или `deleted` (одно событие на оба случая — клиентский эффект идентичен) | тост "Сессия закрыта", `replace('/login')` |
| `user_role_changed` | роль изменена | refetch `/api/auth/me` (перерисовать header) **и** `/api/me/quotas` (admin без лимитов — карточки должны это отразить) |

При `PATCH /api/admin/models/:model_id` (изменение default) — найти всех затронутых:

```sql
SELECT id FROM users
WHERE id NOT IN (SELECT user_id FROM user_quotas WHERE model_id = ?)
  AND status = 'active'
```

— и для каждого `broadcastToUserId(id, { type: 'quota_updated' })`. Дёшево даже на тысячах пользователей.

При бане — после `UPDATE users SET status='banned'`:
1. `DELETE FROM sessions WHERE user_id=?`
2. `broadcastToUserId(id, { type: 'user_banned' })`
3. Закрыть активные SSE-стримы этого user_id (in-memory map по user_id)

## 10. Out of scope (явно НЕ делаем)

- Refresh tokens, MFA, recovery codes, account linking, password fallback
- Rate limiting на `/api/auth/callback` (на 20 пользователей оверкилл; добавим если увидим попытки брута)
- Атомарный pending-row для квот (race-condition при параллельных submit'ах — см. §6.5)
- Per-day или sliding-window лимиты — только календарный месяц UTC
- Лимиты по execution_time / стоимости / по числу outputs
- Email-нотификации (бан, исчерпание квоты)
- Графический admin-dashboard статистики — только ad-hoc SQL
- Авто-миграция старой БД и старых файлов — пользователь переносит сам
- Очистка папок удалённых пользователей (soft delete оставляет файлы)
- CSP/security-headers — отдельная тема, не блокирует этот спринт
- Механизм восстановления админа если он потерял свой Google аккаунт (workaround: `BOOTSTRAP_ADMIN_EMAILS` в env, рестарт)

## 11. Testing

### 11.1 Unit tests

- `verifyIdToken` (мок JWKS, мок payload — happy path и каждое отдельное падение: bad sig, wrong iss, wrong aud, expired, bad nonce, unverified email)
- `applicableLimit` (override=null/число/нет, default=null/число/нет)
- `usageThisMonth` (граничные timestamps вокруг 1-го числа в UTC, статусы)
- `currentMonthBoundsUTC` (декабрь→январь, январь, високосный год — фактически Date.UTC справляется)
- `safeNext` (`/`, `/path`, `//evil`, `https://evil`, `\\evil`, `null`, пустая строка)
- `oauthTx` HMAC encode/decode (валидный, испорченный, истекший)

### 11.2 Integration tests (через test SQLite)

- Полный путь: `INSERT user → создать сессию → middleware пропускает → POST /api/generate/submit проходит квоту → POST /api/history пишет файлы под <email>/2026/04/`
- Soft delete: `UPDATE status='deleted' → следующий getCurrentUser возвращает null → сессии очищены`
- Bootstrap admin из env при пустой БД
- Race на квоту: 5 параллельных submit'ов с лимитом 2 → все 5 проходят (документируем, что это намеренно)

### 11.3 Manual smoke tests (нет смысла автоматизировать против настоящего Google)

1. Логин не-allowlist email → 403 + `auth_events(login_denied_not_in_allowlist)`
2. Логин unverified email → 403
3. Логин валидного email → редирект на `?next`, видим UI
4. `?next=https://evil.com` обходит safeNext → редирект на `/` (не на evil)
5. Logout → cookie очищена, редирект на /login
6. Бан в админке → следующий запрос той же сессии → 401/redirect, тост в SSE-стриме
7. Модель с лимитом 2, генерим 3 раза → 3-й 429
8. Админ генерит без лимита
9. Админ повышает лимит другому юзеру → у того кнопка разблокируется через SSE без полной перезагрузки страницы
10. Удаление пользователя в админке → его файлы остались на диске (`ls data/history_images/<email>/`), генерации в БД сохранены, login → 403
11. Логин из второй вкладки уже залогиненного юзера — обе вкладки видят квоты в синхроне (одна сессия)
12. Не-tapclap.com email + `ALLOWED_HD=tapclap.com` → 403 + `login_denied_wrong_hd`
13. Open redirect: вручную сформированный `oauth_tx` с next=`https://evil` → safeNext чистит, редирект на `/`

## 12. Rollout

1. Реализация в feature branch
2. Регистрация OAuth client в Google Cloud Console:
   - User Type: **`Internal`** (рекомендуется, если все юзеры в Workspace `tapclap.com`); иначе `External`
   - Authorized redirect URIs:
     - `https://lgen.maxkdiffused.org/api/auth/callback` (prod)
     - `http://localhost:3000/api/auth/callback` (dev)
     - `http://192.168.88.76:3000/api/auth/callback` (LAN dev — если используется)
   - Authorized JavaScript origins: те же домены без `/api/auth/callback`
3. Деплой на dev (`192.168.88.76:3000`), полный smoke-list §11.3
4. **Готов к prod-деплою:**
   - Пользователь переносит `data/history.db` и `data/history_images/` в архив (вне папки `data/`)
   - Ставит env vars (см. §13)
   - Деплой
   - Первый логин админом → проверка работоспособности
   - Через админку добавляет allowlist остальных

## 13. Environment variables

```
GOOGLE_CLIENT_ID=...                                            # обязательно
GOOGLE_CLIENT_SECRET=...                                        # обязательно
GOOGLE_REDIRECT_URI=https://lgen.maxkdiffused.org/api/auth/callback    # prod
                    http://localhost:3000/api/auth/callback           # dev
SESSION_COOKIE_SECRET=<32+ bytes hex>                           # обязательно — для HMAC oauth_tx
BOOTSTRAP_ADMIN_EMAILS=weaking1@gmail.com                       # CSV; идемпотентно
ALLOWED_HD=tapclap.com                                          # опционально, defense-in-depth
```

`ADMIN_PASSWORD` (старая переменная для admin_auth) — **больше не используется** и может быть удалена из env при деплое.

## 14. Security baseline (industry-standard checklist)

Полный список того, что мы соблюдаем (по RFC 6749/8252/9700, OpenID Connect Core, OWASP):

1. **Authorization Code + PKCE** (даже для confidential client — рекомендация OAuth 2.1, RFC 9700)
2. **`state`** — CSRF защита между шагами 2 и 4 OAuth flow
3. **`nonce`** — replay-protection для id_token (OIDC требование)
4. **Полная локальная верификация id_token** через `jose` + Google JWKS (`https://www.googleapis.com/oauth2/v3/certs`); проверяем подпись, `iss`, `aud`, `exp`, `nonce`, `email_verified`. Никогда не доверяем содержимому id_token без проверки подписи. Не используем `/userinfo` (id_token самодостаточен)
5. **Allowlist enforcement** — только после криптографической верификации (см. п.4)
6. **Сессия — opaque random id, НЕ JWT** — 256 bit, хранится в таблице `sessions`. JWT нельзя отозвать, а нам нужен мгновенный бан
7. **Cookie — максимально жёсткие флаги**: `httpOnly`, `Secure` (prod), `SameSite=Lax`, `__Host-` префикс (prod), `Path=/`, без `Domain`
8. **`safeNext`** — защита от open redirect через `?next=`
9. **Session fixation** — не "повышаем" анонимную куку до залогиненной; всегда новый `session_id` при логине
10. **Logout** — серверный (`DELETE FROM sessions`), не полагаемся на "клиент забудет"
11. **CSRF на state-changing endpoints** — SameSite=Lax покрывает 95%; для критичных POST дополнительно origin-check (опционально)
12. **Секреты только в env** — `GOOGLE_CLIENT_SECRET`, `SESSION_COOKIE_SECRET` никогда в репо
13. **HTTPS обязателен в prod** — cookie с `Secure` иначе не работает
14. **Audit log** — `auth_events` пишется на каждом значимом событии (см. §4.1.e — closed enum)

### Что мы намеренно НЕ делаем (и почему)

- **Refresh tokens** — нужны только для вызовов Google API от имени юзера (Drive, Calendar). Нам нужен только факт логина. Меньше attack surface
- **MFA, recovery, password reset** — на стороне Google, у нас нет паролей
- **Rate limiting `/api/auth/callback`** — для 20 пользователей оверкилл

## 15. Affected files (ориентировочный inventory для writing-plans)

### Новые
- `app/login/page.tsx`
- `app/api/auth/google/route.ts`
- `app/api/auth/callback/route.ts`
- `app/api/auth/logout/route.ts`
- `app/api/auth/me/route.ts`
- `app/api/me/quotas/route.ts`
- `app/api/admin/users/route.ts`
- `app/api/admin/users/[id]/route.ts`
- `app/api/admin/users/[id]/quotas/route.ts`
- `app/api/admin/users/[id]/quotas/[model]/route.ts`
- `app/api/admin/models/route.ts`
- `app/api/admin/models/[model_id]/route.ts`
- `lib/auth/google.ts` (build authorize URL, exchange code, verify id_token)
- `lib/auth/session.ts` (create/get/extend/destroy)
- `lib/auth/current-user.ts` (`getCurrentUser`, `requireAuth`, `requireAdmin`)
- `lib/auth/oauth-tx.ts` (HMAC encode/decode short-lived state cookie)
- `lib/auth/safe-next.ts`
- `lib/quotas.ts` (`applicableLimit`, `usageThisMonth`, `currentMonthBoundsUTC`)
- `lib/db/auth-schema.ts` (новые `CREATE TABLE`)
- `components/header-user-menu.tsx`
- `components/sidebar-tabs.tsx` (или встроенно в `history-sidebar.tsx`)
- `components/my-quotas-tab.tsx`
- `components/admin/users-tab.tsx`
- `components/admin/models-tab.tsx`

### Изменяемые
- `middleware.ts` — полный rewrite (см. §6.1)
- `lib/history-db.ts` — заменить старые `CREATE TABLE` на новую схему (§4)
- `lib/sse-broadcast.ts` — `broadcastToUser(username)` → `broadcastToUserId(user_id)` + новые event types
- `app/providers/user-provider.tsx` — больше не читает cookie напрямую; делает `fetch('/api/auth/me')`; кладёт в Context user object вместо строки username
- `app/providers.tsx` — порядок провайдеров может потребовать корректировки
- `app/api/history/route.ts` — `getCurrentUser` вместо `username` из query/body; `filepath` теперь относительный путь `<email>/YYYY/MM/<filename>`
- `app/api/history/image/[filename]/route.ts` → `/api/history/image/[...path]/route.ts` — catch-all + проверка владельца
- `app/api/history/stream/route.ts` — `broadcastToUserId`, новые event types
- `app/api/user/preferences/route.ts` — `getCurrentUser` вместо `username` из query/body; PK по `user_id`
- `app/api/generate/submit/route.ts` — auth gate + quota check + запись `model_id`/`provider` в `generations`
- `app/admin/page.tsx` — добавить вкладки `Users` и `Models`
- `components/playground.tsx` — убрать `username` props, читать user из Context; передавать в API user_id
- `components/generate-form.tsx` — то же; учесть quota state, дизейбл кнопки

### Удаляемые
- `app/admin/login/page.tsx`
- `app/api/admin/login/route.ts`
- `app/api/admin/logout/route.ts`
- `components/username-modal.tsx`

## 16. Glossary

- **allowlist** — таблица `users.email`; чтобы войти, email должен быть в этой таблице с `status='active'`
- **applicable limit** — лимит, фактически применяемый к (user, model): override если есть, иначе default из `models`. NULL = unlimited
- **closed by default for unknown** — если `model_id` пришёл от клиента, но в `models` его нет (рассинхрон деплоя?) — `applicableLimit` возвращает 0; защита от обхода квот через выдуманные id'ы
- **soft delete** — `users.status='deleted'`; запись остаётся, FK не нарушается, файлы на диске тоже остаются; пользователь не может войти
- **sliding renewal** — `expires_at` обновляется при каждом доступе (с throttling 1h), что эффективно держит активного юзера залогиненным неопределённо долго
- **`hd` claim** — Google OIDC поле в id_token, содержащее Workspace-домен (`"tapclap.com"`); отсутствует у личных `@gmail.com` аккаунтов
