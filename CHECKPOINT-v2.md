# CHECKPOINT v2 — wavespeed-claude

> **Назначение:** отсечка состояния проекта после завершения Шага 1 (рефакторинг под Provider interface) и Шага 2 (Fal.ai провайдер). Это **известно-рабочая точка отката** перед попыткой внедрить Comfy Cloud в Шаге 3.
>
> Если возвращаемся к проекту в новом разговоре или после отката — читай этот файл целиком, и этого должно быть достаточно чтобы полностью восстановить контекст.

**Дата отсечки:** апрель 2026
**Статус:** WaveSpeed ✅ работает · Fal.ai ✅ работает · Comfy ⏳ не реализовано

---

## Что это за проект

Локальное Next.js веб-приложение для работы с нейросетями через их REST API. Идеологически клон `E:\my_stable\viewcomfy\viewcomfy-claude` (который ходит через локальный ComfyUI), но полностью переписан с нуля. Ключевая идея версии 2 — **мульти-провайдер абстракция**: одна и та же модель (Google Nano Banana Pro / Gemini 3 Pro Image) доступна через несколько бекендов, переключение в один клик.

**Путь проекта:** `E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude`

**API-ключи:** хранятся только серверно в `.env.local`. Клиент никогда не видит ни один ключ — все запросы к внешним API идут через Next.js route handlers под `/api/generate/*`.

---

## Статус провайдеров

| Провайдер | id | Модель под капотом | Тип | Статус | Файл реализации |
|---|---|---|---|---|---|
| **WaveSpeed** | `wavespeed` | Google Nano Banana Pro (Gemini 3 Pro Image) | async (poll) | ✅ работает | `lib/providers/wavespeed.ts` |
| **Fal.ai** | `fal` | Nano Banana Pro / Gemini 3 Pro Image | sync (блок. HTTP) | ✅ работает, проверено что списывается баланс | `lib/providers/fal.ts` |
| **Comfy Cloud** | `comfy` | `GeminiImage2Node` → Gemini 3 Pro Image | async (poll) | ⏳ не реализовано | запланирован `lib/providers/comfy.ts` |

**Важное наблюдение про модель:** все три провайдера используют **одну и ту же** модель Google — `gemini-3-pro-image-preview`. Разделение Fal/WaveSpeed на "edit" и "generate" — это маркетинговые обёртки над одним и тем же API-вызовом Google Vertex AI, а не разные модели. Gemini 3 Pro Image мультимодален: шлёшь только текст → text-to-image, шлёшь текст + картинки → edit. На уровне API это один и тот же `POST …:generateContent` с разным составом `contents.parts`. Comfy этого разделения не делает потому что технически разделять нечего — подробнее в разделе **Знания** ниже.

---

## Стек

- **Next.js 15.1.6** (app router) + **React 19** + **TypeScript 5**
- **Tailwind CSS 3.4** + `tailwindcss-animate` + shadcn-style HSL-токены
- **zustand 5** (+ `persist`, версия схемы **v2** с миграцией) — стор истории
- **next-themes** — тема (по умолчанию dark)
- **sonner** — тосты
- **lucide-react** — иконки
- **@radix-ui/react-dialog** — единственный Radix компонент, для просмотра результата в полном размере
- **clsx + tailwind-merge** — для `cn()`

Namespace-импорт: `@/*` → корень проекта.

Новых зависимостей в Шаге 2 не добавилось — Fal работает через нативный `fetch`.

---

## Переменные окружения

```
# .env.local (не коммитится)

WAVESPEED_API_KEY=...   # https://wavespeed.ai/accesskey
FAL_KEY=...             # https://fal.ai/dashboard/keys
# COMFY_API_KEY=...     # https://platform.comfy.org/profile/api-keys (для шага 3)

# Опционально
# WAVESPEED_API_BASE=https://api.wavespeed.ai
```

