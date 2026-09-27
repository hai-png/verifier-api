# 📦 Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased] — repository hardening

A security and correctness audit of the whole repository. Full detail, including
every finding and its disposition, is in `REVIEW.md`. Version intentionally left
unnumbered — this release contains breaking changes and should go out as a major
bump whenever the maintainer cuts it.

### ⚠️ BREAKING

- **`POST /verify-image` no longer claims payments are verified.** The endpoint
  returned `verified: true` on the strength of a vision-model read for 21 of its
  23 provider types, including 15 banks with no upstream API to consult at all. A
  receipt screenshot can be produced by anyone in any image editor, so that boolean
  was false advertising and any integration issuing goods on it was accepting
  forged receipts. `verified` is now `true` only when a provider API confirmed the
  payment. OCR-only receipts return `verified: false` plus a `verification` block
  (`method`, `authoritative`, `outcome`, `checks`, `requiresManualReview`).
  Callers who need the old behaviour can opt in per request with `?trustOcr=true`
  or per deployment with `OCR_TRUST_IMAGES=true`; every such call is logged.
- **Session tokens are stored hashed** (SHA-256), matching how API keys are already
  handled. A database read no longer yields bearer tokens that work against the
  API, the dashboard and any webhook they were registered for. Existing sessions
  cannot be migrated — **all logged-in dashboard users are signed out on deploy**.
- **M-Pesa verification has no built-in relay URL.** The hardcoded third-party
  default was removed, so `MPESA_FALLBACK_URL` is now required for the M-Pesa
  fallback path; without it the provider API result stands on its own.
- **Receipt naming now requires a reported account.** Matching a payment to a
  product previously accepted a receipt whose account could not be determined,
  which let a payment be attributed to the wrong order. Such receipts are refused
  with `RECIPIENT_NOT_REPORTED`.
- **`scripts/reset-db.js` defaults to a dry run.** It destroyed data on execution
  before, with no confirmation and no way to see what it would do. Destructive
  behaviour now requires an explicit flag.

### 🚀 Added

- **`verification` metadata on `/verify-image`**, including per-field `checks` that
  distinguish "did not match" (`false`) from "you did not ask" (`null`), and
  `outcome` values `confirmed` / `rejected` / `not_attempted` / `unverified` /
  `matches_expectations` / `does_not_match_expectations`.
- **Server-side expectation comparison** for OCR-only receipts: `expectedAmount`,
  `expectedPayerName`, `expectedPayerPhone`, `expectedReceiverName`,
  `expectedReceiverAccount`, `expectedReference` (form fields or query params).
  Amounts tolerate sub-bir rounding, names ignore case/word order/punctuation/
  company suffixes, phone numbers ignore the `0` vs `251` prefix convention.
- **`forward_to` route hints** when a reference cannot be resolved from the image
  alone (e.g. a `cbe-birr` receipt with no legible payer phone).
- **Encrypted webhook secrets at rest** (`WEBHOOK_SECRET_KEY`, AES-256-GCM, `v2.`
  prefix) with `migrateLegacyWebhookSecrets` for existing rows.
- **Configurable client IP resolution** via `CLIENT_IP_SOURCE`
  (`auto|cf-connecting-ip|x-forwarded-for|socket`), so rate limiting and admin IP
  checks cannot be bypassed by spoofing a proxy header, and honour it when one
  genuinely fronts the service. `CLOUDFLARE_INGRESS_SECRET` gates the admin
  routes when Cloudflare is the ingress.
- **`web/`: `NEXT_PUBLIC_API_URL` is now required.** See Fixed.
- **CI coverage for `web/`** (typecheck, static build, and assertions that the API
  origin is configured rather than defaulted and that the deployed CSP names only
  that origin). The dashboard previously had none.
- **`web/scripts/write-headers.mjs`**, run by `npm run build` after `next build`,
  which pins the deployed `Content-Security-Policy` `connect-src` to the configured
  API origin. See Fixed for the defect it replaces.
- New env vars, all documented in `.env.example`: `WEBHOOK_SECRET_KEY`,
  `SESSION_SWEEP_INTERVAL_MS`, `SESSION_SWEEP_BATCH`, `STATS_MAX_KEYS`,
  `STATS_RESPONSE_LIMIT`, `LOG_REQUEST_BODIES`, `OCR_TRUST_IMAGES`,
  `INSECURE_TLS_HOSTS`, `TLS_CA_BUNDLE_PATH`, `CLOUDFLARE_INGRESS_SECRET`,
  `CLIENT_IP_SOURCE`, `MPESA_PROXY_DEBUG`, `MPESA_PROXY_CAINFO`.

### 🐛 Fixed & improved

