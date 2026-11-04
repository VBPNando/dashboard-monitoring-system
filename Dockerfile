# ---------- 1. Build frontend ----------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. Build backend ----------
FROM node:22-bookworm-slim AS api
WORKDIR /api
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ---------- 3. Runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DBMON_DATA_DIR=/app/data \
    DBMON_STATIC_DIR=/app/public \
    DBMON_SQLITE_DIR=/sqlite
WORKDIR /app
COPY --from=api /api/package.json ./
COPY --from=api /api/node_modules ./node_modules
COPY --from=api /api/dist ./dist
COPY --from=web /web/dist ./public
# ping dibutuhkan untuk pemantauan SLA ISP
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data /sqlite && chown -R node:node /app /sqlite
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
