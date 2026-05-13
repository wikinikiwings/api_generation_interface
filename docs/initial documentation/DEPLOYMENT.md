# DEPLOYMENT.md — wavespeed-claude

> Инструкция по деплою wavespeed-claude в production, в первую очередь — за reverse proxy (Caddy/nginx) с защищённой админкой и mounted volume для истории.

---

## TL;DR архитектура

```
Internet
   ↓
[Caddy/nginx]  ← TLS termination + path/IP filtering
   ↓
[wavespeed-claude container]  ← Next.js на :3000
   ↓
[volume mount: /data]  ← SQLite + history_images
```

**Ключевые принципы:**
- Один контейнер, один порт (3000)
- `/admin` и `/api/admin` блокируются reverse proxy для не-LAN запросов → возвращают 404 (не 403 для obscurity)
- ADMIN_PASSWORD как второй слой защиты на уровне приложения
- БД и картинки на host-volume, контейнер stateless

---

## Переменные окружения для production

```env
# API ключи провайдеров (обязательно хотя бы один)
WAVESPEED_API_KEY=f760f040...
FAL_KEY=7d6c630d-...
COMFY_API_KEY=comfyui-3f48fb3a...

# Админка — ОБЯЗАТЕЛЬНО в production
ADMIN_PASSWORD=длинный-уникальный-пароль

# История — путь внутри контейнера, должен совпадать с volume mount
HISTORY_DATA_DIR=/data

# Next.js
NODE_ENV=production
```

**⚠️ Без `ADMIN_PASSWORD` в production** middleware вернёт 503 на `/admin/*`. Это намеренно.

**⚠️ Без `HISTORY_DATA_DIR`** код будет писать в `./data` внутри контейнера, что потеряется при пересоздании контейнера.

---

## Caddy — рекомендуемый вариант

### Базовый Caddyfile (LAN-only админка)

```caddyfile
example.com {
    # Блокируем /admin и /api/admin для всех кроме приватных сетей
    # private_ranges — встроенный matcher Caddy:
    #   127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
    @adminFromWeb {
        path /admin /admin/* /api/admin/*
        not client_ip private_ranges
    }
    respond @adminFromWeb 404

    # Всё остальное проксируем на контейнер
    reverse_proxy localhost:3000
}
```

**Что получается:**
- `https://example.com/` → главная страница, всем доступна
- `https://example.com/api/generate/*` → нормальная работа генераций
- `https://example.com/admin` → **404** для интернет-юзеров, работает только из LAN
- TLS автоматически от Let's Encrypt (Caddy делает это сам)

### Альтернатива 1 — конкретные IP вместо LAN

Если нужно дать доступ с конкретного публичного IP (например домашний или офисный):

```caddyfile
example.com {
    @adminFromWeb {
        path /admin /admin/* /api/admin/*
        not client_ip 203.0.113.42 198.51.100.0/24 127.0.0.1
    }
    respond @adminFromWeb 404
    reverse_proxy localhost:3000
}
```

Замени `203.0.113.42` на свой IP, `198.51.100.0/24` на сеть офиса.

### Альтернатива 2 — через Tailscale

Если контейнер в Tailnet и админка должна быть доступна только подключённым к нему:

```caddyfile
example.com {
    @adminFromWeb {
        path /admin /admin/* /api/admin/*
        not client_ip 100.64.0.0/10
    }
    respond @adminFromWeb 404
    reverse_proxy localhost:3000
}
```

`100.64.0.0/10` — стандартный Tailscale CGNAT диапазон.

### Альтернатива 3 — полная блокировка, доступ через SSH-туннель

Самый параноидальный вариант — никто не имеет доступа к админке через интернет вообще:

```caddyfile
example.com {
    @adminFromWeb {
        path /admin /admin/* /api/admin/*
        not client_ip 127.0.0.1
    }
    respond @adminFromWeb 404
    reverse_proxy localhost:3000
}
```

