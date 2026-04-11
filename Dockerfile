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

# non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# standalone output + статика + public
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# data dir для SQLite + картинок (mount point)
RUN mkdir -p /data/history_images && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
