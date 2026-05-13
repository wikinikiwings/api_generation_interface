# MODEL_ADDITION.md (v2)

> **Назначение:** standalone playbook для добавления любой новой image-генеративной модели в wavespeed-claude. v1 был написан под кейс nano-banana family. v2 переписан после добавления seedream 4.5/5.0 Lite — с учётом всех обнаруженных подводных камней и архитектурных решений. **~30 минут — 2 часа** на новую модель в зависимости от того, насколько она похожа на уже добавленные семейства.

---

## Текущее состояние (на момент написания v2)

**Модели (5):**
- `nano-banana-pro` — Gemini 3 Pro Image (Google)
- `nano-banana-2` — Gemini 3.1 Flash Image (Google)
- `nano-banana` — Gemini 2.5 Flash Image (Google, v1, depricated-style)
- `seedream-4-5` — ByteDance Seedream 4.5
- `seedream-5-0-lite` — ByteDance Seedream 5.0 Lite

**Провайдеры (3):**
- **WaveSpeed** (`lib/providers/wavespeed.ts`) — async (submit + poll). Поддерживает все 5 моделей.
- **Fal** (`lib/providers/fal.ts`) — sync (блокирующий POST). Поддерживает все 5 моделей.
- **Comfy** (`lib/providers/comfy.ts`) — sync. Имеет **две внутренние ветки**:
  - **Vertex/Gemini** path (`/proxy/vertexai/gemini/...`) — для всех Google nano-banana моделей.
  - **BytePlus/ByteDance** path (`/proxy/byteplus/api/v3/images/generations`) — для seedream моделей.

**Поддерживаемая матрица:** 5 моделей × 3 провайдера × 2 режима (edit + t2i) = 30 кейсов, все работают.

---

## Архитектура: что нужно понимать ДО написания кода

### 1. Слои абстракции

```
Components (UI)
    │
    │  EditInput (lib/providers/types.ts)
    ▼
Provider files (wavespeed.ts / fal.ts / comfy.ts)
    │
    │  HTTP fetch
    ▼
External API (WaveSpeed / Fal / Comfy.org)
```

`EditInput` — это **универсальный шейп**, который понимают все провайдеры. У него есть generic поля (`prompt`, `images`, `resolution`, `aspectRatio`, `outputFormat`) плюс per-model дополнения (`sourceAspectRatio`). Каждый провайдер транслирует `EditInput` в свой нативный payload через **per-model branch**.

### 2. Capability-driven UI

`lib/providers/models.ts` — single source of truth для UI:

```typescript
export interface ModelCapabilities {
  edit: boolean;
  textToImage: boolean;
  maxImages: number;
  resolutions: Resolution[];      // empty = hide selector
  outputFormats: OutputFormat[];  // empty = hide selector
}
```

`generate-form.tsx` фильтрует и скрывает UI-контролы по этим capabilities. Это даёт **per-model различия в UI без рефакторинга**:
- Если `resolutions: []` → селектор резолюшена скрыт.
- Если `outputFormats: []` → селектор формата скрыт.
- Если `resolutions: ["2k", "4k"]` → юзер видит только 2 опции из 3.

При смене модели `useEffect` в `generate-form.tsx` снапает текущие `resolution`/`outputFormat` к первому поддерживаемому, чтобы submit никогда не отправил невалидную комбинацию.

### 3. Provider × Model автоматчинг

`components/playground.tsx` хранит `PROVIDER_MODELS: Record<ProviderId, ModelId[]>` — client-side зеркало `supportedModels` массивов из провайдеров. При смене провайдера, если текущая модель не поддерживается, `useEffect` снапает на первую доступную. **Важно:** при добавлении модели нужно обновить **обе** таблицы — и в провайдере, и в playground.

### 4. История и cross-tab sync

История (`stores/history-store.ts`) персистится в localStorage и синхронизируется между вкладками через нативный `storage` event + `useHistoryStore.persist.rehydrate()`. Серверная история (`hooks/use-history.ts`) синхронизируется через `BroadcastChannel('wavespeed:history')` + `broadcastHistoryRefresh()`. Никаких действий при добавлении модели не требуется — поля `model` в записях остаются free-form string.

