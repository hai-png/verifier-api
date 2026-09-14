# Veritas Dashboard (`web/`)

Noveld Pay dashboard SPA (ported from the `noveld` repo's `dashboard` branch —
code only, no portfolio/media). Static-exported Next.js app, deployed to
Cloudflare Pages; talks to the API on Render.

## Pages

| Route | Purpose | API |
|---|---|---|
| `/` | Dashboard SPA: login/signup, workspaces, overview, API keys, payouts, payment links, payments, webhooks, settings | `/auth/*`, `/workspaces/*`, `/dashboard/*` |
| `/forgot-password` | Request reset link | `POST /auth/forgot-password` |
| `/reset-password?token=` | Set new password | `POST /auth/reset-password` |

## Local dev

```bash
cd web
npm install
NEXT_PUBLIC_API_URL=http://localhost:3001 npm run dev
# → http://localhost:3000
```

## Production build (what Cloudflare runs)

```bash
cd web
NEXT_PUBLIC_API_URL=https://verifier-api-selfhosted.onrender.com npm run build
# static output in web/out/
```

## Deploy

Push to `selfhosted` → `.github/workflows/deploy-web.yml` builds and
publishes `web/out` to the `noveld-pay-dashboard` Cloudflare Pages project.
Needs repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

Set the API's `VERITAS_APP_URL` to the dashboard URL so password-reset
emails link to a real `/reset-password` page.
