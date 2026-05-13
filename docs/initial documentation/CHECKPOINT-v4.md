# CHECKPOINT v4 — wavespeed-claude

> **Назначение:** отсечка после Шага 4 (админка на `/admin` с middleware-auth) и UI-рефакторинга (удаление топ-бара, перемещение контролов, липкая кнопка Generate). Точка отката перед началом Шага 5 — порт multi-user + никнеймов из viewcomfy-claude.
>
> **Это известно-рабочая точка.** Три провайдера работают, t2i работает, админка работает, UI чистый. Можно безопасно начинать порт или откатиться сюда.
>
> Документ **самодостаточный** — при возобновлении работы в новой сессии чтения только этого файла + CHECKPOINT-v3 должно быть достаточно для полного восстановления контекста.

**Дата:** 10 апреля 2026, вечер
**Статус:** WaveSpeed ✅ · Fal.ai ✅ · Comfy API ✅ · t2i ✅ · Админка ✅ · Multi-user ⏳ запланирован

---

## TL;DR что произошло в этой сессии

Три блока работы:

1. **UI-рефакторинг** — убран топ-бар `WaveSpeed Studio`, в хедер карточки формы переехали model picker (пока одна опция "Nano Banana Pro" — слот готов под мульти-модель) + ThemeToggle. Входные изображения подняты **над** промптом. Кнопка Generate стала `sticky bottom-0` и всегда видна регардлесс длины формы. Файл `components/top-bar.tsx` превращён в deprecated-заглушку.

2. **Админка** — создан полноценный `/admin` роут с:
   - Селектором активного провайдера (список трёх провайдеров + статус configured/not-configured)
   - Экраном логина `/admin/login`
   - Middleware на `ADMIN_PASSWORD` из env с dev-mode bypass
   - Cookie-based auth (httpOnly + salted SHA-256 hash пароля)
   - Zustand persist store `stores/settings-store.ts` для активного провайдера
   - Жёлтый TEMP-селектор провайдера из формы **удалён** — форма теперь читает `activeProvider` из settings store
   - Кнопка-шестерёнка изначально добавлена в хедер карточки, затем **удалена по просьбе пользователя**. Доступ к `/admin` — только ручной ввод URL. В production дополнительно блокируется на уровне Caddy/nginx.

3. **Планирование multi-user порта** — изучен `viewcomfy-claude`, понята архитектура nickname+history. Принят план из 5 мини-итераций (описан ниже). **Код НЕ писался** — только исследование и план.

---

## Что изменилось с CHECKPOINT-v3

### Новые файлы

| Файл | Назначение |
|---|---|
| `stores/settings-store.ts` | zustand persist, хранит `selectedProvider` |
| `app/api/providers/route.ts` | GET → `listProviderMeta()`, client-safe |
| `app/api/admin/login/route.ts` | POST, принимает пароль, ставит cookie с salted SHA-256 хешем |
| `app/api/admin/logout/route.ts` | POST, очищает cookie |
| `middleware.ts` (root) | auth-гейт для `/admin/*` и `/api/admin/*`, dev-mode bypass |
| `components/admin-panel.tsx` | основной UI админки (радио-пикер провайдера, статусы, logout) |
| `app/admin/page.tsx` | server wrapper для админки |
| `app/admin/login/page.tsx` | страница логина с password-input |
| `CHECKPOINT-v4.md` | ★ этот файл |

### Изменённые файлы

| Файл | Что изменилось |
|---|---|
| `components/playground.tsx` | Удалён `<TopBar />`. Новый хедер карточки: model Select + ThemeToggle. Кнопка-шестерёнка `/admin` была добавлена затем удалена. Model state локально в компоненте, готов к prop-прокидыванию в GenerateForm когда будет мульти-модель. |
| `components/generate-form.tsx` | Убран жёлтый TEMP-селектор провайдера, `FlaskConical` import, `PROVIDER_OPTIONS`. Читает `activeProvider` из `useSettingsStore`. Images-блок теперь выше prompt-блока. Кнопка Generate в `sticky bottom-0 -mx-5 -mb-5 mt-auto border-t bg-background` (всегда видна). |
| `components/top-bar.tsx` | Заменён на deprecated-заглушку (`export function TopBar() { return null }`) — файл можно безопасно удалить вручную. |
| `.env.example` | Добавлена секция `ADMIN_PASSWORD` с описанием всех трёх режимов (dev-set, dev-unset=bypass, prod-set, prod-unset=503). |

### Файлы которые НЕ трогали