Ключи читаются только серверно (`process.env.*` в файлах `lib/providers/*.ts`). Next.js дев-сервер подхватывает `.env.local` только при старте — после правки нужно перезапустить.

---

## Архитектура

```
┌─────────────────────────────────────────────────────┐
│  Browser (React)                                    │
│                                                     │
│  TopBar                                             │
│  ┌──────────────────────────────────────────────┐   │
│  │  GenerateForm                                │   │
│  │  ┌──────────────────┐   ┌─────────────────┐  │   │
│  │  │ [TEMP] provider  │   │  OutputArea     │  │   │
│  │  │   selector       │   │  + today's      │  │   │
│  │  │   ┌─────────┐    │   │  generations    │  │   │
│  │  │   │ WaveSp. │    │   │                 │  │   │
│  │  │   │ Fal.ai  │    │   │  [HistorySidebar]│  │   │
│  │  │   └─────────┘    │   │                 │  │   │
│  │  │                  │   │                 │  │   │
│  │  │ prompt / images  │   │                 │  │   │
│  │  │ / resolution /   │   │                 │  │   │
│  │  │ aspect / format  │   │                 │  │   │
│  │  │                  │   │                 │  │   │
│  │  │ [Generate]       │   │                 │  │   │
│  │  └──────────────────┘   └─────────────────┘  │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
    POST /api/generate/submit
    body: { provider, prompt, images, resolution, ... }
                   │
                   ▼
    ┌────────────────────────────────────────┐
    │  lib/providers/registry.ts             │
    │  getProvider(id) → Provider            │
    └───┬──────────┬──────────┬──────────────┘
        │          │          │
        ▼          ▼          ▼
    wavespeed    fal.ts    comfy.ts
    .ts          (sync)    (не готов)
        │          │          │
        │          │          │
        │          │    (будет: upload→workflow→poll→download→save)
        │          │
        │          └─► POST fal.run/... (block 30+ sec)
        │              → response.images[].url
        │              → downloadAndSave() → public/generated/<uuid>.png
        │              → return {kind:"sync", outputUrls:["/generated/..."]}
        │
        └────► POST api.wavespeed.ai/... → {id}
               → return {kind:"async", taskId}
               → client polls /api/generate/status/:id?provider=wavespeed
```

### Provider interface (`lib/providers/types.ts`)

```ts
export interface Provider {
  id: ProviderId;                // "wavespeed" | "comfy" | "fal"
  displayName: string;
  modelLabel: string;            // короткая подпись модели
  isAsync: boolean;              // нужен polling?
  isConfigured(): boolean;       // env vars заданы?
  submit(input: EditInput): Promise<SubmitResult>;
  getStatus?(taskId: string): Promise<StatusResult>;
}

export type SubmitResult =
  | { kind: "sync";  outputUrls: string[]; executionTimeMs: number }
  | { kind: "async"; taskId: string };
```

Клиент в `generate-form.tsx` обрабатывает discriminated union одним ветвлением:

```ts
if (submitData.kind === "sync") {
  // Fal: результат уже пришёл, пишем в историю как completed
} else {
  // WaveSpeed: запускаем polling до кома./ошибки
}
```

---

## Полная структура файлов