---

## Подводные камни (lessons learned)

### Камень 1: каждый провайдер по-своему роутит t2i vs edit

| Провайдер | nano-banana edit | nano-banana t2i | seedream edit | seedream t2i |
|---|---|---|---|---|
| WaveSpeed | `/google/{slug}/edit` | `/google/{slug}/text-to-image` | `/bytedance/{slug}/edit` | `/bytedance/{slug}` (bare!) |
| Fal | `fal-ai/{slug}/edit` | `fal-ai/{slug}` (bare!) | `fal-ai/bytedance/.../edit` | `fal-ai/bytedance/.../text-to-image` |
| Comfy | один endpoint Vertex | один endpoint Vertex | один endpoint BytePlus | один endpoint BytePlus |

**WaveSpeed и Fal зеркально несовместимы**: для nano-banana у WaveSpeed t2i имеет суффикс, а у Fal — bare. Для seedream — наоборот. **Каждый раз когда добавляешь новое семейство моделей — проверяй curl-ом оба эндпоинта (edit и t2i) у каждого провайдера.** Решение в коде: per-model `t2iSuffix` константа в каждом провайдере.

### Камень 2: имена полей в payload меняются между семействами

Примеры для одной и той же концепции "размер":

| Модель | WaveSpeed | Fal | Comfy/Vertex | Comfy/BytePlus |
|---|---|---|---|---|
| nano-banana | `resolution: "2k"` + `aspect_ratio: "16:9"` | `resolution: "2K"` + `aspect_ratio` | `imageConfig.imageSize: "2K"` + `aspectRatio` | n/a |
| seedream | `size: "2048*2048"` | `image_size: "square_hd"` или `{width, height}` | n/a | `size: "2048x2048"` (маленькая `x`!) |

**WaveSpeed и BytePlus используют РАЗНЫЕ символы-разделители** (`*` vs `x`). Не перепутай.

Имя поля для входных изображений тоже разное:
- WaveSpeed/Comfy-BytePlus: `images` или `image`
- Fal: `image_urls`
- Comfy/Vertex: `parts: [{fileData: {...}} | {inlineData: {...}}]` (и upload dance)

### Камень 3: capability `resolutions: []` vs `resolutions: ["2k", "4k"]`

Не каждая модель поддерживает 1k/2k/4k. Примеры:
- **nano-banana v1** — нет концепции resolution вообще → `resolutions: []` → UI скрывает.
- **seedream 4.5/5.0 Lite** — физически не делает 1k → `resolutions: ["2k", "4k"]` → UI показывает только два варианта.
- **nano-banana pro/v2** — все три → `resolutions: ["1k", "2k", "4k"]`.

И параллельно в провайдерах нужна таблица `MODEL_SUPPORTS_RESOLUTION` — для того чтобы branchить логику payload (резолюшен либо передаётся как есть, либо вычисляется в `size`/`image_size`, либо опускается).

### Камень 4: Auto aspect ratio "match input" работает не у всех

У **nano-banana** Vertex AI inferит aspect из source изображения автоматически — провайдер просто опускает поле `aspect_ratio` и всё работает. У **seedream** API не имеет поля `aspect_ratio` вообще, только `size`/`image_size` в пикселях, и "match source" происходит **на клиенте**:

1. `image-dropzone.tsx` читает `naturalWidth/naturalHeight` через `new Image()` при загрузке файла.
2. `DroppedImage.width/height` хранят размеры.
3. `generate-form.tsx` при сабмите вычисляет `sourceAspectRatio = width / height` первого изображения и шлёт его в body.
4. Провайдеры в seedream-ветках **используют этот ratio** в формуле размера, если юзер не выбрал aspect руками.

Логика приоритетов в каждой формуле размера: **explicit user pick → source aspect → 1:1 fallback**.

Если добавляешь новую модель которая, как и seedream, не имеет нативного aspect_ratio параметра — обязательно используй этот же паттерн.