- **Dashboard sent credentials to a third-party server.** Six files under `web/src/`
  hardcoded `https://verifier-api-selfhosted.onrender.com` — a Render host this
  repository does not control, on a branch whose entire purpose is self-hosting. A
  fork that deployed without setting `NEXT_PUBLIC_API_URL` posted its users'
  credentials there. All six now read a single `API_BASE` from `web/src/lib/config.ts`,
  which defaults to same-origin rather than to someone else's deployment: an unset
  variable should fail visibly against your own host, not silently succeed against
  a stranger's. The build warns, and CI fails if a fallback is reintroduced.
- **The deployed CSP permitted an entire third-party PaaS.** `web/public/_headers`
  — which ships verbatim, since `output: "export"` has no `headers()` block — set
  `connect-src 'self' https://verify.noveld.com.et https://*.onrender.com`. The
  wildcard authorized the browser to send the dashboard's bearer token to *any*
  Render app, so the policy meant to constrain exfiltration exempted a whole
  platform; and it named no self-hoster origin, so a correctly configured fork had
  its API calls blocked by its own security headers. `public/_headers` is now
  `connect-src 'self'` only (fail-closed) and the build widens that one directive to
  the configured origin, rejecting wildcards, reducing the value to
  scheme+host+port, and re-reading its output to assert every directive survived.
- **Dashboard docs examples pointed at another deployment too.** `API_HOST` in
  `web/src/components/Docs.tsx` was a hardcoded production domain used in every
  published curl example; it now follows the configured origin, falling back to an
  obvious placeholder.
- **`GET /` reported a hardcoded version.** `version: '3.0.3'` was a string literal
  in `src/index.ts` that nothing kept in step with `package.json`; it is now read
  from the manifest at startup, degrading to `'unknown'` rather than throwing.
- **README was wrong about the API it documents.** The `GET /` response example
  listed `message`, `health` and `documentation` keys the route never returned, at
  version `2.1.0`, with 6 of the 14 endpoints. The clone instruction pointed at
  `github.com/Vixen878/verifier-api` while this repository's remote is
  `hai-png/verifier-api` — a self-hoster following it cloned the wrong tree.
- **`AGENTS.md` described tooling that is not in this repository.** All twelve lines
  instructed agents to query a `graphify` knowledge graph and run `graphify update .`
  after edits; neither the binary nor `graphify-out/` exists, so every such command
  failed, and the file told agents to prefer that graph over reading the source. It
  now documents the real commands, the offline/sandbox gotchas, and the invariants
  this release establishes.
- **`/verify-image` docs were wrong about the request.** The published example —
  in the README and on the dashboard's docs site — uploaded `image=@…`; the endpoint
  accepts only the `file` field and rejects anything else with a 400, so the
  documented call could not have worked. The response contract is now documented at
  all, including which providers are confirmed against their own API and what each
  `verification.outcome` and `checks` value means.
- **Dead config export removed.** `web/src/lib/config.ts` exported `APP_URL`,
  reading `NEXT_PUBLIC_APP_URL`, which nothing in the tree consumed and no
  documentation mentioned — an exported binding for a variable no code reads invites
  an operator to set it and wonder why nothing changed.
- **Dashboard read its bearer token under two different keys** (`noveld_token` in
  most places, a dead `nvd_token` in others), so code paths disagreed about whether
  the user was signed in. Unified on `noveld_token` behind `getToken()`/`setToken()`
  in `web/src/lib/api.ts`; the dead credential is cleared on read.
- **`verify.php` followed redirects without constraint** and `mpesa.php` was
  rewritten; both hardened.
- Removed `cookie-parser` (unused) and the `cbe-receipt-fix.patch` stray file;
  `Dockerfile` no longer copies `scripts/` into the runtime image.
- `.env.example` expanded to cover every variable the code actually reads.
- Prisma `Session` model: documented the token hash and indexed `expires` so the
  credential sweep is not a table scan.

---

## [3.0.3] - 2026-05-26

### 🚀 Added

- **CBE**: Added support for the new token-based / full receipt URL verification flow alongside the legacy FT + account suffix PDF flow.
- **Postman Collection**: Added examples for verifying new CBE token / full URL receipts without renaming `/verify-cbe`.

### ♻️ Changed

- **CBE Routing**: Preserved the existing `/verify-cbe` route while extending validation and routing logic to handle both legacy and new CBE receipt formats.
- **Universal Verification**: Updated `POST /verify` to recognize new CBE receipt tokens / URLs in addition to the legacy FT + suffix path.

---

## [3.0.2] - 2026-05-14

### 🚀 Added

- **Telebirr**: Added `customerNote` extraction support in both the primary Node.js service and the PHP proxy script.

### 🐛 Fixed & improved

- **Telebirr Parsing**: Fixed regex issues that caused parsing failures for transaction amounts over 1000 Birr (containing commas) and transactions with single-decimal `0.0 Birr` service fees.
- **PHP Proxy (`verify.php`)**: Improved regex and XPath matching logic to accurately parse complex HTML structures and handle varying number formats, aligning its behavior with the primary Node.js parser.

