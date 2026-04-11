# WaveSpeed Claude

Локальное веб-приложение для работы с моделями WaveSpeed AI — вдохновлено `viewcomfy-claude`, но работает напрямую через REST API WaveSpeed, без ComfyUI.

## Поддерживаемые модели

- ✅ **Google Nano-banana-pro Edit** (`google/nano-banana-pro/edit`) — редактирование изображений по промпту, до 14 входных картинок, вывод до 4K

Дальше будут добавлены text-to-image, video и другие модели WaveSpeed.

## Фичи MVP

- 🎨 Playground с промптом, выбором resolution (1k/2k/4k), aspect ratio и формата вывода
- 📥 Drag & drop загрузка нескольких изображений (до 14)
- 🖼️ Превью входных картинок с возможностью удалить
- 📜 История генераций (хранится в localStorage браузера)
- 🌓 Переключатель тёмной/светлой темы
- ⬇️ Скачивание результата в один клик
- 🔒 API-ключ хранится серверно в `.env.local`, клиент его не видит

## Стек

- **Next.js 15** (app router) + **React 19** + **TypeScript**
- **Tailwind CSS 3.4** + дизайн-токены в духе shadcn/ui
- **zustand** (с `persist`) — стор истории генераций
- **next-themes** — тема
- **sonner** — тосты
- **lucide-react** — иконки

## Запуск

### 1. Установить зависимости

```bash
cd wavespeed-claude
npm install
```

### 2. Настроить API-ключ

Скопируй `.env.example` в `.env.local` и добавь свой ключ:

```bash
cp .env.example .env.local
```

Открой `.env.local` и подставь свой ключ от https://wavespeed.ai/accesskey:

```
WAVESPEED_API_KEY=sk-...твой_ключ...
```

### 3. Запустить dev-сервер

```bash
npm run dev
```

Открой http://localhost:3000

## Архитектура

```
wavespeed-claude/
├── app/
│   ├── api/wavespeed/
│   │   ├── submit/route.ts       # POST → создаёт задачу в WaveSpeed
│   │   └── status/[id]/route.ts  # GET  → polling статуса + результата
│   ├── layout.tsx
│   ├── page.tsx                  # главный экран (playground)
│   ├── providers.tsx             # theme + toaster
│   └── globals.css
├── components/
│   ├── ui/                       # базовые UI-примитивы
│   ├── top-bar.tsx
│   ├── playground.tsx            # композиция главного экрана
│   ├── generate-form.tsx         # форма с промптом и настройками
│   ├── image-dropzone.tsx        # drag & drop для входных картинок
│   ├── result-panel.tsx          # отображение результата
│   ├── history-panel.tsx         # галерея прошлых генераций
│   └── theme-toggle.tsx
├── lib/
│   ├── wavespeed.ts              # серверный wrapper над WaveSpeed API
│   └── utils.ts                  # cn() helper
├── stores/
│   └── history-store.ts          # zustand + localStorage persist
└── types/
    └── wavespeed.ts              # типы запросов/ответов
```

### Поток генерации

```
[Browser]                              [Next.js API]              [WaveSpeed]
   │                                         │                         │
   │─ prompt + images (base64 data URI) ────▶│                         │
   │                                         │── POST /edit ──────────▶│
   │                                         │◀── { id, status } ──────│
   │◀── { id } ──────────────────────────────│                         │
   │                                         │                         │
   │─ GET /status/:id ──────────────────────▶│── GET /predictions ────▶│
   │                                         │◀── { status, outputs }──│
   │◀── { status, outputs } ─────────────────│                         │
   │                                         │                         │
   │  (polling every 1.5s until completed)   │                         │
```

API-ключ WaveSpeed никогда не покидает сервер — клиент общается только с `/api/wavespeed/*`.

## Добавление новых моделей

В `lib/wavespeed.ts` добавь новый метод (например `textToImage`), создай соответствующий route handler в `app/api/wavespeed/` и новую форму-компонент. Структура уже расширяема.