### Камень 5: разные провайдеры имеют разные клампы размеров

| Провайдер | Допустимый диапазон W/H для seedream |
|---|---|
| WaveSpeed | 512–8192 (UI step) |
| Fal 4.5 | 1920–4096 |
| Fal 5.0 Lite | 1440–3072 (общая площадь до 3072×3072) |
| Comfy/BytePlus | 1024–6240 (W) / 1024–4992 (H) |

При написании per-provider `seedreamSize()` функций нужны **разные клампы**. Жёстко проверь таблицу min/max для каждого нового модельного семейства.

### Камень 6: backwards-compat в API роуте

`app/api/generate/submit/route.ts` имеет fallback `body.modelId = "nano-banana-pro"` если поле отсутствует. Это для старых клиентов и для записей в истории, у которых не было поля `modelId`. **Не убирай этот fallback** при добавлении новых моделей — он не вредит и спасает от регрессий.

### Камень 7: тест-матрица растёт быстро

При 5 моделях × 3 провайдерах × 2 режимах = 30 кейсов. Не все валидные (например, comfy nano-banana-pro работает через Vertex, comfy seedream — через BytePlus). Минимум — прогнать **новую модель** во всех провайдерах в обоих режимах с различными aspect ratio. И **прогнать одну старую модель** чтобы убедиться что не сломали регрессией.

### Камень 8: comfy имеет ДВА upstream пути

`comfy.ts` — самый сложный провайдер. Внутри есть:
- Тяжёлый Vertex/Gemini path с upload dance, parts parsing, retries, error mapping.
- Лёгкий BytePlus/ByteDance path для seedream.

Когда добавляешь новую модель в comfy — определи **какой upstream её обслуживает** (Vertex для Google моделей, BytePlus для ByteDance, возможно появится новый для других вендоров). И добавляй ветку **раздельно**, не путая с существующим code path. Используй `if (input.modelId === "X") return submitX(input);` в начале `submit()` чтобы branch заработал early.

---

## Playbook: добавляем новую модель X

### Фаза 0: что выяснить ПЕРЕД кодом

1. **Какие провайдеры её поддерживают?**
   - Зайти на wavespeed.ai/models, fal.ai/models, проверить наличие.
   - Comfy/Vertex поддерживает только Google-модели; Comfy/BytePlus — только ByteDance. Если модель от другого вендора (Stability, Black Forest, Qwen, Tencent) — comfy не подойдёт без нового upstream пути.

2. **Точные slugs у каждого провайдера**. Откладывай в файл `api_docs/X.txt` копию схемы и curl-примера для будущих ссылок.

3. **Endpoint routing для t2i vs edit**. Иногда суффикс `/text-to-image`, иногда bare slug. **Прогони curl** на оба эндпоинта с пустым телом и невалидным ключом — должен прийти 401, не 404.

4. **Имена полей в payload** (точные). Особенно для размеров — это место где модели больше всего различаются.

5. **Поддерживаемые resolutions**. Смотри в "Schema" блок страницы модели на сайте провайдера. Для каких-то моделей max — 2K, для каких-то — 8K.

6. **Aspect ratio**: есть ли отдельное поле, или зашито в размер. Если зашито — нужен `sourceAspectRatio` flow.

7. **Output format**: документировано? Если нет — возможно скрывать селектор.

8. **Max input images**.

9. **Min/max width/height** (если размер задаётся в пикселях) — для клампов в формуле.

10. **Известные ограничения / quirks**. Например, Seedream 5.0 Lite кэпит на 3K. Иногда есть лимит "общей площади". Иногда `auto_X` enum означает квадрат, а не source-aware.

### Фаза 1: типы (`lib/providers/types.ts`)

Добавить вариант в `ModelId` union:
```typescript
export type ModelId =
  | "nano-banana-pro"
  | ...
  | "X-model-id";
```

Если модель привносит **новые концепции которые не вписываются в existing EditInput** (например, новый параметр типа `seed`, `negative_prompt`, `lora_id`) — обсудить отдельно. Расширять `EditInput` глобально только если параметр универсальный и хочется выставить в UI. Иначе — провайдер-специфичный hack через `delete payload.X` / `payload.Y = ...` в branch'е.

