# ---- base (with pnpm) ----
# Use official Puppeteer image which has Chromium pre-installed and configured
FROM ghcr.io/puppeteer/puppeteer:22.15.0 AS base
WORKDIR /app

# The puppeteer image already has:
# - Node.js 20
# - Chromium at /usr/bin/chromium (via PUPPETEER_EXECUTABLE_PATH)
# - All required dependencies

# Create symlink for Puppeteer compatibility
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
ENV PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Verify chromium is available
RUN ls -la /usr/bin/chromium* /usr/bin/google-chrome* 2>/dev/null || true \
    && which chromium 2>/dev/null || true

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts

# Apply schema (idempotent — only creates missing tables/columns, preserves data)
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