Чтобы получить доступ:
```bash
ssh -L 3000:localhost:3000 user@server
# потом открываешь http://localhost:3000/admin у себя локально
```

---

## nginx — альтернатива Caddy

Если у тебя уже nginx и не хочешь добавлять Caddy:

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # Админка — только LAN
    location ~ ^/(admin|api/admin) {
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 192.168.0.0/16;
        deny all;

        # 403 → 404 для obscurity
        error_page 403 =404 /404.html;

        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Всё остальное — обычное проксирование
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Для long-running генераций
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    client_max_body_size 100M;  # для больших input картинок
}

server {
    listen 80;
    server_name example.com;
    return 301 https://$server_name$request_uri;
}
```

---

## Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  wavespeed-claude:
    image: wavespeed-claude:latest
    container_name: wavespeed-claude
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # bind только на localhost, доступ через Caddy
    environment:
      - NODE_ENV=production
      - HISTORY_DATA_DIR=/data
      - WAVESPEED_API_KEY=${WAVESPEED_API_KEY}
      - FAL_KEY=${FAL_KEY}
      - COMFY_API_KEY=${COMFY_API_KEY}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
    volumes:
      # Windows host (если деплоишь на Windows-сервере)
      - C:/viewcomfy_data/database:/data
      # Linux host (раскомментировать соответствующее)
      # - /opt/viewcomfy_data:/data
      
      # Для генерируемых файлов которые временно лежат в public/generated
      # (опционально, можно не маунтить — они эфемерные)
      - wavespeed_generated:/app/public/generated

volumes:
  wavespeed_generated:
```

`.env` файл рядом с `docker-compose.yml` (НЕ коммитить):
```env
WAVESPEED_API_KEY=...
FAL_KEY=...
COMFY_API_KEY=...
ADMIN_PASSWORD=...
```

**Важно про `127.0.0.1:3000:3000`:** контейнер слушает только localhost, не на всех интерфейсах. Это значит что без reverse proxy дотянуться до приложения извне нельзя — обязательная связка с Caddy/nginx. Дополнительный слой безопасности.

---

## Dockerfile (если ещё нет)

Пример минимального Dockerfile для wavespeed-claude:

```dockerfile
FROM node:20-alpine AS deps

# better-sqlite3 и sharp требуют build tools
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Создаём папку data на случай если volume не примаунчен
RUN mkdir -p /data && chmod 755 /data

# Standalone output (нужно включить в next.config.mjs)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
```

**Перед сборкой** убедись что в `next.config.mjs` есть:
```javascript
const nextConfig = {
  output: 'standalone',
  // ...остальное
};
```

---

## Defence in depth — все слои защиты

| Слой | Что защищает | Где настраивается |
|---|---|---|
| **1. Caddy IP filter** | `/admin` из веба → 404, доступ только из LAN/Tailscale/SSH | `Caddyfile` |
| **2. Container bind на 127.0.0.1** | Контейнер недоступен напрямую, только через прокси | `docker-compose.yml` ports |
| **3. Middleware ADMIN_PASSWORD** | Даже если прорвался к /admin — нужен пароль | `.env` |
| **4. HttpOnly + SameSite cookie** | XSS не может украсть auth cookie | `app/api/admin/login/route.ts` |
| **5. secure cookie в production** | Cookie только по HTTPS | автоматом по `NODE_ENV` |

Ни один слой не идеален отдельно. Вместе — приличная защита для персонального/командного деплоя.

---

## Чеклист первого деплоя

1. **Подготовка хоста:**
   - [ ] Docker + docker-compose установлены
   - [ ] Caddy установлен и работает (или nginx)
   - [ ] DNS A-запись `example.com` → IP сервера
   - [ ] Папка для данных создана: `mkdir -p /opt/viewcomfy_data` или эквивалент на Windows

