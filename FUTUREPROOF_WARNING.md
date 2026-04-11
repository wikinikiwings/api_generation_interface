# FUTUREPROOF_WARNING.md

> **Для будущего Claude (или человека-разработчика):** этот файл — диагностический справочник на случай когда генерации перестали работать. Читай сверху вниз. Каждая секция = один потенциальный источник поломки + что проверять + как чинить.
>
> **Не паникуй и не переписывай провайдер с нуля.** Скорее всего сломалось что-то одно конкретное, и фикс — 5-30 строк. Сначала локализуй.

---

## 📋 Универсальный чеклист первой реакции

Когда юзер говорит "ничего не генерится" — **по порядку**:

1. **Какой провайдер сломался?** Спроси юзера или попроси проверить во всех трёх (WaveSpeed / Fal / Comfy API). Если все три — проблема в нашем коде или в Next.js, не в провайдерах. Если один — провайдер сломался.
2. **Воспроизведи минимальным запросом.** Промпт "test", без картинок, разрешение 1K, провайдер X. Если работает — проблема в специфике кейса юзера (большие картинки, edit-режим, etc).
3. **Смотри логи `npm run dev`** в терминале. У нас везде есть `console.error("[<provider>] ...")` префиксы — Ctrl+F по `[wavespeed]`, `[fal]`, `[comfy provider]` найдёт их.
4. **Смотри вкладку Network в браузере.** Запрос `/api/generate/submit` → response status и body. Это самое первое место где видна ошибка.
5. **Не трогай ничего пока не понял что именно сломано.** Любая правка "наугад" множит количество переменных.

---

## 🟥 Comfy провайдер — самый хрупкий

**Почему хрупкий:** мы НЕ запускаем ComfyUI. Мы напрямую POST'им в `https://api.comfy.org/proxy/vertexai/gemini/...` — это **внутренний прокси** Comfy, не публичный API. Comfy ничего не обязаны держать стабильным. См. `lib/providers/comfy.ts` целиком.

### Симптомы поломки и что они значат

| Симптом | Вероятная причина |
|---|---|
| `401 Unauthorized: Please login first` | API-ключ невалидный, истёк, или Comfy сменил формат заголовка `X-API-KEY` |
| `402 Payment Required` | Закончились кредиты на платформе. Это не баг, юзеру нужно пополнить |
| `429 Rate Limit Exceeded` | Слишком много параллельных запросов. Не баг, нужно подождать или добавить retry-on-429 |
| `409 / "contact support"` | Проблема на их стороне с аккаунтом |
| `503 Service Unavailable` | Прокси временно лежит. У нас уже есть **retry-on-5xx** (см. `postGeminiWithRetry`), должно переотправить через 5с/15с. Если после 3 попыток всё ещё 503 — реально лежит, ждать |
| `Gemini did not generate an image` или `Could not extract image from response` | **Формат ответа Gemini изменился.** Самый частый сценарий поломки. См. ниже |
| Запрос тупо висит 5 минут и падает по `maxDuration` | Прокси принял запрос но не вернул ответ. Возможно изменили endpoint и POST идёт "в никуда". См. ниже |
| `400 Bad Request` с упоминанием полей `imageConfig` / `responseModalities` / `generationConfig` | **Они переименовали поля в payload.** См. ниже |

### Где искать актуальную правду — `clean_comfy/`

Главный источник для reverse engineering лежит в:
```
E:\my_stable\viewcomfy\clean_comfy\comfy_api_nodes\
```

**Файлы которые надо проверить (по убыванию важности):**

1. **`nodes_gemini.py`** — там класс `GeminiImage2.execute()`. Это эталон того что должен делать наш TypeScript-код. Конкретно смотри:
   - Функцию `create_image_parts(cls, images)` — она строит `parts` массив с гибридной стратегией upload (первые 10 через storage, остальные inline). У нас её эквивалент — `buildImageParts` в `lib/providers/comfy.ts`. **Если у них появились новые поля в `GeminiPart` — портируем.**
   - Функцию `get_image_from_response(response)` — парсит выходную картинку из ответа. Может вернуть либо из `inlineData.data`, либо из `fileData.fileUri`. У нас эквивалент — `extractOutputImages`. **Если они начали возвращать картинку в новом поле — добавляем третью ветку парсинга.**
   - Константу `GEMINI_BASE_ENDPOINT` — должна быть `"/proxy/vertexai/gemini"`. Если поменялась — меняем `GEMINI_ENDPOINT` в нашем `comfy.ts`.

2. **`apis/gemini.py`** — Pydantic-модели запроса и ответа:
   - `GeminiImageGenerateContentRequest` — структура body
   - `GeminiGenerateContentResponse` — структура ответа
   - `GeminiPart`, `GeminiInlineData`, `GeminiFileData`
   - `GeminiImageConfig`, `GeminiImageOutputOptions`
   - **Если какое-то поле переименовали или сделали required** — обновляем наш TypeScript-эквивалент в `comfy.ts`.

