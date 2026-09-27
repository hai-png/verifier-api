# ---- base (with pnpm) ----
# Includes Puppeteer + Chromium for legacy CBE receipt PDF fetching.
FROM node:24-bookworm-slim AS base
WORKDIR /app

# The official Node image ships Corepack but does not always activate pnpm.
# Pin the package-manager major used to create pnpm-lock.yaml.
RUN corepack enable && corepack prepare pnpm@11.0.0 --activate

# Use the Debian Chromium installed below instead of downloading a second
# browser into node_modules during pnpm install.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Chromium dependencies for Puppeteer + Chromium browser
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libwayland-client0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    chromium \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/* \
    && ls -la /usr/bin/chromium* 2>/dev/null || true \
    && which chromium 2>/dev/null || true

# Create symlink for Puppeteer
RUN ln -sf /usr/bin/chromium /usr/bin/google-chrome 2>/dev/null || true

COPY pnpm-lock.yaml package.json pnpm-workspace.yaml* ./
COPY prisma ./prisma

# ---- deps (install devDeps) ----
FROM base AS deps
RUN --mount=type=cache,target=/root/.local/share/pnpm/store/v3 \
    pnpm install --frozen-lockfile --prod=false

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm prisma generate && pnpm build
RUN pnpm prune --prod

# ---- runtime ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Run as an unprivileged user. The container previously ran node as root, and
# Chromium is launched with --no-sandbox (see src/services/verifyCBE.ts), so
# anything that reached a renderer had root in a process holding DATABASE_URL,
# ADMIN_SECRET and DASHBOARD_SECRET. `--no-sandbox` is still required here: a
# Chromium sandbox needs user namespaces or SYS_ADMIN, which a Render free-tier
# container does not have. Dropping root is the half that is actually achievable;
# removing --no-sandbox needs a host that can sandbox, and a browser smoke test.
RUN groupadd --system --gid 1001 app \
    && useradd --system --uid 1001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app/uploads /app/.cache/puppeteer \
    && chown -R app:app /app

# Verify chromium is available
RUN ls -la /usr/bin/chromium* /usr/bin/google-chrome* 2>/dev/null || true \
    && which chromium 2>/dev/null || true

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/scripts ./scripts

USER app

# Boot sequence.
#
# Schema: `prisma db push` is idempotent and creates missing tables/columns on a
# fresh database, but it also costs several seconds on every cold start and can
# be destructive (the upstream migration history is incomplete, which is why the
# previous CMD passed --accept-data-loss). It now runs WITHOUT --accept-data-loss,
# its failure is not fatal, and it can be skipped entirely with
# SKIP_SCHEMA_PUSH=true once the schema is in place.
#
# The failure stays non-fatal deliberately: making it fatal turns a transient
# DDL lock timeout on a TiDB scale-to-zero resume into a crash loop, which is
# worse than booting against a schema that is already correct. The loud WARNING
# line is the signal, and /ready is the real gate — it returns 503 when the
# database is unreachable, so Render restarts instead of serving 500s. Set
# SKIP_SCHEMA_PUSH=true after the first successful deploy (render.yaml) so cold
# starts skip DDL entirely.
#
# Signals: `exec` keeps node as PID 1 so Render's SIGTERM reaches the process
# (graceful shutdown drains the write-behind buffers and closes the browser).
CMD ["sh", "-c", "if [ \"$SKIP_SCHEMA_PUSH\" != \"true\" ]; then npx prisma db push --skip-generate || echo 'WARNING: prisma db push failed - starting the API anyway; apply the schema manually'; fi; exec node dist/index.js"]
