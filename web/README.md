# Veritas Dashboard (`web/`)

Client-side dashboard for the verifier-api. Static-exported Next.js SPA,
deployed to Cloudflare Pages; talks to the API on Render.

## Pages

| Route | Purpose | API |
|---|---|---|
| `/login`, `/signup` | Session auth (Bearer token in localStorage) | `POST /auth/login`, `POST /auth/signup` |
| `/forgot-password` | Request reset link | `POST /auth/forgot-password` |
| `/reset-password?token=` | Set new password | `POST /auth/reset-password` |
| `/dashboard` | Workspace overview (credits, keys, links, orders) | `GET /auth/me`, `…/api-keys`, `…/payment-links` |
| `/dashboard/verify` | Manual payment verification (uses 1 credit) | `POST /dashboard/:ws/verify` |
| `/dashboard/api-keys` | Create / revoke keys (raw key shown once) | `GET/POST/DELETE …/api-keys` |
| `/dashboard/payouts` | Payout accounts (one per provider) | `GET/POST/DELETE …/payouts` |
| `/dashboard/payment-links` | Fixed-amount checkout links | `GET/POST …/payment-links` |
| `/dashboard/webhooks` | Event webhooks (secret shown once) | `GET/POST/DELETE …/webhooks` |

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