- `lib/providers/*` — провайдеры остались ровно такими же как в v3
- `stores/history-store.ts` — zustand persist history всё ещё активен, переедет в Шаге 5
- `app/api/generate/*` — роуты не тронуты
- `lib/image-storage.ts` — не тронут
- `types/wavespeed.ts` — не тронут
- `app/layout.tsx`, `app/providers.tsx` — не тронуты

---

## Текущее состояние UI

```
┌─────────────────────────────────────────────────────────┐
│  [Nano Banana Pro ▼]                             [🌙]  │   ← card header
├─────────────────────────────────────────────────────────┤
│  Входные изображения · опционально (пусто = t2i)       │
│  ┌───────────────────┐                                  │
│  │  Dropzone         │                                  │
│  └───────────────────┘                                  │
│                                                          │
│  Промпт                                                  │
│  ┌───────────────────┐                                  │
│  │  textarea         │                                  │
│  └───────────────────┘                                  │
│                                                          │
│  Разрешение · Aspect · Формат                            │
├─────────────────────────────────────────────────────────┤
│                [ Сгенерировать ]                         │   ← sticky bottom
└─────────────────────────────────────────────────────────┘
```

**Никакой видимой ссылки на админку.** URL `/admin` известен только владельцу, дополнительно блокируется Caddy в production (примеры в прошлом ответе).

---

## Архитектура админки (краткий recap)

**Файлы:**
- `middleware.ts` — auth гейт
- `/admin/login` — страница логина
- `/admin` — страница настроек (AdminPanel)
- `/api/admin/login` — POST endpoint (публичный, не защищён middleware)
- `/api/admin/logout` — POST endpoint (защищён middleware)
- `/api/providers` — GET endpoint с `listProviderMeta()` (НЕ защищён middleware, client-safe)

**Модели работы:**

| Режим | ADMIN_PASSWORD | NODE_ENV | Поведение |
|---|---|---|---|
| Dev, без пароля | unset | development | Все роуты `/admin/*` открыты (dev-bypass) |
| Dev, с паролем | set | development | Нужен логин (как в prod) |
| Prod, с паролем | set | production | Нужен логин |
| Prod, без пароля | unset | production | `/admin/*` → 503 |

**Cookie:**
- Имя: `admin_auth`
- Значение: `sha256("wavespeed-admin-v1:" + password)` в hex
- Флаги: `httpOnly + sameSite=lax + secure(production) + path=/ + maxAge=7days`
- Plaintext пароль никогда не передаётся в cookie

**Caddy усиление** (для production):
```caddyfile
example.com {
    @adminFromWeb {
        path /admin /admin/* /api/admin/*
        not client_ip private_ranges
    }
    respond @adminFromWeb 404
    reverse_proxy localhost:3000
}
```
→ `/admin` из интернета даёт 404, только LAN видит реальную страницу. Два слоя защиты.

---

## ⏳ В работе: порт multi-user + nickname из viewcomfy-claude

### Цель

Дать пользователям возможность вводить свой никнейм при первом заходе и получать свою персональную историю генераций. Уметь читать существующую БД из `viewcomfy-claude` (там уже есть пользователь `max` и другие), чтобы люди сразу увидели свои старые генерации.

### Что уже выяснено (исследование viewcomfy-claude)

**Стек у них:**
- `better-sqlite3 ^12.6.2` + `@types/better-sqlite3`
- `sharp ^0.34.5` (для thumbnail + mid-res preview)
- `uuid` (имена файлов)
- `mime-types`
- `sonner` + `zustand` (уже есть у нас)

**DB схема** (`lib/db.ts` в viewcomfy-claude, прочитан полностью):

```sql
CREATE TABLE generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,                    -- плоский никнейм, НЕ Clerk userId
    workflow_name TEXT DEFAULT '',
    prompt_data TEXT DEFAULT '{}',             -- JSON blob любой формы
    execution_time_seconds REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'completed'
);
CREATE TABLE generation_outputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,                    -- имя файла в history_images/
    content_type TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE
);
CREATE INDEX idx_generations_username ON generations(username);
CREATE INDEX idx_generations_created_at ON generations(created_at);
CREATE INDEX idx_generation_outputs_generation_id ON generation_outputs(generation_id);
```

WAL-режим + foreign_keys ON. Поддерживает concurrent reads во время write.