```
wavespeed-claude/
├── .env.example              ← WAVESPEED_API_KEY, FAL_KEY, (закомм.) COMFY_API_KEY
├── .env.local                ← твой, не коммитится
├── .gitignore                ← + /public/generated/* !.gitkeep
├── .gitkeep-файлы            ← public/generated/.gitkeep (якорь директории)
├── README.md
├── CHECKPOINT.md             ← старый, от Шага 0 (MVP WaveSpeed)
├── CHECKPOINT-v2.md          ← ЭТОТ файл — после Шагов 1 и 2
├── package.json              ← next, react, zustand, next-themes, sonner,
│                                lucide-react, @radix-ui/react-dialog, clsx, tw-merge
├── tsconfig.json
├── next.config.mjs           ← remotePatterns для wavespeed.ai + bodySizeLimit 50mb
├── postcss.config.mjs
├── tailwind.config.ts
├── next-env.d.ts
│
├── app/
│   ├── api/
│   │   ├── generate/                         ← НОВЫЕ унифицированные роуты
│   │   │   ├── submit/route.ts               ← POST, диспатчит по provider id,
│   │   │   │                                    возвращает discriminated union
│   │   │   │                                    { kind: "sync"|"async", ... }
│   │   │   └── status/[id]/route.ts          ← GET, читает ?provider=... из query,
│   │   │                                        только для async провайдеров
│   │   │
│   │   └── wavespeed/                        ← ЗАГЛУШКИ старых роутов
│   │       ├── submit/route.ts               ← возвращает 410 Gone с подсказкой
│   │       └── status/[id]/route.ts          ← то же
│   │
│   ├── globals.css                           ← shadcn HSL-токены + кастомный scrollbar
│   ├── layout.tsx                            ← root, lang="ru", suppressHydrationWarning
│   ├── page.tsx                              ← рендерит <Playground />
│   └── providers.tsx                         ← ThemeProvider(dark) + <Toaster />
│
├── components/
│   ├── ui/
│   │   ├── button.tsx                        ← 5 variants, 4 sizes
│   │   ├── textarea.tsx
│   │   ├── select.tsx                        ← native select + ChevronDown + Label
│   │   └── dialog.tsx                        ← Radix Dialog wrapper
│   │
│   ├── top-bar.tsx                           ← sticky header + theme toggle
│   ├── theme-toggle.tsx                      ← Sun/Moon, hydration-safe
│   ├── image-dropzone.tsx                    ← drag & drop до 14 картинок
│   ├── generate-form.tsx                     ← ⚠ СОДЕРЖИТ ВРЕМЕННЫЙ ПРОВАЙДЕР-СЕЛЕКТОР
│   │                                            в жёлтой пунктирной рамке с иконкой
│   │                                            колбы — это stopgap для шага 4, когда
│   │                                            селектор переедет в бургер-меню
│   ├── image-dialog.tsx                      ← Radix Dialog просмотр + Download
│   ├── output-area.tsx                       ← 256×256 миниатюры за сегодня
│   ├── history-sidebar.tsx                   ← 340px слайд-ин справа
│   ├── playground.tsx                        ← композиция всего экрана
│   │
│   ├── result-panel.tsx                      ← DEPRECATED STUB
│   └── history-panel.tsx                     ← DEPRECATED STUB
│
├── lib/
│   ├── providers/                            ← НОВОЕ: абстракция провайдеров
│   │   ├── types.ts                          ← Provider interface, EditInput,
│   │   │                                        SubmitResult (sync/async union),
│   │   │                                        StatusResult, GenerateSubmitResponse,
│   │   │                                        GenerateStatusResponse, ProviderMeta
│   │   ├── registry.ts                       ← getProvider, listProviders,
│   │   │                                        listProviderMeta (client-safe)
│   │   ├── wavespeed.ts                      ← ✅ WaveSpeed provider
│   │   └── fal.ts                            ← ✅ Fal.ai provider
│   │
│   ├── image-storage.ts                      ← НОВОЕ: saveBinary, downloadAndSave,
│   │                                            saveBase64, normalizeExt,
│   │                                            extFromContentType
│   ├── utils.ts                              ← cn, uuid, fileToDataURL,
│   │                                            fileToThumbnail, fromMsToTime,
│   │                                            formatFullDate, startOfToday,
│   │                                            copyToClipboard
│   └── wavespeed.ts                          ← DEPRECATED STUB
│
├── stores/
│   └── history-store.ts                      ← zustand+persist, version 2,
│                                                migrate v1→v2 добавляет provider field
│
├── types/
│   └── wavespeed.ts                          ← backward-compat shim: re-export
│                                                из lib/providers/types + HistoryEntry
│                                                с новым полем provider: ProviderId
│
└── public/
    └── generated/                            ← РАНТАЙМ-хранилище сохранённых картинок
        └── .gitkeep                          ← директория существует в git,
                                                 содержимое в .gitignore
```