3. **`util/_helpers.py`** — критично важная константа:
   - `default_base_url()` должна возвращать `"https://api.comfy.org"`
   - `get_auth_header()` должна возвращать `{"X-API-KEY": api_key_comfy_org}` — **именно `X-API-KEY` ВСЕМИ ЗАГЛАВНЫМИ**, не `x-api-key`. Если они начали использовать другой заголовок (например `Authorization: Bearer`) — меняем `headers` в `comfy.ts`.

4. **`util/upload_helpers.py`** — двух-шаговый upload через `/customers/storage`:
   - `UploadRequest{file_name, content_type}` → POST `/customers/storage` → `{upload_url, download_url}`
   - PUT на `upload_url` с raw bytes
   - У нас это `uploadImageToStorage` в `comfy.ts`. **Если они поменяли endpoint storage или формат `UploadRequest`** — обновляем.

5. **`util/client.py`** — retry policy:
   - `_RETRY_STATUS = {408, 500, 502, 503, 504}` — у нас это в `postGeminiWithRetry`. Сверь.

### Конкретные диагностические команды для Comfy

**A. Проверить что ключ ещё валидный**

В терминале (PowerShell):
```powershell
curl -X POST https://api.comfy.org/proxy/vertexai/gemini/gemini-3-pro-image-preview `
  -H "X-API-KEY: $env:COMFY_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{\"contents\":[{\"role\":\"user\",\"parts\":[{\"text\":\"a red apple\"}]}],\"generationConfig\":{\"responseModalities\":[\"IMAGE\"],\"imageConfig\":{\"imageSize\":\"1K\",\"imageOutputOptions\":{\"mimeType\":\"image/png\"}}},\"uploadImagesToStorage\":true}'
```

- Если 200 + JSON с `candidates[0].content.parts[0].inlineData` или `fileData` → API работает, проблема в нашем коде
- Если 401 → ключ невалидный
- Если 4xx с описанием поля → они сменили схему, читай `nodes_gemini.py`
- Если timeout → endpoint поменялся или прокси лежит

**B. Сравнить наш payload с эталонным**

Открой `lib/providers/comfy.ts`, найди функцию `buildPayload`. Сравни ключ-в-ключ с тем что строит `GeminiImage2.execute()` в `nodes_gemini.py`. Особое внимание:
- `imageSize` должен быть `"1K"` / `"2K"` / `"4K"` — заглавными
- `responseModalities` должен быть массивом `["IMAGE"]`
- `mimeType` всегда `"image/png"`
- `uploadImagesToStorage: true` — мимикрия Pydantic default
- `systemInstruction` — мы НАМЕРЕННО не передаём (избегаем агрессивный дефолтный prompt от ComfyUI)

**C. Проверить парсинг ответа**

В `lib/providers/comfy.ts` функция `extractOutputImages` логирует через `console.error` структуру ответа когда не находит картинку. Этот лог — твой друг. Пример того что должен возвращать прокси:

```json
{
  "candidates": [{
    "content": {
      "role": "model",
      "parts": [
        { "inlineData": { "mimeType": "image/png", "data": "<base64>" } }
      ]
    },
    "finishReason": "STOP"
  }]
}
```

ИЛИ:

```json
{
  "candidates": [{
    "content": {
      "parts": [
        { "fileData": { "mimeType": "image/png", "fileUri": "<https url>" } }
      ]
    }
  }]
}
```

Если форма другая — добавляем третью ветку в `extractOutputImages`. **Не удаляй существующие две ветки** — Comfy может вернуться к старому формату для разных моделей.

### Risk: ToS comfy.org — серая зона

Мы технически обходим их intended use case (они продают Gemini как фичу **внутри** ComfyUI). Если в один день они добавят:
- Origin-проверку
- User-Agent whitelist
- Подпись запроса со стороны ComfyUI клиента
- Rate-limit на не-ComfyUI запросы

— наш direct call перестанет работать. **Если Comfy провайдер вдруг возвращает 403/401 хотя ключ валидный — это оно.** Чинить нельзя, можно только переехать на запуск настоящего ComfyUI рядом с приложением (есть `lib/providers/comfy.ts.bak` если он сохранился — там был attempt 3B с локальным ComfyUI на 127.0.0.1:8188).

---

## 🟨 WaveSpeed провайдер

**Файл:** `lib/providers/wavespeed.ts`. Async-паттерн (submit → polling).

### Симптомы и причины

| Симптом | Причина |
|---|---|
| 401 / 403 | Ключ `WAVESPEED_API_KEY` в `.env.local` невалиден |
| 429 | Rate limit. У нас сейчас НЕТ retry-on-429. TODO: добавить если станет проблемой |
| `Task stuck in pending forever` | Polling работает но статус не меняется. Возможно изменился формат `/result` endpoint |
| `Cannot read property 'urls' of undefined` или подобное | Они изменили формат ответа `/result` |

### Где искать правду

WaveSpeed имеет **публичную доку**, в отличие от Comfy:
- https://wavespeed.ai/docs (общее)
- https://wavespeed.ai/models/google/nano-banana-pro (конкретная модель)
- https://wavespeed.ai/models/google/nano-banana-pro/edit (edit-режим)

Если что-то сломалось — открыть свежую доку, сравнить с тем что строит `submit` и `getStatus` в `wavespeed.ts`.

### Ключевые места кода для проверки

```typescript
// lib/providers/wavespeed.ts
const url = hasImages
  ? `${getBase()}/api/v3/google/nano-banana-pro/edit`
  : `${getBase()}/api/v3/google/nano-banana-pro/text-to-image`;
