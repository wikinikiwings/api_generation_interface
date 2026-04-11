# syntax=docker/dockerfile:1.7
# ============================================================
# wavespeed-claude — self-contained build from git
# ============================================================
# В отличие от основного Dockerfile в корне проекта, этот файл:
#   1. Клонирует свежий код из git прямо в builder-слое
#      (не использует локальный COPY .).
#   2. Пересобирается по команде одной строкой на любой машине,
#      где есть Docker и доступ к .env-файлу.
#   3. .env подтягивается в рантайме через env_file в compose,
#      а не копируется в образ — секреты в образ не попадают.
# ============================================================

ARG NODE_VERSION=20-alpine
ARG REPO_URL=https://github.com/wikinikiwings/api_generation_interface.git
ARG REPO_BRANCH=main
# CACHEBUST пробрасывается start.sh с текущим timestamp. Любое
# изменение его значения инвалидирует кэш начиная со слоя clone,
# так что каждый запуск start.sh гарантированно тянет свежий HEAD.
ARG CACHEBUST=1

# ---------- 1. clone: тянем код из github ----------
FROM alpine/git:latest AS source
ARG REPO_URL
ARG REPO_BRANCH
ARG CACHEBUST
WORKDIR /src
RUN echo "cachebust=${CACHEBUST}" \
 && git clone --depth=1 --branch=${REPO_BRANCH} ${REPO_URL} app

# ---------- 2. deps: ставим зависимости с тулчейном ----------
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY --from=source /src/app/package.json /src/app/package-lock.json ./
RUN npm ci

# ---------- 3. builder: собираем Next.js standalone ----------
FROM node:${NODE_VERSION} AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=source /src/app/ ./
COPY --from=deps /app/node_modules ./node_modules
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- 4. runner: минимальный рантайм ----------
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache libc6-compat tini
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Запускаем от root — на Windows-хосте bind-mount /data приходит с
# владельцем root:root, и non-root процесс не может туда писать.
# SQLite молча открывается в read-only. См. корневой Dockerfile
# для расширенного комментария и блока для Linux-деплоя.

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN mkdir -p /data/history_images

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
