# 📦 Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### 🔍 Diagnosis correction

- **The Telebirr relay cannot complete a TLS handshake with Ethio Telecom, and that is the real cause of the Telebirr outage.** The relay's TCP connect succeeds in ~200ms (`tcpProbe=ok`), then cURL returns errno 28 with "0 out of 0 bytes received" — not one byte back after the ClientHello. The provider itself is healthy: the same URL and reference return HTTP 200 with a 26KB page in ~40ms on the TLS handshake from other networks, over TLS 1.2. A rejected handshake returns an alert; silence means the ClientHello is being dropped on the path from the relay host to `196.188.116.120`, which points at the route or an MTU/PMTUD blackhole rather than at the trust store. The TLS pinning in `b3ea86a` did not address this and could not have: it assumed a TLS 1.3 protocol-version alert, which is a different failure from a silent drop.
- **Corrects the entry below.** The 18s budget work is real and worth keeping, but it was *not* the cause of this outage, and the "large page" explanation in it is wrong. A real receipt page is 26KB, at which point the extraction stage is trivially fast. That entry's reasoning about page size should be read as a hypothesis that measurement later disproved. What the budget work did fix is the reporting: the relay now answers in ~4.4s with a staged diagnosis instead of overrunning the API's deadline and returning nothing, which is what made this TLS fault look like a dead relay.
- **Known-good fallback:** the direct provider fetch is confirmed working from outside the relay host. `SKIP_PRIMARY_VERIFICATION=false` is now safe to try, since the primary hop is bounded to 8s and shares the request deadline, so a Render host that can reach the provider needs no relay at all.

### 🔍 Added

- **`tools/telebirr-tls-probe.php`**: a key-gated diagnostic for the relay host. It walks the TLS option matrix — default, TLS 1.2 and 1.3 forced, `SECLEVEL` 0/1/2, and verification disabled — to separate a trust-store problem from a cipher problem from packets being dropped on the path, and prints the fix for each outcome. Upload it to the relay host, read the result, delete it.

### 🐛 Fixed & improved

- **Telebirr relay budget**: A Telebirr verification failed after 18s reporting that the relay "did not respond", and blaming the relay's upstream provider fetch. Both hops answered promptly when probed directly, so the delay was inside the relay. Its own budget (a 4s reachability pre-check plus a 10s fetch) left only 4s of headroom, and its post-fetch stages were unbounded — `DOMDocument::loadHTML` plus 14 XPath queries ran eagerly whether or not any field needed the DOM. A slow page could therefore push the response past the API's deadline, so the API hung up on an empty body and reported a bare `ECONNABORTED`. See the diagnosis correction above: this was a reporting failure, not the outage itself.
  - `verify.php`: the pre-check is 2s and the fetch 8s, leaving ~2s of an explicit 11s `RELAY_BUDGET_MS` for parsing. The DOM is now built lazily, only when a regex extraction misses, and is skipped outright if the budget is already spent — so a page where every regex matched never pays for it. Provider pages are capped at 1MB (enforced for both advertised and chunked responses) and an oversized page fails explicitly rather than being truncated, because a partial page parses into plausible but wrong field values. Responses now carry `relayTiming` so a slow or degraded run is visible in the API's logs.
  - `verifyTelebirr.ts`: `TELEBIRR_PROXY_TIMEOUT_MS` now defaults to `12000` instead of `18000`, deliberately a slice of the 20s pool total rather than equal to it. The two budgets were inverted, so the pool deadline could never fire and a single attempt consumed the whole request. A per-attempt value at or above the pool total is now clamped down.
  - `verifyTelebirr.ts`: the timeout diagnosis no longer asserts that the relay's upstream provider fetch is the slow hop. A late response and no response are indistinguishable to the client, and the evidence cleared that hop; the message now names the relay as a whole and points at its own `relayTiming` report.

### 🔧 Changed

- **Telebirr primary hop**: the direct provider fetch is bounded to 8s and is abortable, and shares one deadline with the relay pool. It previously had a 30s timeout with no abort signal, so an enabled-but-hanging primary could outlast the entire pool budget on its own and starve the fallback it was meant to hand off to.
- **Telebirr relay redundancy**: the API now warns at boot and per request when only one relay candidate is available, because `TELEBIRR_HEDGE_DELAY_MS`, `TELEBIRR_MAX_PARALLEL_PROXIES`, `TELEBIRR_TOTAL_TIMEOUT_MS` and the circuit breaker are all inert with a single relay. A warning is also logged when `TELEBIRR_PROXY_TIMEOUT_MS` sits at or below the relay's own 11s budget, which is what produces a bare timeout instead of the relay's staged diagnosis.

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