```

Если они поменяют URL — меняем тут. Если появится новая модель с другим slug — см. план мульти-моделей в `CHECKPOINT-v3.md`.

---

## 🟨 Fal провайдер

**Файл:** `lib/providers/fal.ts`. Sync-паттерн (POST блокируется до результата).

### Симптомы и причины

| Симптом | Причина |
|---|---|
| 401 | `FAL_KEY` невалиден или не в формате `<key-id>:<secret>` |
| 422 | Они изменили схему body. Скорее всего переименовали `image_urls` или `prompt` |
| Зависание дольше 5 минут | Запрос принят но Fal не вернул ответ. Их queue лежит |

### Где искать правду

Fal имеет публичную доку:
- https://fal.ai/models/fal-ai/nano-banana-pro (t2i)
- https://fal.ai/models/fal-ai/nano-banana-pro/edit

**Важная особенность:** для t2i URL **бесслешевый** (`fal-ai/nano-banana-pro` без суффикса), для edit — `fal-ai/nano-banana-pro/edit`. Это **не опечатка**, это их паттерн именования.

```typescript
const FAL_T2I_ENDPOINT = "https://fal.run/fal-ai/nano-banana-pro";       // без /edit
const FAL_EDIT_ENDPOINT = "https://fal.run/fal-ai/nano-banana-pro/edit";  // с /edit
```

---

## 🟦 Общие проблемы (не специфичные для провайдеров)

### "Все три провайдера сразу перестали работать"

Это почти всегда означает что **что-то сломалось в Next.js слое**, а не в провайдерах. Проверь:

1. **Dev-сервер запущен?** `npm run dev` в правильной директории `wavespeed-claude/`
2. **На каком порту?** Если viewcomfy-claude занял :3000, мы поедем на :3001. Юзер должен ходить по правильному URL.
3. **`.env.local` есть и в нём все три ключа + ничего не закомментировано?**
4. **`npm install` после `git pull`?** Если кто-то добавил зависимость и не сказал.
5. **Node.js версия >=18?** Иначе `fetch`/`FormData`/`Blob` нативно не работают.

### "Generate жмётся но ничего не происходит"

1. Открой DevTools → Network tab
2. Жми Generate
3. Должен появиться запрос `POST /api/generate/submit`
4. **Если запроса нет** — проблема в фронтенде, в `components/generate-form.tsx`. Скорее всего кнопка `disabled` потому что `isGenerating === true` от предыдущего запроса который зависся
5. **Если запрос есть со статусом 4xx/5xx** — открой response, там JSON с `error`
6. **Если запрос pending больше минуты** — провайдер не отвечает, см. соответствующую секцию выше

### "История не показывается"

1. **Юзер ввёл ник?** Без ника не показывается ничего. Cookie `viewcomfy_username`.
2. **GET `/api/history?username=X` возвращает что-то?** Открой URL руками в браузере на правильном порту.
3. **`HISTORY_DATA_DIR` указывает на правильное место?** Проверь `.env.local`. По умолчанию — `./data` в корне `wavespeed-claude`.
4. **Картинки не отображаются хотя записи есть?** Значит файлы на диске не там где их ищет `/api/history/image/[filename]`. Проверь содержимое `$HISTORY_DATA_DIR/history_images/`.
5. **`SqliteError: database is locked`** — параллельно работает viewcomfy-claude и держит writer-lock. Останови один из инстансов.

---

## 🛠 Что НЕ менять без острой нужды

Несколько мест в коде где есть "магические значения" — они магические потому что выстраданы reverse engineering'ом. Не "оптимизируй" их без понимания:

1. **`uploadImagesToStorage: true` в `comfy.ts`** — даже если кажется ненужным. См. CHECKPOINT-v3 раздел "Known risks".
2. **Гибридная стратегия первые-10-через-storage-остальные-inline в `buildImageParts`** — это копия `create_image_parts` из ComfyUI. Vertex AI имеет лимит 10 file URIs.
3. **`X-API-KEY` ВСЕМИ ЗАГЛАВНЫМИ** в headers Comfy запроса. `x-api-key` строчными — не работает.
4. **`imageSize: "2K"` ЗАГЛАВНЫМИ.** Не `2k`.
5. **Salted SHA-256 cookie hash в админке** — `wavespeed-admin-v1:` префикс. Не "упрощай" до plain SHA-256, иначе сессии станут переносимыми между разными приложениями использующими тот же пароль.
6. **`HISTORY_DATA_DIR` env var fallback на `./data`** — не делай required. Должно работать out-of-the-box без env var в dev.
7. **Схема SQLite таблиц `generations` + `generation_outputs`** — НЕ менять. Шарится с viewcomfy-claude. Любое изменение колонок сломает совместимость.

---

## 📚 Связанные документы

- `CHECKPOINT-v3.md` — **полное** описание Comfy reverse engineering, две страницы про known risks. **Читай первым** если ломается Comfy.
- `CHECKPOINT-v4.md` — состояние проекта на момент админки + UI рефактора + начала multi-user порта.
- `clean_comfy/comfy_api_nodes/` — исходники ComfyUI как ground truth для Comfy API.

---

## 🚨 Production deployment checklist — ОБЯЗАТЕЛЬНО перед публичным деплоем

Когда контейнеризуешь приложение и выставляешь его в интернет, **админка не должна быть доступна снаружи**. Это требует ДВУХ слоёв защиты.

### Слой 1: `ADMIN_PASSWORD` env var (приложение)

В env контейнера обязательно установи:
```
ADMIN_PASSWORD=<длинный-случайный-пароль>
```

**Без этого в production режиме админка вернёт 503** (это намеренно — лучше упасть чем оставить открытой). Проверка:
- Зайди в браузере на `https://your-domain.com/admin` без cookie
- Должен быть редирект на `/admin/login`
- Без правильного пароля — не пройти

