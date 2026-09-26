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
4. Render will detect `render.yaml` and create a **Docker** service. This is required for legacy CBE verification: the Dockerfile installs Chromium. Do not replace the Docker service with a native Node service or use the old `pnpm install ... && node dist/index.js` commands, because that runtime has no browser.
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

> **Existing Render service:** a service created from an earlier revision may still
> show `Using Node.js version ...` and run `pnpm install --frozen-lockfile && pnpm build`.
> That means it is ignoring the Dockerfile. Update the service to use Docker (or
> recreate it from the Blueprint), then perform a clean deploy. The startup log
> should show Chromium available for the CBE fallback; a Node.js-only startup is
> not a successful CBE deployment.

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

## Performance, regions and capacity

Measured on the live deployment (see `loadtest/README.md` and
`loadtest-results/`). Read this before tuning anything else.

### 1. The database region must match the Render region

`verify.noveld.com.et` resolves through Cloudflare to
`verifier-api-selfhosted.onrender.com`, i.e. a Render instance in **US West
(Oregon)**. A TiDB Serverless cluster created in **us-east-1** (as Step 1
suggests) puts a ~150 ms round trip between the app and its database:

| Endpoint | Database round trips | Warm p50 |
|---|---|---|
| `GET /health` (no database) | 0 | 37 ms |
| `GET /status/summary` (no database) | 0 | 39 ms |
| `GET /ready` (`SELECT 1`) | 1 | **194 ms** |
| `POST /verify-cbe` with an unknown key | 1 | **199 ms** |

A single verification issues several sequential queries, so this is the
difference between a ~200 ms and a ~1 s verification.

**Fix (pick one):**

- Recreate the TiDB Serverless cluster in **us-west-2 (Oregon)** and paste the
  new `DATABASE_URL` into Render (fastest, no code change), or
- Move the Render service to **us-east** (Ohio/Virginia) — Render's free plan
  offers us-east too.

### 2. Cold starts

The app pings its own `/ready` every 5 minutes while it is awake, which keeps
the instance from idling out. After a spin-down (deploy, manual sleep, crash)
nothing wakes it until real traffic arrives.

Measured with `--profile coldstart --coldstart-sleep 1200` (20 minutes idle,
run 36217057046): the first request cost **956 ms**, the next two 258 ms and
231 ms. That is *not* a cold start — the instance never slept. The in-process
pinger in `src/index.ts` fetches `${RENDER_EXTERNAL_URL}/ready` every 5 minutes,
and because that request arrives through Render's front door it resets the
inactivity timer, so an awake instance keeps itself (and TiDB) warm forever.

A genuine cold start only happens when Render restarts the container (deploy,
platform maintenance, crash) and nothing wakes it for 15 minutes. That path
pays Render's container boot, the boot-time `prisma db push` (schema
introspection against a remote database) *and* TiDB Serverless' own resume,
because both scale to zero. In the lab the same cold boot to first `200` costs
2.4 s and the first authenticated request afterwards 0.8 s (JIT + connection
pool warm-up).

To measure the real thing you have to stop the pinger first
(`KEEP_ALIVE_PINGER=false`), then idle 20 minutes.

Three things keep the first request of the day tolerable:

1. **Keep the pair awake.** `.github/workflows/keep-alive.yml` pings `/ready`
   (which does a real `SELECT 1`) every 5 minutes — that keeps Render *and*
   TiDB warm. It only runs from the repository's default branch, so it must
   exist on `main`.
2. **Do not push the schema on every boot in steady state.** `SKIP_SCHEMA_PUSH=true`
   skips the boot-time `prisma db push`; run it once per release instead
   (`npx prisma db push` from a shell, or a Render pre-deploy command).
3. **Fail fast instead of hanging.** Requests that arrive before the runtime is
   ready now wait at most `STARTUP_WAIT_MS` (default 15 s) and then get
   `503 + Retry-After` instead of a 90 s hang, which Cloudflare turns into an
   opaque 524.

`.github/workflows/keep-alive.yml` is the external half of that mechanism —
**scheduled workflows only run from the repository's default branch**. This repo
deploys from `selfhosted`, so unless that file also exists on `main` the cron
never fires. Merge `.github/workflows/keep-alive.yml` into `main` (or make
`main` the deploy branch) and the 5-minute ping keeps both Render and TiDB warm.

### 3. Connection pool sizing