**API routes** (`app/api/history/route.ts` в viewcomfy, прочитан полностью):
- `GET /api/history?username=X&startDate=&endDate=&limit=&offset=` — список генераций по юзеру
- `POST /api/history` (multipart form):
  - fields: `username`, `workflowName`, `promptData` (JSON string), `executionTimeSeconds`, `output_*` (File entries)
  - Сохраняет файл как `{uuid}{ext}` в `HISTORY_IMAGES_DIR`
  - Через `sharp` генерирует `thumb_{uuid}.jpg` (280px, Q70) и `mid_{uuid}.png` (1200px, Q85) для image/*
  - `getExtFromMime()` для fallback расширений
- `DELETE /api/history?id=X&username=X` — soft delete, DB запись удаляется но файлы остаются на диске

**Identity layer** (`app/providers/user-provider.tsx` в viewcomfy, прочитан полностью):
- React Context + cookie `viewcomfy_username`
- Expire 1 год, `SameSite=Lax`, **НЕ** HttpOnly (JS должен читать)
- Функции: `useUser()` → `{username, setUsername, isUsernameSet}`
- Cookie читается на mount в useEffect, null-рендер до гидрации

**UsernameModal** (`components/username-modal.tsx` в viewcomfy, прочитан полностью):
- Блокирует приложение (`onPointerDownOutside={e=>e.preventDefault()}`)
- Валидация: 2-30 символов
- На Enter или клик кнопки — `setUsername(trimmed)`
- Когда `isUsernameSet === true` — возвращает `null`

**Middleware** (`middleware.ts` в viewcomfy, прочитан полностью):
- Clerk-обёртка с bypass-флагом `NEXT_PUBLIC_USER_MANAGEMENT`
- Если флаг `!== "true"` → всё публично, никнейм без валидации
- Это стандартный пресет viewcomfy — Clerk опционален

### Что пока НЕ дочитано (из-за коротких итераций)

Нужно в итерации 1:
1. **Как отдаются картинки** — в viewcomfy нет `/api/history/image/route.ts` (проверил, ENOENT). Скорее всего через `next.config.mjs` rewrite или public симлинк. **Проверить**.
2. **Где UserProvider оборачивает приложение** — вероятно `app/layout.tsx` или `app/layout-client.tsx`. **Прочитать**.
3. **Как `history-sidebar.tsx` в viewcomfy фетчит данные** — паттерн pagination, error handling, image URL construction. **Прочитать** `hooks/use-local-history.ts` если есть, и остаток `components/history-sidebar.tsx`.

### Архитектурные решения (ПРИНЯТЫ пользователем)

**По БД — env-var подход (не копирование):**

```typescript
const DATA_DIR = process.env.HISTORY_DATA_DIR
  ? path.resolve(process.env.HISTORY_DATA_DIR)
  : path.join(process.cwd(), "data");

const DB_PATH = path.join(DATA_DIR, "history.db");
const HISTORY_IMAGES_DIR = path.join(DATA_DIR, "history_images");
```

- **Dev:** `HISTORY_DATA_DIR` не установлен → используется `wavespeed-claude/data/` (auto-create). dev-БД в `E:\my_stable\viewcomfy\viewcomfy-claude\data\` **пустая** (4 KB, 0 записей, нет `max_k`) — это ОК, будем тренироваться на пустой схеме, добавляя тестовые ники.
- **Production:** контейнер mount-ит `C:\viewcomfy_data\database` на `/data` внутри, env var `HISTORY_DATA_DIR=/data`. Пользователь `max` и все остальные реальные юзеры станут видны.

**Путь к production DB (у пользователя на диске):**
```
C:\viewcomfy_data\database\
├── history.db          (19 484 KB — реальные данные)
├── history.db-shm      (32 KB)
├── history.db-wal      (4 076 KB)
└── history_images\     (директория с картинками)
```
Claude **НЕ имеет доступа** к этому пути (вне allowed dirs) — пользователь специально не выдал, чтобы не сломать боевые данные. Работаем на dev-копии.

**Схема НЕ меняется** — портим старую, поэтому просто пишем свои записи в существующую схему. Чтобы отличать наши записи от viewcomfy:
- `workflow_name` префиксуем как `wavespeed:google/nano-banana-pro/edit` или подобное
- `prompt_data` содержит наш `EditInput` shape (совместим с JSON blob)
- `username` — никнейм из cookie (возможно тот же `viewcomfy_username` для обратной совместимости)

**По localStorage истории — Вариант A (полная замена):**
- Удаляется `stores/history-store.ts` zustand persist
- Вся история читается с сервера через `/api/history?username=X`
- Текущие 14 localStorage записей экспортируются в JSON-файл как бэкап перед удалением

### 5 мини-итераций (план)

| # | Итерация | Файлов | Строк | Статус |
|---|---|---|---|---|
| 1 | **Допрочитать viewcomfy** — next.config.mjs, layout/layout-client.tsx, use-local-history.tsx, history/image/[filename]/route.ts | 0 | 0 | ✅ ГОТОВО |
| 2 | **Backend БД и API** — deps установлены, 3 файла написаны, `.env.example` обновлён. Проверено: GET /api/history?username=test_user возвращает запись viewcomfy (id=2, nanobanana workflow, 27s exec) | 3 новых + 1 edit | ~380 | ✅ ГОТОВО |
| 3 | **Identity + Modal** — `app/providers/user-provider.tsx` + `components/username-modal.tsx`, подключить в `app/providers.tsx` и `<UsernameModal />` первым дочерним в Playground | 2 новых + 1-2 правки | ~150 | ⏳ СЛЕДУЮЩАЯ |
| 4 | **Connect flow** — в `generate-form.tsx` после генерации POST в `/api/history` с username + outputs. В `history-sidebar.tsx` fetch с сервера вместо zustand | 2 правки | ~100 | ⏳ |
| 5 | **Cleanup** — экспорт 14 localStorage в JSON-бэкап, удалить `stores/history-store.ts`, финальная проверка | 1 правка + удаление | ~50 | ⏳ |

**Между каждой итерацией остановка и подтверждение** от пользователя.

### Открытые вопросы перед итерацией 1

Два вопроса которые пользователь ещё не ответил:

1. **Имя cookie для никнейма:**
   - Вариант A: переиспользовать `viewcomfy_username` → юзеры viewcomfy-claude автоматически "войдут" в wavespeed-claude, увидят свою историю без повторного ввода
   - Вариант B: заводим свой `wavespeed_username` → полная изоляция, юзеру нужно заново вводить ник
   - Рекомендация: **Вариант A**, шарим cookie для бесшовного опыта
2. **Бэкап 14 текущих localStorage записей:**
   - Нужен JSON-дамп перед удалением?
   - Или можно просто выкинуть?
   - Рекомендация: **бэкап сделать** (это дёшево, 1 функция, даёт страховку)

---

## Ответ на вопрос про параллельные генерации (зафиксировано)

**12 одновременных юзеров — работает без проблем.** Nodejs event loop асинхронный, Next.js route handlers тоже, провайдеры получают параллельные HTTP-запросы. Реальные узкие места:

1. **Rate limits провайдеров** (WaveSpeed/Fal/Comfy) — внешние лимиты RPS на API-ключ. При 12 одновременных может словить 429. Для Comfy уже есть retry-on-5xx, в будущем стоит добавить retry-on-429 для WS и Fal.
2. **SQLite writes** — sync через better-sqlite3, каждая запись 5-20 мс. 12 sequential writes = ~200 мс суммарно, незаметно. WAL позволяет concurrent reads во время write.
3. **Память** — ~120 MB на 12 юзеров с 2 картинками каждый (base64 буферы). Терпимо для бытового деплоя.
4. **File I/O** — async, не блокирует, 12 параллельных записей в разные UUIDы безопасны.

Итого: планируемый деплой на 12+ юзеров архитектурно supported, нужно только мониторить rate limits провайдеров.

---

## Rollback пойнты

| Checkpoint | Состояние | Как откатиться |
|---|---|---|
| **CHECKPOINT-v4 (этот)** | 3 провайдера + t2i + админка + UI рефактор. Без multi-user | Текущее состояние файлов. Рекомендуется `git commit -m "checkpoint v4: admin + UI refactor"` |
| **CHECKPOINT-v3** | 3 провайдера + t2i, без админки. Жёлтый TEMP-селектор в форме | `git revert` до v3 commit |
| **CHECKPOINT-v2** | Только WaveSpeed + Fal, без Comfy. ZIP у пользователя | `git revert` или распаковать ZIP |

---

## Среда и ключи

**Путь проекта:** `E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude`

**`.env.local` (все настроено):**
```
WAVESPEED_API_KEY=f760f040...
FAL_KEY=7d6c630d-...
COMFY_API_KEY=comfyui-3f48fb3a...
# ADMIN_PASSWORD=   (не установлен → dev bypass активен)
# HISTORY_DATA_DIR= (не установлен → будет использован ./data)
```

**Allowed dirs для Claude Filesystem tool:**
- `E:\my_stable\viewcomfy\viewcomfy-claude` (весь проект включая wavespeed-claude)
- `E:\my_stable\viewcomfy\clean_comfy` (для Comfy reverse engineering)
- Ряд других путей не относящихся к проекту

**Production-путь с реальными данными (НЕ в allowed dirs):**
`C:\viewcomfy_data\database\` — hands off

**Node.js:** 18+, **OS:** Windows 11, **Shell:** PowerShell

---

## 🔖 Фраза для продолжения работы в новой сессии

Если эта сессия оборвётся или начнётся новая — скопируй следующее в новое сообщение Claude:

```
Продолжаем wavespeed-claude. Прочитай CHECKPOINT-v4.md 
в корне проекта wavespeed-claude — там весь контекст.

Мы на этапе порта multi-user + никнеймов из viewcomfy-claude. 
План — 5 мини-итераций, мы на итерации 1 (допрочитать 
viewcomfy-claude: next.config.mjs, app/layout.tsx, остаток 
history-sidebar.tsx + use-local-history.ts). Код ещё не писался.

Открытые вопросы на которые мне надо ответить перед итерацией 2:
1. Имя cookie для никнейма — viewcomfy_username (шарим) 
   или wavespeed_username (изолируем)?
2. Бэкап 14 текущих localStorage записей истории — делать 
   JSON-дамп перед удалением zustand store или выкинуть?

Путь проекта: 
E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude

Приступай к итерации 1: коротким ходом допрочитай три 
файла из viewcomfy-claude и выдай мне резюме + точный 
план итерации 2 (без написания кода).
```

---

## Полный список файлов проекта (на момент v4)

```
wavespeed-claude/
├── .env.example                         ← обновлён v4 (ADMIN_PASSWORD секция)
├── .env.local                           ← не коммитится, 3 ключа
├── CHECKPOINT.md                        ← Шаг 1
├── CHECKPOINT-v2.md                     ← Шаг 2 (до Comfy)
├── CHECKPOINT-v3.md                     ← Шаг 3 + t2i (до админки)
├── CHECKPOINT-v4.md                     ← ★ ЭТОТ файл
├── README.md                            ← нуждается в обновлении
├── middleware.ts                        ← ★ НОВЫЙ v4 (admin auth)
│
├── app/
│   ├── admin/                           ← ★ НОВАЯ директория v4
│   │   ├── page.tsx                     ← server wrapper для AdminPanel
│   │   └── login/
│   │       └── page.tsx                 ← client login form
│   ├── api/
│   │   ├── admin/                       ← ★ НОВАЯ v4
│   │   │   ├── login/route.ts
│   │   │   └── logout/route.ts
│   │   ├── providers/                   ← ★ НОВАЯ v4
│   │   │   └── route.ts                 ← GET listProviderMeta()
│   │   ├── generate/
│   │   │   ├── submit/route.ts
│   │   │   └── status/[id]/route.ts
│   │   └── wavespeed/                   ← 410 stubs (legacy)
│   ├── layout.tsx
│   ├── page.tsx                         ← <Playground />
│   └── providers.tsx
│
├── components/
│   ├── admin-panel.tsx                  ← ★ НОВЫЙ v4
│   ├── generate-form.tsx                ← ★ правки v4 (убран TEMP, sticky button, reorder)
│   ├── history-panel.tsx
│   ├── history-sidebar.tsx              ← будет переписан в Шаге 5, итерация 4
│   ├── image-dialog.tsx
│   ├── image-dropzone.tsx
│   ├── output-area.tsx
│   ├── playground.tsx                   ← ★ правки v4 (убран TopBar, новый хедер)
│   ├── result-panel.tsx
│   ├── theme-toggle.tsx
│   ├── top-bar.tsx                      ← deprecated stub (render null)
│   └── ui/
│       ├── button.tsx
│       ├── dialog.tsx
│       ├── select.tsx
│       ├── textarea.tsx
│       └── label.tsx
│
├── lib/
│   ├── image-storage.ts
│   ├── utils.ts
│   └── providers/
│       ├── types.ts
│       ├── registry.ts
│       ├── wavespeed.ts
│       ├── fal.ts
│       └── comfy.ts
│
├── stores/
│   ├── history-store.ts                 ← будет удалён в Шаге 5, итерация 5
│   └── settings-store.ts                ← ★ НОВЫЙ v4 (activeProvider)
│
├── types/
│   └── wavespeed.ts
│
├── public/
│   └── generated/                       ← runtime картинки
│
├── data/                                ← будет создан в итерации 2 (если HISTORY_DATA_DIR unset)
│
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── package.json
└── package-lock.json
```

---

*CHECKPOINT-v4 завершён. Следующий — v5 после завершения всех 5 мини-итераций мульти-юзер порта.*