---

## Что работает на 100%

### Генерация (WaveSpeed и Fal.ai)

- Форма с промптом, drag & drop до 14 картинок, выбором resolution (1k/2k/4k), aspect ratio, формата (png/jpeg)
- **Временный провайдер-селектор** в верхней части формы (жёлтая пунктирная рамка, иконка колбы, подпись "temp") — одним кликом переключает между WaveSpeed и Fal.ai
- Для WaveSpeed: submit → async → polling каждые 1.5 сек до 5 минут
- Для Fal.ai: submit → sync → HTTP-запрос висит пока модель работает, результат приходит в том же ответе
- После получения `outputUrl`:
  - Fal возвращает URL из своего storage; мы его **скачиваем и сохраняем локально** в `public/generated/<uuid>.png` через `downloadAndSave()`. В истории лежит `/generated/<uuid>.png`, который Next.js раздаёт статически
  - WaveSpeed возвращает `cdn.wavespeed.ai` URL — оставляем как есть, не проксируем (можно будет добавить позже если понадобится долговечное локальное хранение)
- `executionTimeMs` трекается для обоих провайдеров (от кнопки Generate до completed/failed)
- `outputSizeBytes` тянется HEAD-запросом после получения URL (для локальных `/generated/*` работает гарантированно, для `cdn.wavespeed.ai` — как повезёт с CORS)

### UI / UX

- **Layout (1-в-1 как в viewcomfy):** форма слева в карточке `max-w-[440px]`, справа OutputArea + опциональный HistorySidebar
- **OutputArea:** показывает **только сегодняшние** генерации, миниатюры 256×256, flex-wrap, клик → ImageDialog полноразмер, градиент с промптом на hover, кнопка «История» top-right
- **HistorySidebar:** 340px фиксированно, открывается кликом на «История», каждая запись — 140×140 thumbnail → ImageDialog, строка `Total size: X MB - Prompt: [copy]    [delete]`, italic line-clamp-3 промпт, `execution time: Xm Ys - D/M/YYYY HH:MM:SS`
- **ImageDialog:** один компонент для OutputArea и HistorySidebar, Radix Dialog, max-h-[82vh], Download через blob + `<a download>` (обходит CORS)
- **Тема:** тёмная по умолчанию, toggle Sun/Moon, hydration-safe
- **Тосты:** sonner, top-right, richColors, закастомлены под HSL-токены

### Безопасность и стор

- Все API-ключи только на сервере (`process.env.*` читается в `lib/providers/*.ts`)
- Клиент общается только с `/api/generate/*` — ключи никогда не попадают в браузер
- Зaщита на уровне формы и провайдера: min 1 картинка, max 14, непустой промпт
- Копирование промпта в буфер: `navigator.clipboard` с fallback на `execCommand`
- `history-store` версии 2 с миграцией: старые записи из v1 автоматически получают `provider: "wavespeed"` при загрузке (zustand/persist.migrate)

### Поток данных для обоих провайдеров

```
GenerateForm.handleSubmit
  1. Создаёт HistoryEntry со status: "pending", добавляет в store (карточка-лоадер появляется в OutputArea)
  2. POST /api/generate/submit { provider, prompt, images, resolution, ... }
     └─ registry.getProvider(provider).submit(input)
        └─ wavespeed: POST .../edit → {id} → {kind:"async", taskId}
           или
           fal: POST fal.run/.../edit (блок) → {images:[{url}]}
                → downloadAndSave(url) → /generated/<uuid>.png
                → {kind:"sync", outputUrls:["/generated/..."], executionTimeMs}
  3. Клиент смотрит kind:
     - sync: updateHistory(status: "completed", outputUrl) → toast success
     - async: updateHistory(status: "processing", taskId) → pollUntilDone()
              └─ GET /api/generate/status/:id?provider=wavespeed
                 └─ registry.getProvider("wavespeed").getStatus(taskId)
                    └─ GET .../predictions/:id/result → {status, outputs}
              └─ когда status: "completed" → updateHistory(outputUrl) → toast success
  4. Параллельно fire-and-forget: HEAD outputUrl → outputSizeBytes → updateHistory
```

