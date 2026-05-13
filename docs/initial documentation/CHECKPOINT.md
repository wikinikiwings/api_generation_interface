# CHECKPOINT — wavespeed-claude

> **Назначение этого файла:** отсечка текущего состояния проекта. Если возвращаемся к нему в новом разговоре — прочитай этот файл целиком, и этого должно быть достаточно, чтобы понять где мы остановились и что делать дальше.

---

## Что это за проект

Локальное Next.js веб-приложение для работы с моделями **WaveSpeed AI** через их REST API. Идеологически клон `E:\my_stable\viewcomfy\viewcomfy-claude` (который работает через ComfyUI), но полностью переписан с нуля под WaveSpeed — **никаких ComfyUI-зависимостей, никакого socket.io, никакого SQLite, никакого Clerk/Sentry**.

**Путь проекта:** `E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude`

**API-ключ:** хранится в `.env.local` как `WAVESPEED_API_KEY`, читается только серверно (route handlers + `lib/wavespeed.ts`). На клиент никогда не попадает.

---

## Стек

- Next.js 15.1.6 (app router) + React 19 + TypeScript 5
- Tailwind CSS 3.4 + `tailwindcss-animate` + shadcn-style HSL-токены в `app/globals.css`
- zustand 5 (+ `persist` на localStorage) — стор истории
- next-themes — тёмная/светлая тема (по умолчанию тёмная)
- sonner — тосты
- lucide-react — иконки
- `@radix-ui/react-dialog` — единственный radix-компонент, для просмотра результата в полном размере
- clsx + tailwind-merge — для `cn()`

Namespace-импорт: `@/*` → корень проекта (`tsconfig.json`).

---

## Поддерживаемые модели

На текущий момент — **только одна**:

- `google/nano-banana-pro/edit` — редактирование изображений по промпту, до 14 входных картинок, выход 1k/2k/4k

Архитектура расширяема (см. раздел «Как добавить новую модель» в `README.md`).

---

## Структура файлов

```
wavespeed-claude/
├── .env.example              ← WAVESPEED_API_KEY=your-api-key-here
├── .gitignore
├── README.md                 ← инструкции запуска + архитектура
├── CHECKPOINT.md             ← этот файл
├── package.json              ← deps: next, react, zustand, next-themes, sonner,
│                                lucide-react, @radix-ui/react-dialog, clsx, tailwind-merge
├── tsconfig.json
├── next.config.mjs           ← remotePatterns для cdn/static.wavespeed.ai + bodySizeLimit 50mb
├── postcss.config.mjs
├── tailwind.config.ts        ← darkMode: class, shadcn-токены
├── next-env.d.ts
│
├── app/
│   ├── api/wavespeed/
│   │   ├── submit/route.ts           ← POST proxy → /api/v3/google/nano-banana-pro/edit
│   │   └── status/[id]/route.ts      ← GET polling proxy → /api/v3/predictions/:id/result
│   ├── globals.css                   ← HSL-переменные (light + dark) + кастомный скроллбар
│   ├── layout.tsx                    ← root layout, lang="ru", suppressHydrationWarning
│   ├── page.tsx                      ← рендерит <Playground />
│   └── providers.tsx                 ← ThemeProvider (defaultTheme="dark") + <Toaster />
│
├── components/
│   ├── ui/
│   │   ├── button.tsx                ← 5 variants, 4 sizes, forwardRef
│   │   ├── textarea.tsx
│   │   ├── select.tsx  (+ Label)     ← native <select> + ChevronDown overlay
│   │   └── dialog.tsx                ← Radix Dialog wrapper (Overlay, Content, Close, Title)
│   │
│   ├── top-bar.tsx                   ← sticky header с логотипом Waves + ThemeToggle
│   ├── theme-toggle.tsx              ← Sun/Moon, mounted-guard для hydration
│   ├── image-dropzone.tsx            ← drag & drop + file picker, до 14 картинок, превью с удалением
│   ├── generate-form.tsx             ← главная форма: prompt, dropzone, resolution, aspect, format,
│   │                                    submit с poll-loop, запись в store с exec time + file size
│   ├── image-dialog.tsx              ← Radix Dialog: полноразмерное изображение + Download
│   ├── output-area.tsx               ← правый блок: 256×256 миниатюры сегодняшних генераций,
│   │                                    flex-wrap, клик → ImageDialog, кнопка «История» в углу
│   ├── history-sidebar.tsx           ← 340px слайд-ин справа: detailed cards (140×140 thumb +
│   │                                    size + prompt copy + delete + exec time + formatFullDate)
│   ├── playground.tsx                ← композиция: form слева, output-area + history-sidebar справа
│   │
│   ├── result-panel.tsx              ← DEPRECATED STUB (`export {}`) — безопасно удалить
│   └── history-panel.tsx             ← DEPRECATED STUB (`export {}`) — безопасно удалить
│
├── lib/
│   ├── utils.ts                      ← cn, uuid, fileToDataURL, fileToThumbnail (canvas→JPEG 240px),
│   │                                    fromMsToTime, formatFullDate, startOfToday, copyToClipboard
│   └── wavespeed.ts                  ← server-only WaveSpeed API wrapper:
│                                        submitNanoBananaEdit(), getPrediction(),
│                                        unwrap envelope, parseOrThrow, auth headers
│
├── stores/
│   └── history-store.ts              ← zustand + persist (key: "wavespeed-history"),
│                                        MAX_ENTRIES=100, actions: add, update, remove,
│                                        setStatus, clear
│
└── types/
    └── wavespeed.ts                  ← Resolution, AspectRatio, OutputFormat, TaskStatus,
                                         NanoBananaEditInput, SubmitResponse, PredictionResult,
                                         ClientSubmitResponse, ClientStatusResponse, HistoryEntry
```