Prisma sizes its pool from the CPU count it can see, which inside a container
can be the *host's* core count. On a 0.1-CPU free instance that over-provisions
connections, and TiDB Serverless caps connections per cluster. Pin it in the
connection string:

```
mysql://user:pass@host:4000/db?sslaccept=accept_invalid_certs&connection_limit=5&pool_timeout=20
```

`GET /status/summary` now reports the CPU count the process sees
(`diagnostics.process.reportedCpuCount`), plus memory and cache state, so you can
verify this without a shell.

### 4. Measured capacity

Against the current free-tier instance (staged ramp, cheap endpoints, run
36215753142):

| Concurrent clients | RPS | p50 | p95 |
|---|---|---|---|
| 1 | 7 | 91 ms | 256 ms |
| 10 | 58 | 93 ms | 262 ms |
| 25 | 134 | 106 ms | 393 ms |
| 50 | 135 | 209 ms | 841 ms |
| 100 | 141 | 309 ms | 1892 ms |

Throughput plateaus at ~140 rps and latency starts climbing after ~25
concurrent requests: that is the free plan's shared-CPU ceiling. No 5xx and no
429s were observed during the ramp.

A second live run of the same code (36216663965) reproduced the shape but with
every scenario ~50 ms slower — including `/health`, which touches no database at
all. So treat the absolute numbers as ±50 ms of network noise and compare
`endpoint − /health` instead.

The lab gives the per-request database cost without the network noise (single
pinned CPU, MySQL with a 60 ms emulated cross-region round trip, statements
counted by `loadtest/db-traffic.mjs`):

| Endpoint | SQL statements / request | Warm p50 |
|---|---|---|
| `GET /health` | 0 | 0.5 ms |
| `GET /ready` | 1 (`SELECT 1`) | 61 ms |
| `POST /verify-cbe`, unknown key | 1 (key lookup) | 62 ms |
| `GET /products`, verify-only key | 2 | 123 ms |
| `POST /verify-mpesa`, synthetic receipt | 2.8 | 716 ms (400 ms of it the stubbed provider) |
| `POST /verify-cbe`, malformed reference | 5 | 413 ms |

Every statement is a sequential round trip, so with a cross-region database the
database part of one verification is `statements × ~150 ms` — the malformed
request above spends ~750 ms of round trips *after* a change, and ~300 ms
before it, purely on charging and refunding a credit the customer never used.
Section 1 (region alignment) is still the cheapest fix by far.

### 5. Authenticated load tests must be paced

A workspace is allowed `config.freeRateLimit` requests per fixed 60 s window
(default **10** for FREE, 60 for PRO and 30 for a grandfathered FREE workspace),
and the dashboard auth path keys its bucket on `workspace + client IP`. A load
test on the authenticated endpoints therefore spends its first few requests on
real work and then measures nothing but `429`s.

When you point the harness at the deployment, pace the authenticated scenarios:

```bash
node loadtest/run.mjs --base-url https://verify.noveld.com.et \
  --profile latency --auth-pace-rps 0.12 \
  --scenarios health,ready,verify_validate_400 \
  --dashboard-secret "$DASHBOARD_SECRET" --workspace-id "$WORKSPACE_ID"
```

`--auth-pace-rps` delays only scenarios in the `authenticated` group, so the
anonymous surface is still measured at full speed. To characterise the throttle
boundary instead, ramp deliberately and read the `throttled_429` column — that
is what the load profile is for.

The dashboard path (`x-dashboard-key` + `x-workspace-id`, both server-side only)
is the practical way to authenticate a live run: it needs no database access to
mint a key. Note that it also bypasses per-key permissions, so a
permission-denied scenario such as `/products` will answer `200` rather than
`403` under it.

### 6. When a live run says "credentials rejected"

A report can read `Authenticated: yes (dashboard-secret)` and still have measured
nothing: if the service ignores the credentials, every authenticated sample is a
401 and the report looks like a fast, error-free verification path. The harness
detects this and prints a warning (and marks the report with `authHint`), so read
that line first. What each status means:

