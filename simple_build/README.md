# simple_build

Автономный деплой `wavespeed-claude` из github в один контейнер одной
командой. В отличие от корневого `Dockerfile`/`docker-compose.yml`,
этот набор **не зависит от локальной копии исходников** — он клонирует
свежий HEAD из репозитория внутри builder-слоя Docker'а.

## Что внутри

| Файл | Назначение |
|---|---|
| `Dockerfile` | Multi-stage: git clone → deps → build → runner |
| `docker-compose.yml` | Единственный сервис, bind-mount `/data`, env_file через переменную |
| `start.sh` | Bash-обёртка: подставляет CACHEBUST и ENV_FILE, вызывает compose |
| `start.ps1` | То же для Windows PowerShell |
| `README.md` | Этот файл |

## Одноразовая подготовка

**1. Положи `.env` куда удобно.** В самой папке `simple_build` по умолчанию
ищется файл с именем `env` (без точки — чтобы случайно не коммитить).
Скопируй `.env.example` из корня основного репозитория и заполни ключи:

```powershell
Copy-Item ..\.env.example .\env
notepad .\env
```

Либо положи его в любое место и передай путь переменной окружения:

```powershell
$env:ENV_FILE = "C:\secrets\wavespeed-claude.env"
```

**2. Убедись, что папка для истории существует на хосте.** По умолчанию
это `C:\viewcomfy_data\database\` с подпапкой `history_images\`. Путь
зашит в `docker-compose.yml` — измени его там, если у тебя иначе.

**3. Docker Desktop должен быть запущен**, а папка из п.2 должна быть
в списке File Sharing (Settings → Resources → File Sharing).

## Запуск

**Windows (PowerShell):**
```powershell
cd E:\my_stable\viewcomfy\wavespeed-claude\simple_build
.\start.ps1
```

**Linux/macOS:**
```bash
cd ./simple_build
chmod +x start.sh
./start.sh
```

Скрипт делает три вещи:
1. Проверяет, что `.env` существует.
2. Выставляет `CACHEBUST=<unix-timestamp>` — это значение передаётся как
   build-arg в Dockerfile и **инвалидирует слой `git clone`**, заставляя
   Docker выкачать свежий HEAD из github. Если этого не делать, Docker
   радостно переиспользует закэшированный старый клон и ты не увидишь
   новые коммиты.
3. Вызывает `docker compose up -d --build`.

## Как это работает

```
github ──clone──> [source]      (alpine/git)
                      │
                      ▼
                  [deps]         (node:alpine + npm ci)
                      │
                      ▼
                  [builder]      (npm run build → .next/standalone)
                      │
                      ▼
                  [runner]       (node + standalone + /data volume)
```

Слой `source` зависит от `CACHEBUST` — при каждом запуске `start.sh`
этот arg меняется, и clone выполняется заново. Остальные слои (`deps`,
`builder`) переиспользуются из кэша, пока `package-lock.json` не менялся.
Так что типичная пересборка занимает ~20–40 секунд (clone + build), а не
полные 3–5 минут.

## Обновление до свежего кода

Просто запусти `start.ps1`/`start.sh` ещё раз. CACHEBUST поменяется,
clone подтянет новый HEAD, `deps` пересоберётся только если менялся
lockfile, `builder` — только если менялись исходники (что и так всегда
так при новом коммите).

```powershell
.\start.ps1
docker compose logs -f
```

## Удаление всего

```powershell
docker compose down
docker image rm wavespeed-claude:simple
```

Данные истории при этом сохранятся — они лежат на хосте в
`C:\viewcomfy_data\database\`, а не в volume Docker'а.

## Зачем вообще этот вариант

Основной `Dockerfile` в корне использует `COPY . .` — удобно во время
разработки, когда код редактируется локально и сразу тестируется. Но
для деплоя на другую машину такой подход требует ручного `git clone` +
`docker compose build` в нужной папке. `simple_build` избавляет от
первого шага: достаточно забрать только эту папку + свой `.env`, и
одна команда поднимет всё остальное.

## Troubleshooting

**`git clone` падает с permission denied** — репозиторий приватный,
нужен токен. Замени в Dockerfile `REPO_URL` на
`https://<token>@github.com/wikinikiwings/api_generation_interface.git`.
Лучше пробрасывать токен через build secret, но для личного
использования инлайн тоже работает.

**Build виснет на `npm ci`** — проверь интернет в Docker (особенно если
сидишь за VPN/прокси). `docker run --rm alpine ping -c 3 registry.npmjs.org`
должен отвечать.

**Контейнер стартует, но `/api/history` отдаёт 500** — проверь, что
папка `C:\viewcomfy_data\database\history_images\` существует и что
Docker Desktop видит диск `C:` в File Sharing.

**Хочу запустить на Linux-сервере** — поменяй в `docker-compose.yml`
путь bind-mount: `C:/viewcomfy_data/database:/data` → `/opt/viewcomfy_data:/data`.
Остальное работает без изменений.