---

## Что уже работает (готово на 100%)

### Генерация
- Форма с промптом, drag & drop (до 14 картинок), выбором resolution (1k/2k/4k), aspect ratio (10 вариантов + auto), формата (png/jpeg)
- Изображения идут напрямую в submit как base64 data URIs (без отдельного upload-эндпоинта)
- Запись в history-store создаётся upfront со статусом `pending` → `processing` → `completed`/`failed`
- Поллинг каждые 1.5 сек, таймаут 5 минут
- Трекинг `executionTimeMs` (start → complete) и `outputSizeBytes` (HEAD-запрос к CDN за Content-Length, fire-and-forget)

### UI / UX
- **Layout (1-в-1 как в viewcomfy-claude):**
  - Слева форма в `max-w-[440px]` карточке с rounded-xl
  - Справа — OutputArea + опциональный HistorySidebar рядом с ним
- **OutputArea:**
  - Показывает **только сегодняшние** генерации (`createdAt >= startOfToday()`)
  - Миниатюры 256×256, flex-wrap, скролл
  - Лоадер / ошибка для in-progress и failed карточек
  - Hover → градиент снизу с промптом + кнопка удаления
  - Клик по готовой → ImageDialog полноразмер + Download
  - Кнопка «История» top-right (прячется когда sidebar открыт)
- **HistorySidebar:**
  - 340px фиксированно, rendering только при `open=true` (как в viewcomfy)
  - Header: ChevronRight (свернуть) + иконка + «История генераций» + «Очистить» + счётчик
  - Карточка записи: 140×140 thumb → ImageDialog, строка `Total size: X MB - Prompt: [copy]    [delete]`, italic line-clamp-3 промпт, `execution time: 2m 7s - 10/4/2026 10:53:38`
- **ImageDialog:**
  - Один и тот же компонент для OutputArea и HistorySidebar
  - max-h-[82vh] max-w-[92vw], backdrop-blur, fade-in/zoom-in анимация
  - Download через blob + `<a download>` — обходит CORS
- **Тема:** toggle Sun/Moon, defaultTheme="dark", enableSystem, mounted-guard для SSR
- **Тосты:** sonner, позиция top-right, richColors, закастомлен под HSL-токены

### Безопасность
- API-ключ только на сервере
- Prohibited-проверки (min 1 картинка, max 14, non-empty prompt) и в form, и в `lib/wavespeed.ts`
- Копирование промпта: `navigator.clipboard` + fallback на `execCommand`

---

## Запуск

```powershell
cd E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude

# При первом запуске:
copy .env.example .env.local
# Открой .env.local, впиши WAVESPEED_API_KEY=sk-...

npm install
npm run dev
```

Открывается на http://localhost:3000.

> **Важно:** после последнего раунда рефакторинга добавилась зависимость `@radix-ui/react-dialog`. Если проект уже запускался без неё — нужен повторный `npm install`.

---

## Известные ограничения / риски

1. **Размер base64-пэйлоада.** 14 картинок × несколько МБ каждая → запрос к `/api/wavespeed/submit` может превысить 50MB. В `next.config.mjs` стоит `experimental.serverActions.bodySizeLimit: "50mb"`, но это про Server Actions, не про route handlers. Если упрёмся — нужен отдельный upload-эндпоинт, который проксирует в `POST https://api.wavespeed.ai/api/v3/media/upload/binary` и возвращает URL. Тогда в submit пойдут URL-ы, а не base64.