---

## Как запустить

```powershell
cd E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude

# Первый раз:
copy .env.example .env.local
# Отредактируй .env.local, впиши WAVESPEED_API_KEY и FAL_KEY

npm install
npm run dev
```

Открывается на http://localhost:3000.

**Новых зависимостей после Шага 2 не добавилось**, можно не делать `npm install` если он уже был.

---

## Известные ограничения и риски

1. **Размер base64-пэйлоада.** 14 картинок по несколько МБ каждая → тело POST `/api/generate/submit` может превысить лимит. В `next.config.mjs` стоит `experimental.serverActions.bodySizeLimit: "50mb"`, но это про Server Actions, не про route handlers. Если упрёмся — добавлю отдельный upload-эндпоинт как у Fal (а они принимают base64 напрямую, так что для Fal проблема не актуальна; для WaveSpeed и Comfy в будущем — может появиться).

2. **localStorage quota.** 100 записей × (до 14) thumbnails ~15 KB + локальный `/generated/` URL ~0 KB ≈ до 20 MB. Лимит localStorage обычно 5–10 MB. Если упрёмся — уменьшу `MAX_ENTRIES` или размер thumb, или перенесу в IndexedDB.

3. **Рост `public/generated/`.** Каждая Fal-генерация сохраняет файл на диск. Авточистки нет. Придётся периодически чистить вручную либо позже добавить кнопку «Очистить кэш картинок» в админку (Шаг 4+).

4. **Fal sync-вызов держит HTTP 30+ сек** на 4K. Локально Node не таймаутит, всё ок. Если когда-нибудь деплоится на Vercel — там hobby-план таймаут 10 сек, нужен будет переход на Fal queue-эндпоинт.

5. **CORS на HEAD для `cdn.wavespeed.ai`.** `fetchOutputSize()` может не получить Content-Length если CORS не пропустит. В этом случае строка `Total size: X MB` просто не покажется в истории. Ничего не ломается.

6. **Нет тестов.** Ни unit, ни e2e. Полагаемся на ручную проверку на каждом шаге.

7. **stub-файлы.** `components/result-panel.tsx`, `components/history-panel.tsx`, `lib/wavespeed.ts`, `app/api/wavespeed/submit/route.ts`, `app/api/wavespeed/status/[id]/route.ts` — все заглушки. Ничего не ломают, можно безопасно удалить руками при желании.

8. **WaveSpeed `outputUrl` не проксируется.** URL остаётся `cdn.wavespeed.ai/...`. Если WaveSpeed почистит свои кэши или URL протухнет — в истории будет битая ссылка. Для Fal такой проблемы нет т.к. мы скачиваем и сохраняем локально. Если это станет проблемой — можно будет применить тот же `downloadAndSave()` к WaveSpeed outputs (тривиальная правка в `wavespeed.ts`).

---

## Знания: модель vs продукт (важное для будущих решений)

Gemini 3 Pro Image — **одна** мультимодальная модель Google. Один endpoint у Vertex AI: `POST /v1/models/gemini-3-pro-image-preview:generateContent`. В теле передаётся `contents.parts` — массив с комбинацией `{text}`, `{inlineData}` (base64), `{fileData}` (URL).

- **Только текст в parts** → text-to-image
- **Текст + картинки** → image edit / composition
- Это **одна и та же ветка кода** в модели. Разделение "edit vs generate" на уровне продукта у Fal и WaveSpeed — **маркетинговое и навигационное**, а не техническое. Им удобнее иметь две карточки в каталоге и два URL для документации

