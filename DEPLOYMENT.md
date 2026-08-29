# Deployment Guide — verifier-api-selfhosted

Free-tier deployment of the self-hosted Ethiopian payment verification API.

**Architecture:**
```
Mobile App → Cloudflare Worker → verifier-api (Render free) → bank/telecom APIs
                                     ↓ (for Telebirr + M-Pesa only)
                           PHP proxy (Plesk on Ethio Telecom, via subdomain)
                                     ↓
                                  transactioninfo.ethiotelecom.et / m-pesabusiness.safaricom.et
```

> **Note on hosting**: These docs assume **Plesk** (not cPanel) hosting on Ethio Telecom. The apex
> domain `noveld.com.et` runs a separate portfolio site on **Cloudflare Pages**, so the PHP proxies
> are exposed on a dedicated subdomain (`proxy.noveld.com.et`) that is routed **directly to your
> Plesk server** (DNS-only, not through Cloudflare — Cloudflare cannot execute PHP).

**DNS layout:**
- `noveld.com.et` — Cloudflare Pages (portfolio site, proxied)
- `proxy.noveld.com.et` → `213.55.96.150` (Plesk origin, DNS-only/gray cloud)
- `verify.noveld.com.et` → verifier-api (Render)

**Cost: $0/month** (all free tiers)

---

## Prerequisites

- **GitHub account** (to fork/connect this repo)
- **Render account** (free) — https://render.com
- **TiDB Cloud account** (free) — https://tidbcloud.com
- **Plesk hosting on Ethio Telecom** (PHP 8+ with cURL) — your Plesk server public IP (e.g. `213.55.96.150`)
- **Cloudflare account** owning `noveld.com.et` (DNS)
- **Domains:**
  - `proxy.noveld.com.et` → your Plesk IP (for the PHP proxies)
  - `verify.noveld.com.et` → Render (via a CNAME)

---

## Step 1: Set up the database (TiDB Cloud Serverless — free)

