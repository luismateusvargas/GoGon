# Dockerfile - CTRL-TASK-006 / AC-CTRL-005, DATA-TASK-008
# Node 22 (pinned), production dependencies from package-lock.json only, non-root runtime.
# The database is the mysql service in compose.yaml, so the image has no native modules, no build
# toolchain, and no writable application path.
# Build:  docker compose build        Run: docker compose up -d        (see docs/deployment.md)
# To pin by digest as well, replace the tag with node:22.20.0-bookworm-slim@sha256:<digest>
# (docker buildx imagetools inspect node:22.20.0-bookworm-slim).
ARG NODE_IMAGE=node:22.20.0-bookworm-slim

# --- dependencies ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# --- runtime ---
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    GG_CONTROL_ENABLED=1 \
    GG_DEBUG_DIR=/tmp/gogon-debug
WORKDIR /app

# Application files are owned by root and read-only to the runtime user.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.GG_HEALTH_CHECK_PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "app.mjs"]