Видно в `nodes_gemini.py` (файл от пользователя) на строках 812-813 класса `GeminiImage2`:
```python
parts: list[GeminiPart] = [GeminiPart(text=prompt)]
if images is not None:
    parts.extend(await create_image_parts(cls, images))
```
— картинки просто `extend`-ятся в parts если они есть. Никаких условных ответвлений.

**Вывод для Шага 3:** если результаты Comfy окажутся визуально хуже чем Fal/WaveSpeed на том же промпте и картинке, **это не потому что модель другая**. Кандидаты на причину в порядке вероятности:

1. **System prompt.** Comfy-нода по дефолту подставляет довольно агрессивный `GEMINI_IMAGE_SYS_PROMPT`:
   > "You are an expert image-generation engine. You must ALWAYS produce an image. Interpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition..."
   
   Fal и WaveSpeed либо используют другой system prompt, либо не используют его вовсе. Это может существенно сдвигать поведение модели на сложных/двусмысленных запросах.

2. **Seed.** Comfy дефолт seed=42 с `control_after_generate: randomize`. Fal/WS не передают seed — используют случайный на своей стороне. Без фиксации seed сравнение нечестное из-за стохастичности.

3. **Thinking level.** У Gemini 3 Pro есть параметр `thinkingLevel: "MINIMAL"|"HIGH"`. В `GeminiImage2` он **не выставлен явно** — используется дефолт Google. Fal может принудительно ставить `HIGH`. Это влияет на качество.

4. **Response modalities.** Comfy дефолт `"IMAGE+TEXT"`, Fal скорее всего `"IMAGE"` only. Когда модель "рассуждает вслух" текстом, это может влиять на финальный визуал.

5. **Предобработка картинок.** Fal принимает base64, Comfy первые 10 заливает как URL в comfy-storage и передаёт как `fileData`. Google получает одно и то же, но resize/conversion может чуть отличаться.

**Что с этим делать в Шаге 3:**

- **По дефолту слать пустой system_prompt**, а не `GEMINI_IMAGE_SYS_PROMPT` — это должно дать результаты максимально близкие к Fal/WS
- Явно установить `thinking_level` и `response_modalities` на значения, которые дают лучший паритет с Fal (подбираем эмпирически)
- Если хочется паритета — добавить system_prompt как advanced input в форме, но не включать по умолчанию
- Для **честного сравнения провайдеров** нужно: один seed, один prompt, одинаковый набор картинок, одинаковые resolution/aspect, и несколько прогонов на каждом

---

## Временный провайдер-селектор (важно знать)

В `components/generate-form.tsx` сейчас **захардкожен** селектор провайдера в самой верхней части формы:

- Жёлтая пунктирная рамка (`border-amber-500/50 bg-amber-500/5`)
- Иконка колбы (`FlaskConical` из lucide)
- Native select c опциями `wavespeed` / `fal`
- Подпись "temp" справа

Это **stopgap для Шага 2**. В Шаге 4 он будет:
1. Удалён из формы
2. Заменён на бургер-меню слева (кнопка в TopBar)
3. Внутри меню — radio-группа или аналог, с индикатором "настроен/не настроен"
4. Выбор будет сохраняться в новый `stores/settings-store.ts` (zustand + localStorage persist)

До Шага 4 **не трогаем** этот селектор — он нужен чтобы на лету переключаться между провайдерами для тестов.

---

## TODO / backlog (обновлён)

Шаги 1 и 2 закрыты. Остаётся:

### Шаг 3 — Comfy Cloud провайдер (следующий)

Самый объёмный провайдер. Что нужно:

