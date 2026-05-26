# Continuation prompt — Caddy 502 keep-alive fix

> Paste this as your first message in a fresh Claude Code session at this repo if 502s reappear, or if you want to revisit the fix.

---

## Status snapshot

Commit `0f1d946` on `main` shipped on 2026-05-25 with two independent fixes for `Upload failed: HTTP 502` toasts:

1. **`server-wrap.js`** — patches `http/https.createServer` to set Node's `keepAliveTimeout = 120s` (was 5s default) and `headersTimeout = 125s`, breaking the race with Caddy's ~120s upstream idle.
2. **DB-idempotent POST `/api/history`** (`findGenerationByOutputPath`) + **client retry on 502/503/504** in `lib/history-upload.ts`.

Full post-ship handoff at `docs/superpowers/specs/2026-05-25-caddy-502-keepalive-race-post-ship.md`. Read that first.

---

## Path A — 502s have come back

```
Vозвращаемся к Caddy 502 расследованию. После 2026-05-25 фикс (commit 0f1d946) держался — но сейчас юзеры снова видят "Upload failed: HTTP 502" / похожее.

Прочитай:
- docs/superpowers/specs/2026-05-25-caddy-502-keepalive-race-post-ship.md (полный handoff)
- memory/feedback_node_behind_proxy_keepalive.md (lesson learned)
- memory/project_caddy_502_keepalive_fix_shipped.md (что ровно деплоилось)

Прежде чем формировать новые гипотезы — проверь что фикс ВООБЩЕ применён:

1. docker exec wavespeed-claude ls -la /app/server-wrap.js   (должен существовать)
2. docker exec wavespeed-claude node -e "const h=require('node:http');const s=h.createServer((q,r)=>r.end());console.log('keepAlive:',s.keepAliveTimeout);s.close()"   (должно быть 120000)
3. git log --oneline origin/main | head -5   (commit 0f1d946 должен быть в дереве)

Если фикс не применён — деплой просто пересобирать через start.ps1 с CACHEBUST.
Если применён, но 502 всё-равно — тогда переходим к Path B.

Каков статус?
```

---

## Path B — фикс точно применён, 502 продолжаются

```
Возвращаемся к 502. Фикс из 0f1d946 применён (keepAlive=120s проверен), но 502 в Caddy access log продолжают появляться. Гипотеза №5 (keep-alive race) либо неполная, либо неверная.

Перебираем оставшиеся гипотезы, которые мы НЕ исключили в первый раз:

H6. Конкретное приложение/middleware закрывает сокет в каком-то редком пути.
    Как проверить: добавить инструментацию в middleware.ts + app/api/history/route.ts +
    app/api/generate/submit/route.ts, логировать КАЖДЫЙ 401/4xx ответ с
    Content-Length, чтобы корреляция с Caddy 502 стала видна железно.

H7. TCP backpressure на больших body — Caddy буферизует, Node не успевает
    читать, kernel закрывает.
    Как проверить: посмотреть размер тел "оставшихся" 502 в Caddy log. Если все
    > 8MB — это backpressure. Лечится либо streaming reads в handler, либо
    увеличением буферов.

H8. Caddy keepalive_idle_conns_timeout всё-таки больше Node 120s. У Caddy
    в Caddyfile никакого transport-блока нет, но Go-default может быть длиннее
    чем мы думали.
    Как проверить: погуглить ТЕКУЩИЙ Caddy/Go-default и при необходимости
    задать transport http { keepalive_idle_conns_timeout 60s } в Caddyfile.

H9. Что-то в инфраструктуре между Caddy и Node на Windows-хосте (firewall,
    Defender, conntrack) сбрасывает соединения.
    Как проверить: получить дамп wireshark/netsh trace на loopback в момент 502.

Прочитай docs/superpowers/specs/2026-05-25-caddy-502-keepalive-race-post-ship.md
для контекста того что уже сделано. Стартую с H6 (инструментация), это самое
быстрое для исключения/подтверждения. Подтверди или предложи другой порядок.
```

---

## Path C — хочется почистить долги после фикса

```
Возвращаемся к Caddy 502 follow-ups. Сам фикс держится, теперь дочищаем долги
из post-ship документа:

1. Caddyfile lint: убрать header_up X-Forwarded-Proto и X-Forwarded-For из
   localgen.maxkdiffused.org { ... } (Caddy v2 пробрасывает их по дефолту,
   warning'и появляются на каждом старте Caddy). caddy fmt --overwrite + reload.

2. Orphan recovery — за время до фикса несколько генераций потерялись
   (файл на диске, нет строки в generation_outputs). Прогнать админский
   orphan-tool из вкладки "Превью / History state" чтобы либо удалить
   осиротевшие файлы, либо (если есть тулза для пересоздания строк) ввести
   их в историю.

3. Долгосрочный мониторинг — оформить простой скрипт, который раз в час
   считает количество "reverseproxy.statusError" в Caddy access log и
   шлёт алерт если > 0. Сейчас "разгребаем глазами" — кустарно.

Прочитай docs/superpowers/specs/2026-05-25-caddy-502-keepalive-race-post-ship.md
"Open follow-ups" секцию. С какого пункта начнём?
```