| What the authenticated scenarios returned | What it means | Fix |
|---|---|---|
| **401** | the service ignored `x-dashboard-key` — its `DASHBOARD_SECRET` differs from the repository secret `LOADTEST_DASHBOARD_SECRET`, or is unset | copy the Render environment value into the repo secret (or set `LOADTEST_API_KEY` instead — see below). An empty `DASHBOARD_SECRET` also disables dashboard auth for the Next.js UI |
| **404** | the secret matched but `LOADTEST_WORKSPACE_ID` does not exist in that database | use a workspace id from *that* deployment |
| **403** | `x-api-key` was recognised but the key is inactive/revoked | mint a fresh key in the dashboard |
| **402** | the workspace is out of monthly credits | top up, or use a workspace with credits |
| **429** | pacing is too fast for the workspace's limit (`config.freeRateLimit`, default 10 per 60 s) | lower `--auth-pace-rps` |

Two ways to authenticate a live run, in the order the workflow prefers them:

1. `LOADTEST_API_KEY` — a real `sk_live_…` key from the dashboard (Settings →
   API keys). Works regardless of `DASHBOARD_SECRET`, and exercises the exact
   customer path including per-key permissions.
2. `LOADTEST_DASHBOARD_SECRET` + `LOADTEST_WORKSPACE_ID` — no key minting needed,
   but the value must be byte-identical to the service's `DASHBOARD_SECRET`.
   Note this path bypasses per-key permissions, so a `permissions_403` scenario
   answers 200 instead of 403.

### 7. What the response cache changes

`VERIFY_CACHE_TTL_MS` (default 60 s) makes identical single-reference
verifications share one provider call:

- positive results only — a 404/422 ("receipt not found") is never cached,
  because the receipt may exist a moment later;
- concurrent duplicates are coalesced (two requests, one upstream call);
- the key is workspace + endpoint + body, so tenants cannot read each other's
  results, and `/verify-batch`, `/verify-image` and `/verify/public` are
  excluded;
- every response says what happened: `x-verify-cache: hit` or `coalesced`.

If your product needs every request to hit the provider (for example because a
receipt's status can move from pending to paid), set `VERIFY_CACHE_TTL_MS=0`.
`diagnostics.caches.verificationResults` on `/status/summary` reports hits,
coalesced duplicates and entries.

### 8. Is the database still the bottleneck? Ask the instance

Every SQL statement Prisma runs is counted (cheaply, from the `query` event) and
reported on the public status endpoint, so a deployed instance can answer
"what does one request cost" without lab tooling:

```bash
curl -s https://verify.noveld.com.et/status/summary \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["diagnostics"]["database"], indent=2))'
```

What to look at:

| Field | Meaning |
|---|---|
| `totals.statementsPerRequest` | average SQL statements per handled HTTP request since start |
| `window.statementsPerRequest` | the same, over the last 60 seconds (what it is doing *now*) |
| `totals.meanStatementMs` | mean statement duration — on a warm local pool this is ~1 ms; if it is ~150 ms you are paying the cross-region round trip described in section 1 |
| `topTables` / `byVerb` | where the statements go |
| `slowestStatements` | the three slowest statement shapes (truncated to 120 chars) |

Reference points measured on this deployment: `/health` costs 0 statements,
`/ready` costs 1, an authenticated verification costs 2–3 on the success path
(api-key lookup, quota decrement, plus the batched analytics flush) and the
writes that follow the response are batched into `createMany`/single updates.
If you see a number far above that, something started querying per request
again — check `topTables` before reaching for `EXPLAIN`.

### 9. Proxy and client IP

`getRequestIp()` trusts `CF-Connecting-IP`, then `X-Forwarded-For`, then
`X-Real-IP`. Web traffic arrives through Cloudflare, which sets those headers
correctly. A direct call to the `*.onrender.com` URL can forge them, so the
per-IP public verification limit and the dashboard rate limit are best-effort:
they protect against accidental floods, not against a determined attacker.
If you need hard limits, put the origin behind Cloudflare Tunnel or an
IP allowlist.

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

---

## Dashboard (`web/` → Cloudflare Pages)

The `web/` directory is a static Next.js SPA (login, password reset,
workspace overview, manual verification, API keys, payouts, payment links,
webhooks). It calls the Render API with `Authorization: Bearer` tokens.

- **Local:** `cd web && npm install && NEXT_PUBLIC_API_URL=http://localhost:3001 npm run dev`
- **Deploy:** push to `selfhosted` → `.github/workflows/deploy-web.yml` builds
  `web/out` and publishes to the `noveld-pay-dashboard` Pages project.
  Needs repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
- **Custom domain:** CNAME `dashboard.noveld.com.et` → `<project>.pages.dev`.
- **Important:** the API's `VERITAS_APP_URL` must be the dashboard URL, so
  password-reset emails link to a real `/reset-password` page.