- `lib/providers/comfy.ts`:
  - Endpoint: `POST https://cloud.comfy.org/api/prompt`
  - Auth: `X-API-Key: <COMFY_API_KEY>` (от platform.comfy.org/profile/api-keys)
  - Upload картинок: `POST /api/upload/image` multipart/form-data перед сабмитом workflow
  - Построить workflow JSON программно:
    - `LoadImage` ноды для каждой входной картинки
    - `ImageBatch` ноды каскадом если картинок 2+
    - `GeminiImage2Node` как главный узел, `model: "gemini-3-pro-image-preview"`, **пустой `system_prompt`** (важно, см. Знания выше)
    - `SaveImage` для выхода
  - Polling: `GET /api/job/{prompt_id}/status`
  - Download: `GET /api/view?filename=...&type=output` → следуем за 302 redirect → `downloadAndSave()` в `public/generated/`
  - Возвращает `{kind: "async", taskId}`
- Обновить `lib/providers/registry.ts` — раскомментировать `comfy: comfyProvider`
- Обновить `.env.example` — раскомментировать `COMFY_API_KEY`
- Добавить `comfy` в `PROVIDER_OPTIONS` в `generate-form.tsx` (временный селектор)
- Обновить `MODEL_BY_PROVIDER` в `generate-form.tsx`
- Неизвестные моменты, которые подтвердятся при тесте:
  - Точное имя class_type для "Batch Images" — ставлю 95% что `"ImageBatch"`, но могут быть сюрпризы
  - Работает ли на cloud.comfy.org нода `GeminiImage2Node` (должна — это first-party API node)
  - Биллинг cloud.comfy.org за API-нодовые вызовы — может потребоваться активная подписка
- **Проверка:** сравниваем результаты Comfy vs Fal vs WaveSpeed на одинаковом промпте и картинке. Если Comfy системно хуже — смотрим на system_prompt и thinking_level

### Шаг 4 — Бургер-меню и settings-store

- `stores/settings-store.ts` — новый zustand store с persist, поля: `selectedProvider: ProviderId`, будущие поля settings
- `components/side-menu.tsx` — слайд-ин слева по кнопке в TopBar
- Внутри side-menu: список провайдеров с индикатором "настроен/не настроен", клик выбирает активный
- Провайдеры с `isConfigured() === false` disabled + тултип "добавь XXX_API_KEY в .env.local"
- Клиент получает `ProviderMeta[]` через новый endpoint `/api/providers` (server-side вызывает `listProviderMeta()`)
- Удалить временный селектор из `generate-form.tsx`, заменить на чтение из settings-store
- Место под будущие пункты админки (бейдж "coming soon")
- Пока без пароля — задел на "станет аналогом админки закрытой паролем"

### Шаг 5 — HistoryEntry + provider badge

- В `HistorySidebar` карточка каждой записи показывает мелкий бейджик `WS / FAL / CMF` чтобы визуально отличать провайдера
- В `OutputArea` на hover карточки тоже показывать провайдер в уголке
- Опционально: фильтрация истории по провайдеру (выбор в шапке сайдбара)

### Шаг 6 — Обновление документации

- `README.md` обновляется под мульти-провайдерную архитектуру
- `CHECKPOINT.md` или `CHECKPOINT-v3.md` после завершения всего пакета

### Backlog (из первого чекпоинта, не сделано)

- Фильтры в истории — date range picker
- Drag-n-drop результатов обратно в форму (MIME `application/x-wavespeed-media`)
- Keyboard shortcuts (Ctrl+Enter = Generate, Esc закрывает dialog)
- Persistent prompt/settings в localStorage
- Proxy HEAD-запроса для WaveSpeed (если CORS станет проблемой)
- Upload-эндпоинт в WaveSpeed провайдере (если base64 станет слишком большим)
- Авточистка `public/generated/` по возрасту файлов

---

## Откат на эту точку

Если Шаг 3 (Comfy) пойдёт плохо и захочется вернуться к этому состоянию:

