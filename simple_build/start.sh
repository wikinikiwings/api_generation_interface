#!/usr/bin/env bash
# ============================================================
# Простой деплой wavespeed-claude из git.
#
# Что делает скрипт:
#   1. Инвалидирует слой `git clone` через CACHEBUST=<timestamp>
#      — так свежий HEAD из репозитория тянется всегда.
#   2. Пробрасывает путь к .env-файлу через переменную ENV_FILE.
#      По умолчанию ищет ./env рядом со скриптом.
#   3. Запускает docker compose up -d --build.
#
# Использование:
#   chmod +x start.sh
#   ./start.sh                        # ./env рядом
#   ENV_FILE=/path/to/.env ./start.sh # кастомный путь
#
# Требования: docker, docker compose plugin, доступ в github.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Путь к .env. Пользователь может переопределить через окружение.
ENV_FILE="${ENV_FILE:-./env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  echo "Create one based on .env.example from the main repo, or set ENV_FILE=/abs/path." >&2
  exit 1
fi

# Timestamp как cachebust — каждый запуск заставит git clone перевыполниться.
export CACHEBUST="$(date +%s)"
export ENV_FILE

echo "==> Using env file: $ENV_FILE"
echo "==> CACHEBUST=$CACHEBUST (forces fresh git clone)"
echo

docker compose up -d --build

echo
echo "==> Container is starting. Follow logs with:"
echo "    docker compose logs -f"