2. **Перенос данных (если есть существующая БД):**
   - [ ] Скопировать `history.db`, `history.db-shm`, `history.db-wal`, `history_images/` в data-папку
   - [ ] Проверить права доступа (контейнер должен иметь read+write)

3. **Сборка контейнера:**
   - [ ] `next.config.mjs` имеет `output: 'standalone'`
   - [ ] `docker build -t wavespeed-claude:latest .`
   - [ ] Проверить что `better-sqlite3` и `sharp` собрались (в build логах)

4. **Конфигурация:**
   - [ ] Создать `.env` рядом с `docker-compose.yml` со всеми ключами
   - [ ] Сгенерировать длинный `ADMIN_PASSWORD` (например `openssl rand -base64 32`)
   - [ ] Положить Caddyfile с правильным `example.com` и LAN-фильтром

5. **Запуск:**
   - [ ] `docker-compose up -d`
   - [ ] `docker logs wavespeed-claude` — проверить что приложение стартануло без ошибок
   - [ ] `caddy reload` или `systemctl reload caddy`

6. **Smoke tests:**
   - [ ] `https://example.com/` → главная страница, модалка ника
   - [ ] Ввести ник → должен показать историю (если БД скопирована)
   - [ ] Сгенерировать тестовое изображение → должно сохраниться в `data/history_images/` на хосте
   - [ ] `https://example.com/admin` из интернета → **404** ✅
   - [ ] `https://example.com/admin` из LAN → форма логина → войти с ADMIN_PASSWORD → админка работает

7. **Мониторинг:**
   - [ ] `docker logs -f wavespeed-claude` для отслеживания ошибок
   - [ ] Бэкап `/opt/viewcomfy_data/history.db` по расписанию (cron + cp)

---

## Troubleshooting

| Симптом | Причина | Фикс |
|---|---|---|
| `502 Bad Gateway` от Caddy | Контейнер не запущен или упал | `docker logs wavespeed-claude` |
| `503` на `/admin` | `ADMIN_PASSWORD` не задан в production | Добавить в `.env`, перезапустить |
| `SqliteError: unable to open database file` | Volume mount неправильный или нет прав | Проверить путь в `docker-compose.yml`, права на папку |
| Картинки в истории 404 | `HISTORY_DATA_DIR` не указан или указан неверно | Проверить env, должен совпадать с mount target |
| Генерация работает но не сохраняется в историю | Юзер не ввёл ник, или папка `history_images/` read-only | Проверить cookie + права на volume |
| `/admin` доступен из интернета | Caddy не перезагружен после правки Caddyfile | `caddy reload` или `systemctl reload caddy` |
| Slow генерации, timeouts | Reverse proxy режет long requests | Для nginx — `proxy_read_timeout 300s`, для Caddy дефолтно ОК |

---

## Бэкап данных

Минимальный скрипт бэкапа (cron, ежедневно):

```bash
#!/bin/bash
# /opt/scripts/backup-wavespeed.sh

DATE=$(date +%Y%m%d)
SRC=/opt/viewcomfy_data
DST=/opt/backups/wavespeed

mkdir -p $DST

# SQLite требует специального бэкапа из-за WAL — sqlite3 .backup делает это правильно
sqlite3 $SRC/history.db ".backup $DST/history-$DATE.db"

# Картинки — обычное rsync
rsync -a --delete $SRC/history_images/ $DST/history_images/

# Чистим бэкапы старше 30 дней
find $DST -name "history-*.db" -mtime +30 -delete
```

Crontab:
```
0 3 * * * /opt/scripts/backup-wavespeed.sh
```

---

## Связанные документы

- `CHECKPOINT-v4.md` — текущее состояние проекта, статус мульти-юзер порта
- `FUTUREPROOF_WARNING.md` — что не ломать, как чинить когда сломается
- `MODEL_ADDITION.md` — план добавления новых моделей
- `.env.example` — справочник всех переменных окружения