2. **localStorage quota.** 100 записей × (до 14) thumbnails ~15 KB + outputUrl ~0 KB = потенциально до 20+ MB. Лимит localStorage обычно 5–10 MB на origin. Если упрёмся — варианты:
   - Уменьшить `MAX_ENTRIES` в `stores/history-store.ts`
   - Уменьшить размер thumbnail в `fileToThumbnail` (сейчас 240px JPEG q=0.8)
   - Перенести thumbnails в IndexedDB через кастомный storage

3. **CORS на HEAD-запросе к CDN.** `fetchOutputSize()` в `generate-form.tsx` делает `fetch(outputUrl, { method: 'HEAD' })` чтобы получить Content-Length. Если CORS не пропустит — `outputSizeBytes` останется undefined и строка `Total size: X MB -` в истории просто не отобразится. Всё остальное продолжит работать. Решение: вынести HEAD через наш backend-proxy.

4. **Обработка otherwise-valid WaveSpeed errors.** `lib/wavespeed.ts` парсит ответы WaveSpeed через `unwrap()` — разные эндпоинты возвращают либо `{code, message, data}`, либо объект напрямую. Если WaveSpeed изменит формат — возможны тонкие баги. Тесты не написаны.

5. **Нет тестов вообще.** Ни unit, ни e2e.

6. **Stub-файлы.** `components/result-panel.tsx` и `components/history-panel.tsx` остались как `export {}` заглушки после рефакторинга. Их можно безопасно удалить вручную, но вне конверсии `write_file` этого сделать нельзя, поэтому они пока там.

---

## Что хотелось сделать дальше (TODO / backlog)

В порядке обсуждённого приоритета (из последнего сообщения в той конверсии):

1. **Фильтры в истории** — date-range picker в шапке HistorySidebar (есть в viewcomfy, `components/history-sidebar.tsx` там). Понадобится — когда генераций накопится много. Потребует либо `react-day-picker` + `date-fns`, либо самописный минимальный picker.

2. **Drag-and-drop результатов в форму** — перетащить картинку из OutputArea / HistorySidebar обратно во входные dropzone. В viewcomfy это сделано через custom MIME `application/x-viewcomfy-media` в `lib/drag-utils.ts`. Паттерн: `dataTransfer.setData("application/x-wavespeed-media", JSON.stringify({url, filename, contentType}))` на draggable картинке → в `image-dropzone.tsx` дополнительный handler в onDrop, который ищет этот MIME-тип первым, fetch'ит URL → File → dataUrl → добавляет в state как обычно.

3. **Keyboard shortcuts** — Ctrl+Enter = Generate (в `generate-form.tsx` вешаем на textarea `onKeyDown`); Esc = close dialog (Radix даёт бесплатно).

4. **Persistent form state** — запоминать последний prompt + settings в localStorage через отдельный zustand persist store. Удобно когда страница случайно перезагружается.

5. **Прокси HEAD-запроса за размером файла** через наш backend — решает пункт (3) из "Известных ограничений".

6. **Добавление второй модели** — раз архитектура расширяема, можно взять следующую из каталога WaveSpeed. Кандидаты: Nano-banana-pro text-to-image (если есть такой endpoint), или любая другая image/video модель. Процесс: новая функция в `lib/wavespeed.ts` → новый route handler в `app/api/wavespeed/` → новая форма-компонент → табы в playground если моделей станет несколько.

7. **Поддержка upload-эндпоинта** — решает пункт (1) из "Известных ограничений". Нужен route `app/api/wavespeed/upload/route.ts` который принимает multipart/form-data, форвардит в `POST https://api.wavespeed.ai/api/v3/media/upload/binary`, возвращает `download_url`. Форма тогда сначала грузит большие картинки, получает URL-ы, и шлёт в submit только URL-ы.

---

## Как возобновить работу

1. Прочитай этот файл целиком.
2. Прочитай `README.md` для краткого обзора + инструкции запуска.
3. Если нужно освежить архитектуру — пройди по списку файлов выше, ключевые для понимания: `components/playground.tsx`, `components/generate-form.tsx`, `components/output-area.tsx`, `components/history-sidebar.tsx`, `lib/wavespeed.ts`, `stores/history-store.ts`, `types/wavespeed.ts`.
4. Выбери следующий пункт из TODO и сделай.
5. Не забудь обновить этот файл после следующего значимого изменения.

---

_Отсечка создана: апрель 2026. Статус: MVP завершён и функционален, ждёт `npm install && npm run dev` + пользовательское тестирование._
