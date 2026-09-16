# ---- base (with pnpm) ----
# Includes Puppeteer + Chromium for legacy CBE receipt PDF fetching.
FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067 AS base
WORKDIR /app

# Install Chromium dependencies for Puppeteer + Chromium browser
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends \
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
    libgtk-3.0 \
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
    chromium-browser \
    && sudo rm -rf /var/lib/apt/lists/* \
    && ls -la /usr/bin/chromium* /usr/bin/google-chrome* 2>/dev/null || true \
    && which chromium 2>/dev/null || true \
    && which chromium-browser 2>/dev/null || true

# Create symlink for Puppeteer
RUN ln -sf /usr/bin/chromium /usr/bin/google-chrome 2>/dev/null || ln -sf /usr/bin/chromium-browser /usr/bin/google-chrome 2>/dev/null || true

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

# Ensure chromium is installed (fallback in case base stage didn't persist it)
RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends chromium chromium-browser \
    && sudo rm -rf /var/lib/apt/lists/* \
    && ls -la /usr/bin/chromium* /usr/bin/google-chrome* /usr/bin/chromium-browser* 2>/dev/null || true \
    && which chromium 2>/dev/null || true \
    && which chromium-browser 2>/dev/null || true

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts

# Apply schema (idempotent — only creates missing tables/columns, preserves data)
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/index.js"]
