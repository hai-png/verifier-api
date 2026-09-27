# Veritas Dashboard (`web/`)

Noveld Pay dashboard SPA (ported from the `noveld` repo's `dashboard` branch —
code only, no portfolio/media). Static-exported Next.js app, deployed to
Cloudflare Pages; talks to the API on Render.

## Pages

| Route | Purpose | API |
|---|---|---|
| `/` | Dashboard SPA: login/signup, workspaces, overview, API keys, payouts, payment links, products, payments, webhooks, settings | `/auth/*`, `/workspaces/*`, `/dashboard/*` |
| `/verify` | Authenticated dashboard verification for all supported providers | `POST /dashboard/:workspaceId/verify` |
| `/forgot-password` | Request reset link | `POST /auth/forgot-password` |
| `/reset-password?token=` | Set new password | `POST /auth/reset-password` |
| `/docs…` | 16-page API documentation | — |
| `/changelog` | Release notes (from repo CHANGELOG.md) | — |
| `/status` | Live service summary | `GET /status/summary` |

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
NEXT_PUBLIC_API_URL=https://your-verifier-api.example.com npm run build
# static output in web/out/
```

## Deploy

Push to `selfhosted`, then build `web/out` and publish it to the
`noveld-pay-dashboard` Cloudflare Pages project.

This used to say `.github/workflows/deploy-web.yml` did it automatically. No such
workflow exists in the repository — check `.github/workflows/` before relying on
it. Whatever builds the site must have `NEXT_PUBLIC_API_URL` set in its
environment: the value is inlined into the bundle at build time, `.env.example`
is not read by a Pages build, and `.env` is not committed. An unset value produces
a build-time warning and a dashboard that calls its own origin and fails.

Set the API's `VERITAS_APP_URL` to the dashboard URL so password-reset
emails link to a real `/reset-password` page.