1. **Удалить папку проекта** `E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude` полностью
2. **Распаковать архив**, который сделан в момент этой отсечки, обратно в `E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude`
3. **Проверить `.env.local`** — если перезаписался из архива, убедиться что в нём настоящие ключи WAVESPEED_API_KEY и FAL_KEY
4. **`npm install`** — если в архиве нет `node_modules/`
5. **`npm run dev`** — убедиться что сервер стартует на :3000
6. **Смоук-тест:** переключить провайдер на Fal через жёлтый селектор, сгенерировать картинку, убедиться что:
   - файл появляется в `public/generated/`
   - в истории запись с execution time
   - клик по миниатюре открывает полноразмер
   - Download работает
7. **Переключить на WaveSpeed**, повторить. Смотреть что polling работает, статус меняется `pending → processing → completed`

Если всё ок — ты вернулся к состоянию этой отсечки.

---

## Как возобновить работу (в новом разговоре или после отката)

1. **Прочитать этот файл целиком.** Этого должно хватить для 90% контекста.
2. **Прочитать `README.md`** — краткий обзор, инструкции.
3. **Если нужно освежить архитектуру** — пройти по дереву файлов выше, ключевые для понимания:
   - `components/playground.tsx` — композиция UI
   - `components/generate-form.tsx` — форма + submit логика + временный провайдер-селектор
   - `components/output-area.tsx` — сетка миниатюр сегодняшних генераций
   - `components/history-sidebar.tsx` — правая панель истории
   - `lib/providers/types.ts` — Provider interface и SubmitResult/StatusResult
   - `lib/providers/registry.ts` — где регистрируются провайдеры
   - `lib/providers/wavespeed.ts` — пример async-провайдера
   - `lib/providers/fal.ts` — пример sync-провайдера с downloadAndSave
   - `lib/image-storage.ts` — как работает локальное хранение
   - `stores/history-store.ts` — zustand + persist с миграцией
4. **Выбрать следующий шаг** из TODO (обычно Шаг 3).
5. **Обновить этот файл после значимого изменения.**

---

## Changelog с первого чекпоинта (CHECKPOINT.md)

**Добавлено:**
- Абстракция провайдеров: `lib/providers/{types,registry,wavespeed,fal}.ts`
- Локальное хранилище: `lib/image-storage.ts` + `public/generated/` + .gitkeep
- Унифицированные API-роуты: `app/api/generate/{submit,status/[id]}/route.ts`
- Fal.ai провайдер полностью рабочий, проверено что списывается баланс
- Временный провайдер-селектор в `generate-form.tsx`
- Миграция `history-store` v1→v2: автоматически добавляет `provider: "wavespeed"` к старым записям
- Поле `provider: ProviderId` в `HistoryEntry`
- `FAL_KEY` в `.env.example`
- `/public/generated/*` в `.gitignore` с исключением `.gitkeep`

**Изменено:**
- `types/wavespeed.ts` → backward-compat shim, re-exports из `lib/providers/types`
- `components/generate-form.tsx` → использует новые endpoints `/api/generate/*`, обрабатывает discriminated union sync/async, имеет временный провайдер-селектор, использует `MODEL_BY_PROVIDER` map
- `stores/history-store.ts` → version 2, migrate function
- `next.config.mjs` → без изменений (уже был готов)

**Заглушено (deprecated):**
- `lib/wavespeed.ts` → `export {}` (логика уехала в `lib/providers/wavespeed.ts`)
- `app/api/wavespeed/submit/route.ts` → `410 Gone`
- `app/api/wavespeed/status/[id]/route.ts` → `410 Gone`
- `components/result-panel.tsx`, `components/history-panel.tsx` → `export {}` (deprecated ранее в Шаге 0)

**Не добавлено (несмотря на план в первом чекпоинте):**
- Фильтры в истории — отложено
- Drag-n-drop результатов обратно в форму — отложено
- Keyboard shortcuts — отложено
- Persistent prompt state — отложено
- Proxy HEAD для WaveSpeed — отложено, пока не понадобилось
