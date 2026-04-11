# syntax=docker/dockerfile:1.7
# ============================================================
# wavespeed-claude — multi-stage Next.js standalone build
# ============================================================
# Native modules: better-sqlite3, sharp → требуют python/make/g++
# на этапе сборки. В рантайм-образ они уже идут как .node бинари.
# ============================================================

ARG NODE_VERSION=20-alpine

# ---------- 1. deps: ставим зависимости с тулчейном ----------
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 2. builder: собираем Next.js standalone ----------
FROM node:${NODE_VERSION} AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- 3. runner: минимальный рантайм ----------
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache libc6-compat tini
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Запускаем от root. Причина: bind-mount /data на Windows-хосте (Docker
# Desktop file sharing поверх NTFS) приходит в контейнер с владельцем
# root:root и правами, которые не даёт писать обычным пользователям.
# SQLite в этом случае молча открывает БД в read-only режиме и валит
# все write-запросы с "attempt to write a readonly database". Root внутри
# изолированного контейнера — это не root хоста, так что безопасность
# не страдает. На Linux-деплое это тоже работает без правок.
#
# Если в будущем понадобится запускать от non-root на Linux-хосте,
# раскомментируй блок ниже и передай UID владельца папки на хосте
# через --build-arg UID=$(id -u), затем USER appuser.
# ARG UID=1001
# RUN addgroup --system --gid ${UID} nodejs \
#  && adduser  --system --uid ${UID} appuser

# standalone output + статика + public
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# data dir для SQLite + картинок (mount point)
RUN mkdir -p /data/history_images

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
