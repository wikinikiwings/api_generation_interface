# CHECKPOINT v3 — wavespeed-claude

> **Назначение:** отсечка после завершения Шага 3 (Comfy провайдер через прямой вызов `api.comfy.org`) и расширения всех провайдеров на text-to-image через auto-switch.
>
> **Это известно-рабочая точка.** Все три провайдера подтверждены в обоих режимах (edit + t2i). Можно смело продолжать Шаг 4 (бургер-меню + settings store) или начинать отсюда подготовку к мульти-модельной архитектуре.
>
> Этот документ **самодостаточный** — если сессия потеряется или возвращаемся к проекту через месяц, чтения только этого файла должно быть достаточно чтобы полностью восстановить контекст и продолжить.

**Дата отсечки:** 10 апреля 2026
**Статус:** WaveSpeed ✅ · Fal.ai ✅ · Comfy API ✅ · все три × (edit + t2i) ✅ подтверждено

---

## Содержание

- [TL;DR](#tldr)
- [Что изменилось с v2](#что-изменилось-с-v2)
- [Статус провайдеров](#статус-провайдеров)
- [Архитектура recap](#архитектура-recap)
- [Comfy провайдер — deep dive](#comfy-провайдер--deep-dive)
- [Text-to-image auto-switch](#text-to-image-auto-switch)
- [Подготовка к мульти-модельной архитектуре](#подготовка-к-мульти-модельной-архитектуре)
- [Осталось в Шаге 4](#осталось-в-шаге-4)
- [Backlog](#backlog)
- [Инвентарь файлов](#инвентарь-файлов)
- [Среда](#среда)
- [Rollback пойнты](#rollback-пойнты)
- [Next session starter](#next-session-starter)

---

## TL;DR

Шаг 3 (Comfy провайдер) с первых двух подходов не получился: **cloud.comfy.org** оказалась их платной GPU-подпиской (получали 429 "Subscription required"), **локальный ComfyUI** — не то что хотелось (пользователь не хотел держать второй процесс). Решение из третьей итерации: **прямой HTTP-вызов `api.comfy.org/proxy/vertexai/gemini/...`** через полную эмуляцию того что делает нода `GeminiImage2Node` изнутри ComfyUI. Реализация через reverse engineering исходников ComfyUI в `E:\my_stable\viewcomfy\clean_comfy`. Никакого ComfyUI процесса, никакой Cloud-подписки — только API-кредиты на `platform.comfy.org`.

Затем — все три провайдера расширены на text-to-image режим **без явного переключателя** в UI: если картинок нет, провайдер автоматически выбирает t2i endpoint.

Оба изменения **полностью обратно совместимы** с v2. Provider interface, схема истории, storage, client polling — всё не тронуто.

---

## Что изменилось с v2

### Добавлено

1. **Полноценный Comfy провайдер** (`lib/providers/comfy.ts`, ~720 строк)
   - Прямой POST к `https://api.comfy.org/proxy/vertexai/gemini/gemini-3-pro-image-preview`
   - Авторизация через `X-API-KEY` заголовок (формат `comfyui-...`)
   - **Гибридная загрузка картинок:** первые 10 через двух-шаговый signed-URL-dance в `/customers/storage`, остальные (11-14) inline base64
   - **Auto-retry на 5xx** (статусы 408/500/502/503/504) с exponential backoff 5с → 15с, до 2 повторов. Зеркалит `_RETRY_STATUS` из ComfyUI `client.py`
   - **Обработка обеих форм output:** `inlineData.data` (base64 в теле) или `fileData.fileUri` (URL на comfy storage) — `extractOutputImages` детектирует обе
   - **Sync провайдер** (`isAsync: false`) — один блокирующий HTTP вместо polling

2. **Text-to-image auto-switch во всех трёх провайдерах**
   - Без явного режим-селектора в UI: наличие или отсутствие входных картинок определяет режим
   - Comfy: тот же Gemini endpoint, просто пустые image parts
   - WaveSpeed: условный URL `/edit` vs `/text-to-image`, одинаковая async схема
   - Fal: условный URL `.../edit` vs bare `fal-ai/nano-banana-pro` (без суффикса), одинаковая sync схема

3. **Mode-aware `HistoryEntry.model`**
   - `MODEL_BY_PROVIDER` константа заменена на функцию `getModelString(provider, hasImages)`
   - История теперь сохраняет точный endpoint который был реально вызван — удобно для будущей отладки и аналитики

### Изменено

- `components/generate-form.tsx`: убрана фронтенд-валидация "at least one image", обновлён лейбл поля картинок, `MODEL_BY_PROVIDER` → `getModelString`
- `.env.example`: комментарии COMFY_API_KEY переписаны под direct-call подход
- Лейбл провайдера в жёлтом селекторе: эволюционировал "Comfy Cloud" → "Comfy (local)" → **"Comfy API"**

### Файлы которые НЕ трогали (архитектура v2 выдержала)

- `lib/providers/types.ts` — Provider interface нагрузку держит
- `lib/image-storage.ts` — все новые вызовы через существующие `saveBinary` / `downloadAndSave`
- `app/api/generate/submit/route.ts` — discriminated union `sync | async` уже поддерживал обе ветки
- `app/api/generate/status/[id]/route.ts` — не тронут
- `stores/history-store.ts` — schema v2 уже содержит `provider` поле
- Все UI компоненты кроме `generate-form.tsx` — не тронуты

---

## Статус провайдеров

| Провайдер | id | Тип | Edit | T2I | Retry? | Файл реализации |
|---|---|---|---|---|---|---|
| **WaveSpeed** | `wavespeed` | async (poll) | ✅ | ✅ | нет | `lib/providers/wavespeed.ts` (~175 строк) |
| **Fal.ai** | `fal` | sync (блок HTTP) | ✅ | ✅ | нет | `lib/providers/fal.ts` (~155 строк) |
| **Comfy API** | `comfy` | sync (блок HTTP) | ✅ | ✅ | да (5xx × 2) | `lib/providers/comfy.ts` (~720 строк) |

**Важное наблюдение про модель:** все три провайдера используют **одну и ту же модель** Google — `gemini-3-pro-image-preview`. Разница только в прокси-слое (кто проксирует и кому платить). То что Fal и WaveSpeed разделяют "edit" и "text-to-image" на два endpoint'а — это их маркетинговая/архитектурная обёртка, но под капотом один и тот же вызов `POST …:generateContent` с разным составом `contents.parts`.

### Тесты подтверждённые в этой сессии

| Тест | Результат |
|---|---|
| Comfy API edit, 1 картинка @2K | ✅ ~81 сек |
| Comfy API edit, 2 картинки @2K | ✅ ~103 сек (upload×2 + Gemini + download output) |
| Comfy API: retry-on-5xx | ✅ сработал (503 → повтор через 5 сек → успех) |
| Comfy API t2i | ✅ подтверждено |
| WaveSpeed edit | ✅ регрессия после t2i switch прошла |
| WaveSpeed t2i | ✅ подтверждено |
| Fal edit | ✅ регрессия после t2i switch прошла |
| Fal t2i (bare URL без суффикса) | ✅ подтверждено |

---

## Архитектура recap

Большая часть архитектуры не изменилась с v2. Этот раздел — краткая выжимка того что важно для следующих шагов. Для полного описания см. CHECKPOINT-v2.md.

### Provider interface (`lib/providers/types.ts`)

```typescript
export interface Provider {
  id: ProviderId;              // "wavespeed" | "comfy" | "fal"
  displayName: string;         // видимое имя в UI
  modelLabel: string;          // "Nano Banana Pro · Gemini 3 Pro Image"
  isAsync: boolean;            // true = polling нужен, false = блокирующий HTTP
  isConfigured(): boolean;     // есть ли ENV-ключ
  submit(input: EditInput): Promise<SubmitResult>;
  getStatus?(taskId: string): Promise<StatusResult>;  // только для async
}
```

`SubmitResult` — discriminated union:

```typescript
type SubmitResult =
  | { kind: "sync"; outputUrls: string[]; executionTimeMs: number }
  | { kind: "async"; taskId: string };
```

Этот контракт выдержал три совершенно разных провайдера без special-cases в UI.

### EditInput (общий вход для всех провайдеров)

```typescript
interface EditInput {
  prompt: string;
  images: string[];       // массив может быть ПУСТЫМ → t2i режим
  resolution: Resolution; // "1k" | "2k" | "4k"
  aspectRatio?: AspectRatio;
  outputFormat: OutputFormat;
}
```

**Здесь НЕТ поля `modelId`.** Сейчас каждый провайдер хардкодит свою единственную модель. Это то что надо расширить для мульти-моделей — см. соответствующий раздел ниже.

### Флоу запроса

```
Browser                    Next.js route            Provider              External API
------------------------   --------------------     --------------        ------------
GenerateForm.handleSubmit
  ├→ POST /api/generate/submit
  │                        ↓
  │                        validate body
  │                        getProvider(body.provider)
  │                        provider.submit(input)
  │                                                 ↓
  │                                                 (varies per provider)
  │                                                                       ← upload/POST
  │                                                 ← SubmitResult
  │                        ← GenerateSubmitResponse
  ├─ IF kind === "sync":
  │    updateHistory(completed)
  └─ ELSE (async):
       every 1.5s → GET /api/generate/status/:id?provider=...
                            ↓
                            provider.getStatus(id)
                                                    ← GET status/result
                            ← GenerateStatusResponse
       updateHistory on each poll until status === completed | failed
```

Client branching на `kind === "sync" | "async"` — **единственное** место во фронтенде где код знает про разные типы провайдеров. Всё остальное унифицировано.

### `lib/image-storage.ts`

Server-only хелпер. API:

- `saveBinary(data, ext)` → `SavedImage{filename, publicUrl, absolutePath, sizeBytes}` — сохранить бинарник под `public/generated/<uuid>.<ext>`
- `saveBase64(dataUriOrBase64, fallbackExt)` — декодит data URI или plain base64 и сохраняет
- `downloadAndSave(url, preferredExt?)` — скачивает с внешнего URL и сохраняет

Все три провайдера приводят результат в локальный `/generated/<uuid>.<ext>` URL, чтобы история не зависела от доступности внешних сервисов и не ломалась при expiration their URLs.

---

## Comfy провайдер — deep dive

**Это самая сложная и ценная часть проекта.** Восстанавливать этот раздел с нуля без исходников ComfyUI — несколько часов. Сохранить эти знания здесь критично.

### Концепция

**Мы НЕ запускаем ComfyUI.** Мы читаем исходники ComfyUI в `E:\my_stable\viewcomfy\clean_comfy`, понимаем как `GeminiImage2Node` внутри делает HTTP-запросы к `api.comfy.org`, и воспроизводим то же самое на TypeScript в нашем Next.js backend.

### Исходники ComfyUI которые надо знать

Для восстановления контекста в случае изменения API — эти файлы надо перечитать:

| Файл в `clean_comfy/` | Что из него взяли |
|---|---|
| `comfy_api_nodes/nodes_gemini.py` | Функция `create_image_parts` (гибридная стратегия загрузки), класс `GeminiImage2.execute()`, константа `GEMINI_BASE_ENDPOINT = "/proxy/vertexai/gemini"`, функция `get_image_from_response` (парсит обе формы output) |
| `comfy_api_nodes/apis/gemini.py` | Все Pydantic модели: `GeminiImageGenerateContentRequest`, `GeminiGenerateContentResponse`, `GeminiPart`, `GeminiInlineData`, `GeminiFileData`, `GeminiImageConfig`, `GeminiImageOutputOptions` |
| `comfy_api_nodes/util/client.py` | `sync_op`, `ApiEndpoint`, `_request_base`, `_friendly_http_message`, `_RETRY_STATUS = {408, 500, 502, 503, 504}` |
| `comfy_api_nodes/util/_helpers.py` | `default_base_url()` → `"https://api.comfy.org"`, `get_auth_header()` → `{"X-API-KEY": api_key_comfy_org}` (**все заглавные** KEY!) |
| `comfy_api_nodes/util/upload_helpers.py` | Двух-шаговая схема загрузки: `UploadRequest{file_name, content_type}` / `UploadResponse{upload_url, download_url}`, функции `upload_file_to_comfyapi` и `upload_file` |

### HTTP-спецификация (фактическая, проверенная)

**Основной POST к Gemini прокси:**

```
POST https://api.comfy.org/proxy/vertexai/gemini/gemini-3-pro-image-preview

Headers:
  X-API-KEY: comfyui-<rest of key>     ← ВСЕМИ ЗАГЛАВНЫМИ, критично
  Content-Type: application/json
  Accept: application/json

Body:
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "<user prompt>" },
        { "fileData":   { "mimeType": "image/png", "fileUri": "<url from /customers/storage>" } },
        { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
      ]
    }
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE"],
    "imageConfig": {
      "imageSize": "2K",                 // "1K" | "2K" | "4K" — ЗАГЛАВНЫМИ
      "aspectRatio": "16:9",             // опционально, ОТСУТСТВУЕТ если user выбрал "auto"
      "imageOutputOptions": {
        "mimeType": "image/png"          // всегда image/png, как в ComfyUI Pydantic default
      }
    }
  },
  "uploadImagesToStorage": true           // всегда true, мимикрия ComfyUI Pydantic default
  // systemInstruction: НАМЕРЕННО не включается (избегаем агрессивный GEMINI_IMAGE_SYS_PROMPT
  // по умолчанию из ComfyUI — чтобы получить нейтральное поведение как у Fal/WS)
}
```

**Успешный ответ:**

```json
{
  "candidates": [
    {
      "content": {
        "role": "model",
        "parts": [
          // Может быть ЛИБО:
          { "inlineData": { "mimeType": "image/png", "data": "<base64 PNG>" } },
          // ЛИБО:
          { "fileData": { "mimeType": "image/png", "fileUri": "<comfy storage url>" } }
        ]
      },
      "finishReason": "STOP"
    }
  ],
  "modelVersion": "gemini-3-pro-image-preview",
  "usageMetadata": { ... }
}
```

**КРИТИЧНО:** output-картинка может прийти **либо inline base64, либо как URL** — зависит от того что прокси решит (похоже связано с флагом `uploadImagesToStorage: true` в запросе). Наш парсер `extractOutputImages` умеет обе формы. В ComfyUI `get_image_from_response` тоже handles both — это не баг, это нормальное поведение API.

### Загрузка входных картинок — двух-шаговый signed-URL

```
# Шаг 1: создать upload slot
POST https://api.comfy.org/customers/storage
  X-API-KEY: comfyui-<key>
  Content-Type: application/json
  Body: {"file_name": "wsc_<ts>_<i>.png", "content_type": "image/png"}

Response 200:
  {"upload_url": "<signed S3-like PUT URL>", "download_url": "<stable GET URL>"}

# Шаг 2: залить бинарник по signed URL
PUT <upload_url>
  Content-Type: image/png
  Body: <raw image bytes>
  # БЕЗ X-API-KEY — signed URL сам self-аутентифицируется через query params

Response 200 (пустое тело)
```

После этого `download_url` из шага 1 идёт в `fileData.fileUri` в основном запросе.

### Гибридная стратегия в `buildImageParts`

```
Первые 10 картинок  → POST /customers/storage → PUT signed URL → fileData.fileUri
Картинки 11-14      → inline base64 в inlineData.data
Картинки 15+        → ошибка "Maximum 14 input images"
```

**Обоснование гибрида:**
- Vertex AI документирует лимит 10 file URIs на запрос — больше URL'ов нельзя
- Но inline base64 не имеет такого лимита
- Поэтому первые 10 через storage (экономия body size), остальные inline
- Это **точная копия** `create_image_parts()` из ComfyUI
- Для проекта на удалённом ПК это тем более важно — мы не хотим тащить 14 × 5 MB = 70 MB в одном HTTP

### HTTP статусы и retry

| Status | Дословно из `_friendly_http_message` ComfyUI | Наш retry? |
|---|---|---|
| **401** | "Unauthorized: Please login first" | нет (ключ плохой) |
| **402** | "Payment Required: add credits" | нет (нет денег на аккаунте) |
| **409** | "Problem with account, contact support" | нет (админский вопрос) |
| **429** | "Rate Limit Exceeded" | нет (хинт пользователю подождать) |
| **408** | Request timeout | **да** |
| **500** | Internal server error | **да** |
| **502** | Bad gateway | **да** |
| **503** | Service unavailable (видели прям в сессии) | **да** |
| **504** | Gateway timeout | **да** |

**Наш retry policy:** до 3 попыток суммарно (1 первая + 2 повтора), backoff 5с → 15с. Total worst-case ~ 30с + 5с + 30с + 15с + 30с = ~110с. `maxDuration` роута = 300с, запас есть.

### Known risks (актуально)

1. **`api.comfy.org/proxy/*` — внутренний, не публичный API.** Формат может измениться без уведомления. Обнаружить поломку — по деградации наших запросов. Починить — перечитать `nodes_gemini.py` и `apis/gemini.py` в актуальной версии ComfyUI, обновить наши типы и код.

2. **`uploadImagesToStorage: true` — неизвестный эффект.** Мы просто зеркалим ComfyUI (у них Pydantic default = True). Что именно этот флаг делает на прокси-стороне — не задокументировано, возможно влияет на то возвращается ли output как inline или fileData. Выключать не стоит пока не заработает плохо.

3. **ToS comfy.org — серая зона.** Формально они продают "API nodes" как фичу внутри ComfyUI, прямой вызов прокси это обёртку обходит. Юридический риск для персонального использования ~0, но для публичного деплоя непонятен.

4. **`X-API-KEY` auth на прямые запросы работает.** Это было неочевидно до первого теста — мы не знали, примет ли прокси запрос не от "настоящего" ComfyUI. Принимает. Важно что ничего больше им не надо (ни подписи, ни user-agent, ни origin check).

---

## Text-to-image auto-switch

### Концепция

**Единый UI без переключателя режима.** Логика:
- Если пользователь загрузил ≥ 1 картинку → **edit** режим
- Если нет → **text-to-image** режим
- Переключение происходит **внутри каждого провайдера** на основе `input.images.length`
- Фронтенд не знает про это различие — он просто шлёт `EditInput` с возможно пустым `images: []`

### Реализация по провайдерам

| Провайдер | Edit endpoint | T2I endpoint | Body diff |
|---|---|---|---|
| **WaveSpeed** | `/api/v3/google/nano-banana-pro/edit` | `/api/v3/google/nano-banana-pro/text-to-image` | убирается поле `images` |
| **Fal** | `https://fal.run/fal-ai/nano-banana-pro/edit` | `https://fal.run/fal-ai/nano-banana-pro` *(БЕЗ суффикса)* | убирается поле `image_urls` |
| **Comfy** | *(тот же URL)* | *(тот же URL)* | в `contents.parts` не добавляются image parts |

Comfy самый простой — endpoint один и тот же, просто parts не содержат картинок. Это ровно то же что делает сам `GeminiImage2.execute()` в ComfyUI когда `images is None`:

```python
parts: list[GeminiPart] = [GeminiPart(text=prompt)]
if images is not None:
    parts.extend(await create_image_parts(cls, images))
```

### Определение режима в каждом провайдере

```typescript
const hasImages = !!input.images && input.images.length > 0;
// дальше условные ветки endpoint и payload
```

Ничего хитрого.

### Client-side изменения

В `components/generate-form.tsx`:

- Убрана валидация `if (images.length === 0) toast.error(...)`
- Лейбл поля картинок: **"Входные изображения · опционально (пусто = text-to-image)"**
- Константа `MODEL_BY_PROVIDER` → функция `getModelString(provider: ProviderId, hasImages: boolean): string`
- При создании `HistoryEntry` модель записывается через `getModelString(activeProvider, images.length > 0)`

### Что НЕ сделано (осталось в backlog)

- **Динамическая смена заголовка карточки** "Nano-banana-pro · Edit" → "Generate" когда картинок нет. Надо найти где этот заголовок живёт (не искали в этой сессии — вероятно `app/page.tsx` или отдельный header-компонент). Чисто косметика
- **Aspect ratio "Auto (match input)" для t2i** — теряет смысл. Сейчас для WS/Comfy пустой `aspectRatio` просто не попадает в body, для Fal превращается в строку `"auto"` и Fal сам её разруливает. Работает, но UI-лейбл обманчив когда нет input'а

---

## Подготовка к мульти-модельной архитектуре

Это **главный раздел** этого checkpoint'а. Пользователь планирует добавить ещё Gemini-модели в будущей сессии — конкретно:

- **Nano Banana 2** (видимо Gemini 2.5 Flash Image новее поколения)
- **Обычная Nano Banana** (Gemini 2.5 Flash Image Preview, более раннее поколение)
- возможно и другие

Всё — это Gemini image models от Google. **В этой сессии НЕ добавляем**, только готовим почву для будущего шага.

### Что хардкожено под одну модель `nano-banana-pro`

Полный аудит мест где сейчас прибито:

#### 1. `lib/providers/comfy.ts`

```typescript
const GEMINI_MODEL = "gemini-3-pro-image-preview";
const GEMINI_ENDPOINT = `${COMFY_API_BASE}/proxy/vertexai/gemini/${GEMINI_MODEL}`;
```

Две константы. **Формат payload универсальный** для всех Gemini image models — `GeminiImageGenerateContentRequest` не меняется, меняется только model в URL.

#### 2. `lib/providers/wavespeed.ts`

```typescript
const url = hasImages
  ? `${getBase()}/api/v3/google/nano-banana-pro/edit`
  : `${getBase()}/api/v3/google/nano-banana-pro/text-to-image`;
```

Две строки URL с hardcoded `nano-banana-pro`. Формат payload универсальный.

#### 3. `lib/providers/fal.ts`

```typescript
const FAL_EDIT_ENDPOINT = "https://fal.run/fal-ai/nano-banana-pro/edit";
const FAL_T2I_ENDPOINT = "https://fal.run/fal-ai/nano-banana-pro";
```

Две константы. Формат payload универсальный.

#### 4. `components/generate-form.tsx`

```typescript
function getModelString(provider: ProviderId, hasImages: boolean): string {
  if (provider === "wavespeed") return hasImages ? "..." : "...";
  if (provider === "fal")       return hasImages ? "..." : "...";
  return "GeminiImage2Node:gemini-3-pro-image-preview";
}
```

6 хардкодных строк (3 провайдера × 2 режима). **Никакого селектора модели в UI нет.**

#### 5. `lib/providers/types.ts`

- **Нет типа `ModelId`**
- `EditInput` **не содержит** поля `modelId`
- `Provider` не знает какие модели он поддерживает

#### 6. Заголовок карточки формы (местоположение неизвестно)

В скриншотах видно "Nano-banana-pro · Edit" — это жёстко прибито где-то в UI-компонентах. Не искали.

### Оценка: насколько сейчас больно добавить модель

**Текущее состояние — нейтральное.** Код не заточен специально под мульти-модельность, но и активно ей не сопротивляется. Каждый провайдер инкапсулирован, изменения будут локальны. Никаких глобальных допущений типа "везде Gemini 3 Pro" в UI, сторах или типах.

| Категория | Оценка | Почему |
|---|---|---|
| **Что не болит** | 🟢 | Имена моделей — плоские строки, не нужна сложная миграция истории. `HistoryEntry.model` уже free-form string и mode-aware после этой сессии. Provider interface общий, не знает про модели — можно добавить поле без breaking change |
| **Что болит средне** | 🟡 | Добавить `ModelId` тип и поле `modelId` в `EditInput`. Рефакторинг 3 провайдеров чтобы читали `input.modelId` и брали URL из маппинга. Добавление селектора модели в UI. Валидация в `/api/generate/submit` |
| **Что болит сильно** | 🔴 | Ничего — архитектура не ломается |

### Предлагаемая миграция (пошаговый план)

#### Шаг A — Типы и данные (`lib/providers/types.ts`)

```typescript
// Новый тип
export type ModelId =
  | "nano-banana-pro"        // Gemini 3 Pro Image (currently hardcoded)
  | "nano-banana-2"          // TODO verify: gemini-2.5-flash-image ?
  | "nano-banana";           // TODO verify: gemini-2.5-flash-image-preview ?

// Расширение EditInput
export interface EditInput {
  modelId: ModelId;          // ← новое поле, required
  prompt: string;
  images: string[];
  resolution: Resolution;
  aspectRatio?: AspectRatio;
  outputFormat: OutputFormat;
}

// Расширение Provider interface
export interface Provider {
  id: ProviderId;
  displayName: string;
  supportedModels: ModelId[];    // ← новое поле
  isAsync: boolean;
  isConfigured(): boolean;
  submit(input: EditInput): Promise<SubmitResult>;
  getStatus?(taskId: string): Promise<StatusResult>;
}
```

*Note:* `modelLabel` можно либо оставить (как дефолтный label для UI если модель не выбрана) либо убрать и вычислять через реестр модель-метадаты.

#### Шаг B — Таблицы маппинга в каждом провайдере

**`lib/providers/wavespeed.ts`:**

```typescript
const MODEL_SLUG_BY_ID: Partial<Record<ModelId, string>> = {
  "nano-banana-pro": "google/nano-banana-pro",
  "nano-banana-2":   "google/nano-banana-2",   // TODO: уточнить точный slug у WaveSpeed
  "nano-banana":     "google/nano-banana",     // TODO: уточнить
};

export const wavespeedProvider: Provider = {
  id: "wavespeed",
  displayName: "WaveSpeed",
  supportedModels: ["nano-banana-pro", "nano-banana-2", "nano-banana"],
  // ...
  async submit(input) {
    const slug = MODEL_SLUG_BY_ID[input.modelId];
    if (!slug) {
      throw new Error(`WaveSpeed: model ${input.modelId} not supported`);
    }
    const url = hasImages
      ? `${getBase()}/api/v3/${slug}/edit`
      : `${getBase()}/api/v3/${slug}/text-to-image`;
    // ...остальное без изменений
  }
};
```

**`lib/providers/fal.ts`:** аналогично, таблица `FAL_MODEL_SLUG_BY_ID`.

**`lib/providers/comfy.ts`:** маппинг напрямую на Gemini model slugs:

```typescript
const GEMINI_MODEL_BY_ID: Partial<Record<ModelId, string>> = {
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2":   "gemini-2.5-flash-image",          // из GeminiImageModel enum
  "nano-banana":     "gemini-2.5-flash-image-preview",  // из GeminiImageModel enum
};
```

`GEMINI_MODEL` и `GEMINI_ENDPOINT` константы удаляются, endpoint строится в runtime: `${COMFY_API_BASE}/proxy/vertexai/gemini/${GEMINI_MODEL_BY_ID[input.modelId]}`.

#### Шаг C — Фронтенд (`components/generate-form.tsx`)

```typescript
// State для выбранной модели
const [selectedModel, setSelectedModel] = useState<ModelId>("nano-banana-pro");

// При смене провайдера — отфильтровать и при необходимости сбросить
useEffect(() => {
  const provider = providers.find(p => p.id === activeProvider);
  if (!provider.supportedModels.includes(selectedModel)) {
    setSelectedModel(provider.supportedModels[0]);
  }
}, [activeProvider]);

// Model селектор в UI (новый блок рядом с provider селектором)
<Select
  value={selectedModel}
  onChange={(e) => setSelectedModel(e.target.value as ModelId)}
  options={MODEL_OPTIONS.filter(m =>
    provider.supportedModels.includes(m.value)
  )}
/>

// getModelString обновляется
function getModelString(provider: ProviderId, modelId: ModelId, hasImages: boolean): string {
  // ... логика
}
```

#### Шаг D — Валидация в `app/api/generate/submit/route.ts`

```typescript
const body = await req.json() as GenerateSubmitBody;
// ...
if (!body.modelId) {
  body.modelId = "nano-banana-pro"; // fallback для старого клиента
}
const provider = getProvider(body.provider);
if (!provider.supportedModels.includes(body.modelId)) {
  return NextResponse.json(
    { error: `Provider ${body.provider} does not support model ${body.modelId}` },
    { status: 400 }
  );
}
```

#### Шаг E — Registry (`lib/providers/registry.ts`)

Добавить хелпер:

```typescript
export function listModelsForProvider(providerId: ProviderId): ModelId[] {
  return getProvider(providerId).supportedModels;
}
```

(Опционально) добавить реестр модель-метадаты:

```typescript
// lib/providers/models.ts (новый файл)
export interface ModelMeta {
  id: ModelId;
  displayName: string;        // "Nano Banana Pro"
  description: string;        // "Gemini 3 Pro Image — highest quality"
  capabilities: {
    edit: boolean;
    textToImage: boolean;
    maxImages: number;
    resolutions: Resolution[];
  };
}

export const MODELS_META: Record<ModelId, ModelMeta> = {
  "nano-banana-pro": { ... },
  "nano-banana-2":   { ... },
  "nano-banana":     { ... },
};
```

Этот файл становится single source of truth для UI selector и валидации.

#### Шаг F — История (`types/wavespeed.ts` / history store)

`HistoryEntry.model` уже free-form string, ничего менять не надо — новые записи будут писать новые значения, старые останутся с `"google/nano-banana-pro/edit"`. Никакой миграции не нужно.

Опционально можно добавить явное поле `HistoryEntry.modelId: ModelId` и сохранить его отдельно от провайдер-специфичной строки — удобно для фильтрации, но требует schema migration.

### Оценка трудозатрат

| Этап | Файлов | Строк кода | Время |
|---|---|---|---|
| A. Типы | 1 (`types.ts`) | ~15 | 5 мин |
| B. Провайдеры | 3 (wavespeed/fal/comfy) | ~30 × 3 = 90 | 30 мин |
| C. Фронтенд | 1 (`generate-form.tsx`) | ~40 | 20 мин |
| D. API роут | 1 (`submit/route.ts`) | ~10 | 5 мин |
| E. Registry + models.ts | 2 | ~50 | 15 мин |
| F. Тестирование | — | — | 30 мин |
| **ИТОГО** | **~7 файлов** | **~200 строк** | **~1.5-2 часа** |

Тест-матрица для приёмки: 3 модели × 3 провайдера × 2 режима = **18 тестов**. Если какой-то провайдер НЕ поддерживает какую-то модель, `supportedModels` это явно выражает и UI-селектор просто не покажет эту комбинацию.

### Что нужно выяснить ДО рефакторинга

Это **внешние unknowns** которые должен уточнить пользователь:

1. **WaveSpeed:** точные URL slugs для `nano-banana-2` и `nano-banana`. Надо смотреть в их API docs (`https://wavespeed.ai/models`)
2. **Fal:** точные model IDs (вероятно `fal-ai/nano-banana-2` и `fal-ai/nano-banana`, но надо сверить с `fal.ai/models`)
3. **Comfy:** Gemini model slugs — можно взять из `comfy_api_nodes/apis/gemini.py` enum `GeminiImageModel`:

```python
class GeminiImageModel(str, Enum):
    gemini_2_5_flash_image_preview = "gemini-2.5-flash-image-preview"
    gemini_2_5_flash_image = "gemini-2.5-flash-image"
```

Плюс `gemini-3-pro-image-preview` который мы уже используем. Итого 3 слуга минимум.

4. **Различия в фичах между моделями:**
   - Resolution ranges. Pro имеет 1K/2K/4K. Flash — проверить (судя по ценовой таблице в `GEMINI_IMAGE_2_PRICE_BADGE` тоже 1K/2K/4K)
   - Max input images — возможно различаются
   - Aspect ratios — вероятно одинаковые (это уровень Vertex AI)
   - System instruction — ComfyUI использует разные дефолтные system prompts для Flash и Pro (проверить!)

5. **UX вопрос:** каждый провайдер показывает свой список моделей (простой путь), или единый список с пометкой "доступно в X, Y"? Первое проще в реализации, второе красивее — обсудить с пользователем

---

## Осталось в Шаге 4

Шаг 4 — **UI-переход** от временного жёлтого селектора провайдера внутри формы к полноценному левому сайдбару с настройками и статусами.

### Работа

1. **`stores/settings-store.ts` (новый)** — zustand persist, primary ключ `selectedProvider: ProviderId`, вскоре добавится `selectedModel: ModelId`
2. **`components/side-menu.tsx` (новый)** — бургер-меню слева, 280px ширина, с:
   - Списком провайдеров + статус каждого (configured ✅ / not configured ❌)
   - Селектором активного провайдера
   - Опционально: селектор модели (или оставить рядом с основной формой)
   - Placeholder для будущих настроек
3. **Эндпоинт `/api/providers` (новый)** — возвращает `listProviderMeta()` (id, displayName, isConfigured) для фронтенда. Клиент-безопасный, ключей не читает
4. **Убрать временный селектор** из `generate-form.tsx`, читать активный провайдер из settings store
5. **Опционально: защита паролем** — `ADMIN_PASSWORD` в env, middleware проверяет cookie на всех `/api/generate/*`

### Примерная оценка

~1-2 часа без защиты паролем, +30 мин на защиту.

### Решить в начале Шага 4

- Порядок работ: **сначала Шаг 4 потом мульти-модели**, или **сначала мульти-модели потом Шаг 4**? (Оба независимы, но мульти-модели добавят второй селектор, и он тоже должен жить в сайдбаре. Возможно проще делать одновременно)
- Защиту паролем делаем сейчас или позже?

---

## Backlog

Мелочи — полезные но не блокирующие:

1. **Динамический заголовок карточки** — "Nano-banana-pro · Edit" → "Generate" когда картинок нет. Найти где живёт (вероятно `app/page.tsx` или `components/Header.tsx`)
2. **Auto-cleanup `public/generated/`** — удалять файлы старше N дней при старте dev-сервера (сейчас накапливается бесконечно)
3. **Провайдер-бейджи на карточках истории** — маленькие "WS" / "FAL" / "CMF" в углу thumbnail'а
4. **Фильтр истории по провайдеру** — dropdown в сайдбаре истории
5. **Фильтр истории по модели** — когда будет мульти-модели
6. **Drag-drop результата обратно в форму** — для итеративного редактирования
7. **Keyboard shortcuts** — `Ctrl+Enter` submit, `Esc` clear
8. **Aspect ratio UX для t2i** — "Auto (match input)" заменять на "Default (1:1)" когда нет картинок
9. **Отключить `console.error` debug-log в prod** — `extractOutputImages` logs response shape даже в production
10. **Error recovery UX** — кнопка "Retry" на failed карточках истории (сейчас только новый запрос)
11. **Прогресс во время Comfy upload** — при >1 картинке хорошо бы видеть какую сейчас заливаем
12. **Дата-фильтр в истории** — "сегодня / вчера / неделя / весь месяц"
13. **Экспорт истории** — выгрузить JSON для бэкапа
14. **Проксирование WaveSpeed URLs** — для CORS-HEAD-probe size-fetching (minor performance thing)
15. **Retry policy для Fal и WaveSpeed** — сейчас только Comfy ретраит, хорошо бы унифицировать

---

## Инвентарь файлов

```
wavespeed-claude/
├── .env.example                         ← обновлён (Comfy API description)
├── .env.local                           ← не коммитится, 3 ключа настроены
├── .gitignore                           ← игнорит public/generated/*
├── CHECKPOINT.md                        ← Шаг 1 (первоначальный MVP)
├── CHECKPOINT-v2.md                     ← Шаг 2 (WaveSpeed + Fal, до Comfy)
├── CHECKPOINT-v3.md                     ← ★ ЭТОТ файл ★
├── README.md                            ← (нуждается в обновлении под 3 провайдера)
│
├── app/
│   ├── api/
│   │   ├── generate/
│   │   │   ├── submit/route.ts          ← unified POST, maxDuration=300
│   │   │   └── status/[id]/route.ts     ← unified GET с ?provider= query
│   │   └── wavespeed/                   ← 410 Gone stubs (legacy совместимость)
│   ├── layout.tsx
│   └── page.tsx
│
├── components/
│   ├── generate-form.tsx                ← ★ обновлён (t2i switch, getModelString)
│   ├── image-dropzone.tsx
│   ├── output-area.tsx
│   ├── history-sidebar.tsx
│   ├── theme-toggle.tsx
│   ├── theme-provider.tsx
│   └── ui/
│       ├── button.tsx
│       ├── dialog.tsx
│       ├── select.tsx
│       ├── textarea.tsx
│       └── label.tsx
│
├── lib/
│   ├── image-storage.ts                 ← saveBinary / saveBase64 / downloadAndSave
│   ├── utils.ts                         ← cn() / fileToThumbnail() / uuid()
│   └── providers/
│       ├── types.ts                     ← Provider / EditInput / SubmitResult (пока без ModelId)
│       ├── registry.ts                  ← getProvider / listProviders / listProviderMeta
│       ├── wavespeed.ts                 ← ★ обновлён (t2i switch)
│       ├── fal.ts                       ← ★ обновлён (t2i switch)
│       └── comfy.ts                     ← ★ НОВЫЙ полностью (direct api.comfy.org, retry, hybrid upload, ~720 строк)
│
├── stores/
│   └── history-store.ts                 ← zustand persist v2 (provider field, migration)
│
├── types/
│   └── wavespeed.ts                     ← re-export shim + HistoryEntry
│
├── public/
│   └── generated/                       ← .gitkeep + runtime-сохранённые картинки
│
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── postcss.config.mjs
├── package.json                         ← Next 15.1.6, React 19, zustand 5, sonner, lucide-react
└── package-lock.json
```

### Приблизительные размеры

| Файл | Строки |
|---|---|
| `lib/providers/comfy.ts` | ~720 |
| `components/generate-form.tsx` | ~345 |
| `lib/providers/wavespeed.ts` | ~175 |
| `lib/providers/fal.ts` | ~155 |
| `lib/image-storage.ts` | ~110 |
| `lib/providers/types.ts` | ~85 |
| `stores/history-store.ts` | ~90 |

Общая кодовая база проекта (без node_modules): ~2500 строк TypeScript + ~100 строк конфигов.

---

## Среда

**Ключи в `.env.local`** (все три настроены и проверены):

```
WAVESPEED_API_KEY=f760f040...
FAL_KEY=7d6c630d-...
COMFY_API_KEY=comfyui-3f48fb3a...
```

**Node.js:** 18+ (нужен для native `fetch`, `FormData`, `Blob`)
**OS:** Windows 11 / PowerShell (пути с backslashes — Next.js это умеет)
**Browser:** неважно, стандартный DOM API
**Путь проекта:** `E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude`
**Reference для reverse engineering Comfy:** `E:\my_stable\viewcomfy\clean_comfy` (полный исходник ComfyUI)

---

## Rollback пойнты

Если что-то сломается в Шаге 4 или при добавлении моделей:

| Точка | Состояние | Как откатиться |
|---|---|---|
| **CHECKPOINT-v3 (сейчас)** | Все три провайдера + t2i работают | Этот файл является снимком состояния. Git commit/тэг рекомендуется: `v3-comfy-and-t2i` |
| **CHECKPOINT-v2** | WaveSpeed + Fal, без Comfy | У пользователя есть ZIP архив. `git revert` до соответствующего комита |
| **CHECKPOINT-v1** | Только WaveSpeed после рефакторинга под Provider interface | Самая ранняя фиксация |

**Рекомендация:** сразу после прочтения этого файла сделать `git commit` с сообщением `"checkpoint v3: comfy + t2i working"` чтобы иметь явный rollback target.

---

## Next session starter

Если возобновляешь работу в новом разговоре, порядок действий:

1. **Прочитать этот файл целиком** — должно быть достаточно чтобы восстановить контекст
2. **Проверить что dev-сервер поднимается:**
   ```powershell
   cd E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude
   npm run dev
   ```
3. **Smoke test:** открыть http://localhost:3000, сгенерировать что-нибудь через "Comfy API" с одной картинкой. Должно занять ~80 секунд и создать файл в `public/generated/`. Если работает — всё ок
4. **Дальше по ситуации:**
   - Если делаем Шаг 4 — см. раздел "Осталось в Шаге 4"
   - Если делаем мульти-модели — см. раздел "Подготовка к мульти-модельной архитектуре", начинать с Шага A (типы)
   - Если что-то сломалось между сессиями — см. "Rollback пойнты"

**Критичные внешние зависимости** которые надо проверить если что-то начнёт ломаться:
- ComfyUI исходники могли обновиться → сверить с `E:\my_stable\viewcomfy\clean_comfy\comfy_api_nodes\`
- `api.comfy.org` формат ответа мог измениться → смотреть `[comfy provider] Could not extract image from response` логи
- Fal / WaveSpeed могли поменять URL / body — смотреть docs на их сайтах

---

*CHECKPOINT-v3 завершён. Следующий checkpoint ожидается после Шага 4 или мульти-модельного рефакторинга.*