1. Go to https://tidbcloud.com → Sign up → Create a **Serverless** cluster (free tier: 5GB storage)
2. Choose region: AWS us-east-1 (closest to Render's free tier)
3. Set a root password — save it
4. Once created, click **Connect** → **Connect with** Prisma → copy the connection string
5. It looks like: `mysql://<prefix>:<password>@gateway01.us-east-1.prod.aws.tidbcloud.com:4000/test?sslaccept=accept_invalid_certs`
6. **Save this** — you'll paste it as `DATABASE_URL` in Step 3

> **Why TiDB?** It's MySQL 8.0 compatible (Prisma works without schema changes), has a generous free tier (5GB, always free), and is serverless (scales to zero, no idle costs). Alternatives: Aiven free MySQL (1-hour idle timeout — not ideal), or any MySQL VPS.

---

## Step 2: Deploy the Telebirr + M-Pesa PHP proxies on your Plesk

The verifier-api needs these proxies because Telebirr and Safaricom (M-Pesa) block requests from non-Ethiopian IPs. Your Plesk hosting is in Ethiopia, so it can reach them.

### 2a: Point a subdomain at your Plesk server (Cloudflare)

Because the apex `noveld.com.et` is on **Cloudflare Pages** (static site, no PHP), the proxies must live
on a **subdomain routed directly to Plesk**. In Cloudflare → **DNS**, add:

| Type | Name | Value | Proxy status |
|---|---|---|---|
| A | `proxy` | `213.55.96.150` (your Plesk IP) | **DNS only** (gray cloud) |

> Use **DNS only**: if it's proxied (orange cloud), Cloudflare will serve the request and PHP never runs.
> Plesk will need its own SSL certificate for `proxy.noveld.com.et` (Plesk can issue one via Let's Encrypt).

### 2b: Upload verify.php (Telebirr proxy)

1. Log in to Plesk → **Domains** → select `proxy.noveld.com.et`
2. Open **File Manager** → the subdomain's document root (usually `httpdocs/` or `public_html/`)
3. Upload the `verify.php` file from this repo there
4. Edit `verify.php` — set your proxy key (generate one: `openssl rand -hex 24`):
   ```php
   $TELEBIRR_PROXY_KEY = 'YOUR_SECRET_PROXY_KEY_HERE';
   ```
   Replace `YOUR_SECRET_PROXY_KEY_HERE` with your random key, e.g.:
   ```php
   $TELEBIRR_PROXY_KEY = '6ba8888f98d36b6f021c9fe13ac61c4ffc493cfce670d200';
   ```
5. In Plesk, make sure SSL is enabled for `proxy.noveld.com.et` (Let's Encrypt)
6. **Save** — your Telebirr proxy URL is: `https://proxy.noveld.com.et/verify.php`

### 2c: Upload mpesa.php (M-Pesa proxy)

1. Upload `mpesa.php` to the same document root
2. Edit it — set the `$VALID_PROXY_KEY` line to a random key, e.g.:
   ```php
   $VALID_PROXY_KEY = '69c5847b2e8886c4a15a5a804b380b021be33b4d3a11cbd5';
   ```
3. **Save** — your M-Pesa proxy URL is: `https://proxy.noveld.com.et/mpesa.php`

### 2d: Test the proxies

> `verify.php` has **no `?health` route** — that test in older docs is wrong for this code. Test with
> the `key` + `reference` parameters instead.

```bash
# Telebirr — wrong/missing key should reject (401)
curl "https://proxy.noveld.com.et/verify.php?key=WRONG&reference=TEST"

# Telebirr — correct key reaches Ethio Telecom
curl "https://proxy.noveld.com.et/verify.php?key=YOUR_TELEBIRR_KEY&reference=TESTREF123"

# M-Pesa — wrong key should reject (401)
curl "https://proxy.noveld.com.et/mpesa.php?key=WRONG&reference=TEST"

# M-Pesa — correct key reaches Safaricom
curl "https://proxy.noveld.com.et/mpesa.php?key=YOUR_MPESA_KEY&reference=TESTREF123"
```

What a working proxy looks like:

- Wrong key → `{"success":false,"error":"Unauthorized: Invalid or missing proxy key"}`
- M-Pesa with a correct-but-nonexistent ref → `{"responseCode":"2032","responseDescription":"The transaction receipt number does not exist."}` (a legit Safaricom reply — the chain works)
- Telebirr may timeout with `Ethiotelecom is unreachable` if Ethio Telecom's receipt server is down or blocking the Plesk IP — this is a backend/provider issue, not a config problem.

---

## Step 3: Deploy the verifier-api on Render (free)

1. Go to https://render.com → Sign up (with GitHub)
2. **New** → **Blueprint**
3. Select your fork of this repo (or `hai-png/verifier-api`, branch `selfhosted`)
4. Render will detect `render.yaml` and create the service
5. In the **Environment** tab, set these secrets:
   - `DATABASE_URL` → paste the TiDB connection string from Step 1
   - `ADMIN_SECRET` → `openssl rand -hex 32` (generate + paste)
   - `DASHBOARD_SECRET` → `openssl rand -hex 32` (generate + paste)
   - `MISTRAL_API_KEY` → get from https://console.mistral.ai (free tier available)
   - `FALLBACK_PROXIES` → `https://proxy.noveld.com.et/verify.php?reference=`
   - `TELEBIRR_PROXY_KEY` → the key you set in verify.php (Step 2b)
   - `MPESA_FALLBACK_URL` → `https://proxy.noveld.com.et/mpesa.php`
   - `MPESA_PROXY_KEY` → the key you set in mpesa.php (Step 2c)
   - `REDIS_URL` → (leave empty — not needed for verifications, only for webhooks)
6. Click **Create Blueprint**
7. Render will build (5-10 min) + deploy. The URL will be `https://verifier-api-selfhosted.onrender.com`
8. Test: `curl https://verifier-api-selfhosted.onrender.com/health` → `{"status":"ok",...}`

---

## Step 4: Point your domain at Render

1. In Render: **Dashboard** → your web service → **Settings** → **Custom Domains** → Add `verify.noveld.com.et`
2. Render will show a CNAME target like `verifier-api-selfhosted.onrender.com`
3. In your DNS provider: add a CNAME record:
   ```
   verify.noveld.com.et → verifier-api-selfhosted.onrender.com
   ```
4. Wait 5-10 min for DNS propagation + Render to issue SSL
5. Test: `curl https://verify.noveld.com.et/health` → `{"status":"ok",...}`

---

## Step 5: Create your first API key

The verifier-api uses API keys for authentication. Create one via the admin endpoint:

```bash
# Generate an API key (returns the raw key ONCE — save it!)
curl -X POST https://verify.noveld.com.et/admin/api-keys \
  -H "x-admin-key: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"owner": "fitlife-hub", "tier": "BUSINESS"}'
```

Response:
```json
{
  "success": true,
  "key": "sk_live_YOUR_PROXY_KEY_HERE...",
  "id": "clx..."
}
```

**Save the `key` value** — you'll set it as `VERIFIER_API_KEY` on the Cloudflare Worker.

---

## Step 6: Wire the Cloudflare Worker to your self-hosted verifier-api

On your laptop, in the `fitness-app/server/` directory:

```bash
cd server

# Set the verifier-api URL (your self-hosted instance)
npx wrangler secret put VERIFIER_API_URL
# paste: https://verify.noveld.com.et

# Set the API key you generated in Step 5
npx wrangler secret put VERIFIER_API_KEY
# paste: sk_live_YOUR_PROXY_KEY_HERE...

# Set the payout account ID (create one via the API — see Step 7)
npx wrangler secret put VERIFIER_PAYOUT_ACCOUNT_ID
# paste: (from Step 7)

# Set the app base URL (for payment callbacks)
npx wrangler secret put APP_BASE_URL
# paste: fitlife://payment-callback
```

---

## Step 7: Create a payout account

A payout account is where payments should be sent (your Telebirr/bank account). Create one:

```bash
curl -X POST https://verify.noveld.com.et/payouts \
  -H "x-api-key: sk_live_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "FitLife Main",
    "accountHolderName": "Your Name",
    "type": "PHONE",
    "account": "0912345678",
    "providersAllowed": ["telebirr"]
  }'
```

Response includes the payout account `id` — use that as `VERIFIER_PAYOUT_ACCOUNT_ID` in Step 6.

---

## Verification: test the full flow

```bash
# 1. Check the verifier-api is healthy
curl https://verify.noveld.com.et/health

# 2. Verify a Telebirr reference (replace with a real one)
curl -X POST https://verify.noveld.com.et/verify-telebirr \
  -H "x-api-key: sk_live_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reference": "REAL_TELEBIRR_REF"}'

# 3. Verify via the Cloudflare Worker (end-to-end)
curl -X POST https://fitlife-hub-api.hbetseha.workers.dev/api/payments/verify-telebirr \
  -H "Content-Type: application/json" \
  -d '{"reference": "REAL_TELEBIRR_REF", "expectedAmountETB": 299}'
```

---

## Free tier limitations

| Service | Free tier limit | What happens when exceeded |
|---|---|---|
| **Render** | 750h/month (1 always-on instance), 512MB RAM | Spins down after 15min inactivity → cold start ~30s |
| **TiDB Cloud** | 5GB storage, 1B request units/month | Read-only when exceeded |
| **Mistral AI** | Free tier: 50 requests/day (approx) | /verify-image returns 503 |
| **Plesk hosting** | Depends on your plan | — |

For a low-traffic payment verification API (a few hundred verifications/month), these limits are more than sufficient. The main UX impact is the 30s cold start on Render after idle — the first request after 15min of inactivity will be slow.

---

## Supported providers

| Provider | Method | Needs Ethiopian IP? |
|---|---|---|
| Telebirr | HTML scrape via PHP proxy | ✅ (via Plesk) |
| CBE (legacy) | PDF fetch | ❌ |
| CBE (new token) | JSON API | ❌ |
| CBE Birr | PDF fetch | ❌ |
| Dashen Bank | PDF fetch | ❌ |
| Bank of Abyssinia | JSON API | ❌ |
| Awash Bank | HTML scrape | ❌ |
| Zemen Bank | PDF fetch | ❌ |
| M-Pesa | JSON via PHP proxy | ✅ (via Plesk) |
| **All other banks** | OCR via Mistral Vision (image upload) | ❌ |

The OCR endpoint (`POST /verify-image`) accepts a receipt screenshot from ANY Ethiopian bank and extracts payer name, amount, date, reference, etc. via Mistral AI Vision. Supported banks include: Cooperative Bank of Oromia, Oromia Bank, Hijra Bank, Amhara Bank, Wegagen, Berhan, Abay, Lion, Bunna, Enat, Gadaa, Tsehay, Orbit, Shabelle, Sinqee.