---

## [3.0.1] - 2026-02-25

### 🚀 Improved

- **Telebirr Proxy Upgrades**: The core `fetchFromProxySource` logic now properly traps `ETIMEDOUT` / `ECONNABORTED` and translates them into an HTTP 502 with contextual error messages down to the API client, instead of surfacing a generic 404 or hanging silently.
- **Upgraded PHP Proxy (`verify.php`)**: Rewrote the fallback Ethiotelecom request engine from `file_get_contents` to `cURL`. Now explicit SSL Certificate errors and connection timeouts from Ethiotelecom are properly trapped and returned as JSON to the node backend, and then to the user.
- **Secured PHP Proxy**: added a `key` parameter requirement to `verify.php`, mimicking the M-Pesa implementation to stop unauthorized public access.

---

## [3.0.0] - 2026-02-22

### 🚀 Added

- **Universal Verification Endpoint (`POST /verify`)**: A smart router that dynamically detects the payment provider (CBE, Telebirr, Dashen, Bank of Abyssinia, CBE Birr) based on the reference number structure and payload, simplifying client integrations.

### ♻️ Changed

- Promoted Universal Router `POST /verify` endpoint as the highlighted/recommended method in primary documentation.

---

## [2.1.1] - 2026-02-21

### 🚀 Added

- Add new M-Pesa verification endpoint with API integration and PDF parsing.
- Update Postman collection to include M-Pesa endpoints.

### 💾 Database Schema Updates (Important)

- Added `keyHash`, `prefix`, `tier`, and `userId` relational mapping to the `ApiKey` model for enhanced security and identity management.
- Added `createdAt` tracking to the `User` model.
- **Note for contributors:** Because of these schema changes, anyone cloning or pulling the repository must run `pnpm prisma db push` (or `npx prisma db push`) to synchronize their local database.

### 🐛 Fixed & improved

- Increase timeout for Telebirr verification to handle proxy retry logic.
- Implement retry mechanism for Dashen receipt fetching with 5 attempts.
- Update CBE Birr PDF parsing to handle actual document structure.
- Increase wait time for CBE PDF detection from 3s to 6s.
- Resolved a bug where the `verifyCBEBirr` service would fail implicitly if an API key was not explicitly provided through the inner service layer.
- Fixed an issue causing unhandled promise rejections to crash the development server silently during Prisma initialization on Windows.
- Fixed Express route precedence order to prevent the new `/verify` route from swallowing explicit `/verify-*` prefix calls (e.g. `/verify-image`).

---

## [2.1.0] - 2025-11-13

### Added

- Telebirr: Return `bankName` in receipt payloads.

### Changed

- Bump API version to `2.1.0` in package.json, root endpoint, README, Postman collection.

## [1.1.0] - 2025-05-18

> This release introduces the first major backend expansion: transitioning from a fully in-memory system to a database-powered API with authentication, stats, and admin tools.

### 🚀 Added

- 🔐 **API Key Authentication**
  - All verification endpoints (except `/` and `/health`) now require a valid API key.
  - Keys are stored in a Prisma-managed MySQL database.
  - Requests without valid keys are denied with a 401/403 error.

- ⚙️ **Admin Routes**
  - `POST /admin/api-keys`: Generate a new API key.
  - `GET /admin/api-keys`: View all active/used keys (securely abbreviated).
  - `GET /admin/stats`: View endpoint usage, response times, and request logs.

- 📊 **Usage Statistics Logging**
  - Each request is logged to a `UsageLog` table with:
    - API key ID
    - Endpoint
    - Method
    - Response time
    - Status code
    - IP address
  - Statistics are cached in-memory and pulled from the DB for admin views.

- 🛠 **Prisma + MySQL Integration**
  - Introduced full Prisma schema and MySQL connection to persist:
    - API keys
    - Usage logs

- 📁 **API Versioning Support**
  - Branch `api-keys-introduced` now tracks this new release.
  - Tagged as version `v1.1.0` in `package.json`.

### 🧹 Changed

- 🧠 Moved all key storage and logic from in-memory Maps to persistent DB.
- 🔄 `requestLogger` middleware now uses `res.on('finish')` for accurate response timing and DB writes.

### 🛡️ Security

- Admin routes are protected using `x-admin-key` headers.
- API keys are validated per request, and rate-limiting can be layered on in the future.

---

## [1.0.0] - 2025-05-12

> Initial release of the Payment Verifier API.

### ✨ Features

- ✅ **CBE Verification** via reference and suffix using Puppeteer and PDF parsing.
- ✅ **Telebirr Verification** using raw reference scraping.
- ✅ **Image-Based Verification** powered by **Mistral AI**, detecting CBE or Telebirr receipts.
- 🧪 Express API with simple `POST` endpoints:
  - `/verify-cbe`
  - `/verify-telebirr`
  - `/verify-image`
- 🔍 In-memory statistics and logging.

---