### Фаза 2: реестр (`lib/providers/models.ts`)

Добавить запись в `MODELS_META`:
```typescript
"X-model-id": {
  id: "X-model-id",
  displayName: "User-Facing Name",
  shortLabel: "Short",
  description: "Краткое описание для tooltip",
  capabilities: {
    edit: true,
    textToImage: true,
    maxImages: 10,
    resolutions: ["2k", "4k"],   // или [] если скрывать, или ["1k","2k","4k"]
    outputFormats: ["png", "jpeg"], // или []
  },
},
```

### Фаза 3: провайдеры

**Для каждого провайдера который поддерживает модель:**

1. Добавить slug в `MODEL_SLUG_BY_ID` (или `FAL_MODEL_SLUG_BY_ID` / `BYTEPLUS_MODEL_BY_ID` если comfy).
2. Добавить запись в `MODEL_MAX_IMAGES`.
3. Добавить запись в `MODEL_SUPPORTS_RESOLUTION` (`true` если используется наше generic поле, `false` если payload использует другую схему).
4. Добавить ID в `supportedModels` массив провайдера.
5. Если t2i routing отличается — обновить `t2iSuffix` тернарник (для wavespeed/fal).
6. Если payload schema кардинально другая — добавить **per-model branch** после построения generic payload:
   ```typescript
   if (input.modelId === "X-model-id") {
     payload.custom_field_1 = ...;
     payload.custom_field_2 = ...;
     delete payload.aspect_ratio;
     delete payload.resolution;
     // и т.д.
   }
   ```
7. Если модель не имеет нативного aspect_ratio (как seedream) — использовать `input.sourceAspectRatio` в формуле размера через приоритет **explicit > source > 1:1**.

**Для comfy специально:** определить, использует ли модель Vertex или BytePlus или новый upstream:
- Google → расширить `GEMINI_MODEL_BY_ID` и оно сразу заработает в существующем code path.
- ByteDance → расширить `BYTEPLUS_MODEL_BY_ID` и `submitSeedream()` (или сделать `submitX()` если schema отличается от seedream).
- Другой вендор → новая `submitY()` функция + новый endpoint constant + branch в `submit()`.

### Фаза 4: registry helpers — изменений не нужно

`lib/providers/registry.ts` автоматически читает `supportedModels` из провайдеров через `listModelsForProvider()`. Никаких ручных обновлений.

### Фаза 5: API роут — изменений не нужно

`app/api/generate/submit/route.ts` валидирует `modelId` через `listModelsForProvider()` динамически. Backward-compat fallback на `nano-banana-pro` оставить как есть.

### Фаза 6: фронт — обновить только playground

В `components/playground.tsx` обновить таблицу `PROVIDER_MODELS`:
```typescript
const PROVIDER_MODELS: Record<ProviderId, ModelId[]> = {
  wavespeed: [..., "X-model-id"],   // если поддерживается
  fal:       [..., "X-model-id"],   // если поддерживается
  comfy:     [..., "X-model-id"],   // если поддерживается
};
```

`generate-form.tsx` **изменений не требует** — capability-driven UI автоматически отреагирует на новую запись в `MODELS_META`.

### Фаза 7: тестирование

Минимум для каждого добавленного провайдера:
1. Edit + одно изображение + 1:1 + базовый resolution.
2. Edit + два-три изображения + non-square aspect (16:9 или 9:16).
3. Edit + Auto aspect + вертикальное source изображение → проверить что output вертикальный (если модель относится к категории "size в пикселях").
4. T2i + 1:1 + базовый resolution.
5. T2i + 16:9 + max resolution.
6. T2i + Auto (без aspect) → проверить что не падает (для моделей-без-aspect должен дать square fallback).
7. Регрессия: одна старая модель в edit и t2i режимах — убедиться что не сломалось.
8. Переключение провайдера при выбранной новой модели → если новый провайдер её не поддерживает, должно автоматически снапнуться на другую.