### Слой 2: Caddy/nginx блокировка по path + IP (reverse proxy)

**Это критично.** Даже с паролем — выставлять `/admin` в публичный интернет = постоянные попытки брутфорса в логах + риск 0-day в Next.js middleware. Решение: блокировать на уровне proxy чтобы `/admin` снаружи возвращал **404** (как будто страницы не существует).

**Caddy пример** (рекомендуемый):
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

`private_ranges` — встроенный matcher Caddy, включает `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`. Из LAN админка работает, из интернета → 404.

**Альтернативы:**
- Конкретные IP: `not client_ip 203.0.113.42 198.51.100.0/24`
- Tailscale only: `not client_ip 100.64.0.0/10`
- SSH-туннель only: `not client_ip 127.0.0.1`

**nginx эквивалент** — см. оригинальное обсуждение или CHECKPOINT-v4.

### Проверка после деплоя

Обязательно с **внешнего** хоста (не из LAN, не через VPN):
```bash
curl -I https://your-domain.com/admin
# Ожидаем: HTTP/2 404

curl -I https://your-domain.com/api/admin/login
# Ожидаем: HTTP/2 404

curl -I https://your-domain.com/
# Ожидаем: HTTP/2 200 (главная страница доступна)
```

Если `/admin` вернул что угодно кроме 404 (даже 401 или 403) — **Caddy не работает как ожидается**, разбираться немедленно.

### Чеклист deployment

- [ ] `ADMIN_PASSWORD` установлен в env контейнера (не в commit-нутый `.env.example`!)
- [ ] `HISTORY_DATA_DIR` указывает на смонтированный volume с боевой БД
- [ ] Caddyfile/nginx.conf содержит блокировку `/admin` + `/api/admin` для не-private IP
- [ ] Reverse proxy перезагружен после правки конфига (`caddy reload` или `nginx -s reload`)
- [ ] Curl с внешнего хоста на `/admin` возвращает 404
- [ ] Curl с внешнего хоста на `/` возвращает 200
- [ ] Curl изнутри LAN на `/admin` возвращает 200 или редирект на login
- [ ] HTTPS сертификат валиден (Caddy это делает автоматически через Let's Encrypt)
- [ ] Все три API ключа (`WAVESPEED_API_KEY`, `FAL_KEY`, `COMFY_API_KEY`) — production значения, не dev

---

## 🎯 Финальное правило

**Если не уверен — спроси юзера, не угадывай.** Лучше задать вопрос "у тебя сломался X или Y?" чем переписать пол-провайдера и сломать ещё сильнее. Минимальный воспроизводимый кейс + чтение логов + сравнение с эталонным источником (доки или `clean_comfy`) — почти всегда хватает.
