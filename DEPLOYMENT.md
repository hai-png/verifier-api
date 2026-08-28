# Deployment Guide — verifier-api-selfhosted

Free-tier deployment of the self-hosted Ethiopian payment verification API.

**Architecture:**
```
Mobile App → Cloudflare Worker → verifier-api (Render free) → bank/telecom APIs
                                     ↓ (for Telebirr + M-Pesa only)
                                  PHP proxy (your cPanel on Ethio Telecom)
                                     ↓
                                  transactioninfo.ethiotelecom.et / m-pesabusiness.safaricom.et
```

**Cost: $0/month** (all free tiers)

---

## Prerequisites

- **GitHub account** (to fork/connect this repo)
- **Render account** (free) — https://render.com
- **TiDB Cloud account** (free) — https://tidbcloud.com
- **cPanel hosting on Ethio Telecom** (you already have this — PHP 8+ with cURL)
- **Domain:** `verify.noveld.com.et` (point this at Render via a CNAME)

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

## Step 2: Deploy the Telebirr + M-Pesa PHP proxies on your cPanel

The verifier-api needs these proxies because Telebirr and Safaricom (M-Pesa) block requests from non-Ethiopian IPs. Your cPanel hosting is in Ethiopia, so it can reach them.

### 2a: Upload verify.php (Telebirr proxy)

1. Log in to your cPanel (e.g. `https://noveld.com.et:2083`)
2. Open **File Manager** → `public_html`
3. Upload the `verify.php` file from this repo to `public_html/verify.php`
4. Right-click `verify.php` → **Edit**
5. Find the line:
   ```php
   $TELEBIRR_PROXY_KEY = getenv('TELEBIRR_PROXY_KEY') ?: 'YOUR_SECRET_PROXY_KEY_HERE';
   ```
6. Replace `YOUR_SECRET_PROXY_KEY_HERE` with a random key (generate one: `openssl rand -hex 24`)
   ```php
   $TELEBIRR_PROXY_KEY = getenv('TELEBIRR_PROXY_KEY') ?: 'YOUR_PROXY_KEY_HERE';
   ```
7. **Save** — your Telebirr proxy URL is: `https://noveld.com.et/verify.php`

### 2b: Upload mpesa.php (M-Pesa proxy)

1. Upload `mpesa.php` to `public_html/mpesa.php`
2. Edit it — find the `$VALID_PROXY_KEY` line and set the same kind of random key
3. **Save** — your M-Pesa proxy URL is: `https://noveld.com.et/mpesa.php`

### 2c: Test the proxies

```bash
# Test Telebirr proxy (should return health info)
curl "https://noveld.com.et/verify.php?health"

# Test with a real reference (replace REF with a real Telebirr reference)
curl "https://noveld.com.et/verify.php?key=YOUR_PROXY_KEY_HERE&reference=TESTREF123"
```

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
   - `FALLBACK_PROXIES` → `https://noveld.com.et/verify.php?reference=`
   - `TELEBIRR_PROXY_KEY` → the key you set in verify.php (Step 2a)
   - `MPESA_FALLBACK_URL` → `https://noveld.com.et/mpesa.php`
   - `MPESA_PROXY_KEY` → the key you set in mpesa.php (Step 2b)
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
| **cPanel hosting** | Depends on your plan | — |

For a low-traffic payment verification API (a few hundred verifications/month), these limits are more than sufficient. The main UX impact is the 30s cold start on Render after idle — the first request after 15min of inactivity will be slow.

---

## Supported providers

| Provider | Method | Needs Ethiopian IP? |
|---|---|---|
| Telebirr | HTML scrape via PHP proxy | ✅ (via your cPanel) |
| CBE (legacy) | PDF fetch | ❌ |
| CBE (new token) | JSON API | ❌ |
| CBE Birr | PDF fetch | ❌ |
| Dashen Bank | PDF fetch | ❌ |
| Bank of Abyssinia | JSON API | ❌ |
| Awash Bank | HTML scrape | ❌ |
| Zemen Bank | PDF fetch | ❌ |
| M-Pesa | JSON via PHP proxy | ✅ (via your cPanel) |
| **All other banks** | OCR via Mistral Vision (image upload) | ❌ |

The OCR endpoint (`POST /verify-image`) accepts a receipt screenshot from ANY Ethiopian bank and extracts payer name, amount, date, reference, etc. via Mistral AI Vision. Supported banks include: Cooperative Bank of Oromia, Oromia Bank, Hijra Bank, Amhara Bank, Wegagen, Berhan, Abay, Lion, Bunna, Enat, Gadaa, Tsehay, Orbit, Shabelle, Sinqee.