### Фаза 8: документирование

Положить в `api_docs/X.txt` копию curl-примеров и schema-блока со страницы провайдера. Это снимок на момент добавления — через год если API изменится, по этому файлу будет видно что было.

---

## Чеклист файлов

При добавлении одной модели **гарантированно** нужно тронуть:

| Файл | Зачем |
|---|---|
| `lib/providers/types.ts` | расширить ModelId union |
| `lib/providers/models.ts` | новая запись в MODELS_META |
| `components/playground.tsx` | обновить PROVIDER_MODELS таблицу |

**Возможно** нужно тронуть (зависит от провайдеров):

| Файл | Когда |
|---|---|
| `lib/providers/wavespeed.ts` | если WaveSpeed её поддерживает |
| `lib/providers/fal.ts` | если Fal её поддерживает |
| `lib/providers/comfy.ts` | если Comfy её поддерживает (Vertex или BytePlus) |
| `lib/providers/types.ts` (повторно) | если EditInput нужно расширить новым universal полем |
| `components/generate-form.tsx` | только если нужен новый UI control |
| `components/image-dropzone.tsx` | только если нужны новые метаданные source изображений |

**НЕ нужно трогать:**
- `lib/providers/registry.ts`
- `app/api/generate/submit/route.ts`
- `app/api/generate/status/[id]/route.ts`
- `stores/history-store.ts`
- `stores/settings-store.ts`
- `hooks/use-history.ts`
- `components/history-sidebar.tsx`

---

## Workflow для свежего чата

Открой свежий чат и скажи примерно так:

```
В корне wavespeed-claude прочитай:
1. MODEL_ADDITION.md — playbook
2. api_docs/X.txt — схема нужной модели (приложу)

Хочу добавить модель X для провайдеров [WaveSpeed, Fal, Comfy].
Действуй по фазам 0-8 из MODEL_ADDITION.md.
Сначала задай мне вопросы из Фазы 0 которые невозможно ответить
из api_docs (обычно: точные slugs, t2i routing convention,
output_format поведение, мин/макс размеры).

После моих ответов — пиши код по фазам.
```

**Бюджет токенов:** базовая модель похожая на existing семейство — 10-15k токенов. Модель с новыми концепциями (новый payload schema, новый upstream в comfy) — 20-30k.

---

## Известные TODO / на будущее

1. **Comfy seedream — без upload dance**. Сейчас для seedream через BytePlus base64 идёт inline в массиве `image[]`. Если для крупных edit-сессий с 10 изображениями это окажется медленно или будет упираться в лимиты comfy.org — добавить upload dance копированием логики из `uploadSingleImage` Gemini пути.

2. **Pricing/speed подсказки в `description`**. Сейчас description короткий. Можно расширить на подсказки "$0.07 per image, ~5s" чтобы юзер видел trade-off в выпадашке.

3. **Per-provider × per-model capabilities**. Сейчас `MODELS_META` глобальна, и если одна модель на одном провайдере поддерживает edit, а на другом — нет, мы не можем это выразить (выручает только то что на сегодня все провайдеры однородны). Если в будущем понадобится — рефакторить в `MODELS_META[modelId].providers[providerId].capabilities`.

4. **Polling progress UI**. WaveSpeed возвращает в status response иногда `progress: 0.42`. Сейчас игнорируется. Можно показывать прогресс-бар вместо спиннера.

5. **Seed как universal параметр**. Многие модели поддерживают `seed` для воспроизводимости. Не выставлено в UI. Если добавишь — это будет первое расширение `EditInput` за долгое время.

6. **MODEL_ADDITION.md v3**. Если добавится модель с принципиально новыми концепциями (controlnet inputs, multiple outputs, video, audio) — обновить этот документ ещё раз.

---

## Связанные документы

- **`CHECKPOINT-v4.md`** — общее состояние проекта (admin panel, multi-user, etc).
- **`FUTUREPROOF_WARNING.md`** — что нельзя ломать (особенно Comfy magic constants).
- **`api_docs/*.txt`** — снимки схем моделей на момент добавления.
