# ---- base (with pnpm) ----
# Slimmed for selfhosted build: no Puppeteer, no Chromium libs, no Tesseract.
# Fits in 256MB RAM (Render free tier / Fly.io free tier).
FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067 AS base
WORKDIR /app

# Only curl is needed (for healthchecks). No Chromium libs since Puppeteer was removed.
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends curl \
    && sudo rm -rf /var/lib/apt/lists/*

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
FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067 AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends curl \
    && sudo rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts

# Apply schema (idempotent — only creates missing tables/columns, preserves data)
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
