# 📦 Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### 🔍 Diagnosis correction

- **The Telebirr relay's DNS resolution for the provider is unreliable, and that is the real cause of the Telebirr outage.** A key-gated probe run twice on the relay host produced opposite results for identical cURL options, and the failures were `errno=28 "Resolving timed out after 4000 milliseconds"` and `errno=28 "Operation timed out ... with 0 out of 0 bytes received"`. The second is not a dropped packet: the connection never opened, because the name never resolved. The host runs cURL 7.61.1 / OpenSSL 1.1.1k, where `CURLOPT_TIMEOUT` does not reliably cover name resolution — a request that set `CURLOPT_TIMEOUT=6` ran for **56 seconds**. So the resolver consumed the entire request budget, the response overran the API's deadline, and the API reported a bare timeout against a relay that was reachable the whole time.
- **The provider itself is healthy.** The same URL and reference return HTTP 200 with a 26KB page and a 41ms TLS handshake from other networks over TLS 1.2, and the reference `DI10CLDXTM` is valid.
- **The provider's TLS handshake from the relay host fails about half the time, and it is not rate limiting.** Verified on the host against a real receipt: 8 consecutive requests split 4 fast (0.30-0.37s) and 4 slow (7.4-12.3s), with the DOM build measured at `domMs=1`, confirming extraction was never a factor. Repeating with 15s spacing made it *worse* (2 of 5 failed outright) rather than better, so the fault is a persistent property of the path from the relay host to the provider, not request rate. TCP connects to the provider in 0ms and the handshake then returns nothing, so the connection is established and the TLS layer is where it dies. Retries take this to roughly 87% success with high latency; a second relay on a different network is the real fix, and a host-level network investigation is the other. `tools/telebirr-tls-probe.php` now also samples PHP's own TLS via `stream_socket_client` alongside cURL, to separate a libcurl fault on that host from a host/network fault.
- **Corrects two earlier entries.** `b3ea86a` pinned TLS 1.2 and lowered the OpenSSL security level on the theory that OpenSSL 3.x rejects this provider's GlobalSign 2018 chain. The relay host runs **OpenSSL 1.1.1k**, where level 1 is already the default, so that reasoning never applied here; the probe did confirm the provider is TLS 1.2 only (`errno=35`, `tlsv1 alert protocol version`, deterministic), so the TLS 1.2 pin is kept as genuinely useful. The 18s budget work in `6f731cb` is also not the cause of this outage, and its "large page" explanation is wrong: a real receipt page is 26KB, where extraction is trivially fast. What that work did fix is the reporting — the relay now answers with a staged diagnosis instead of overrunning the deadline and returning nothing.

### 🐛 Fixed & improved

- **Telebirr relay: removed a self-inflicted 28s stall.** The previous commit re-resolved the provider's address after a failed fetch attempt, intending to recover from a stale address. Because the seed counted as a cached address, that re-resolve fired on the *first* failure and put the unbounded `gethostbyname()` call straight back onto the request path — reintroducing the exact stall it was written to prevent. Measured on the relay host: three 2s attempts plus a ~28s resolver block produced a **34.7s** request that the API had already abandoned at 12s. There is now no resolver call anywhere on a request path; the address is pinned for the whole request and the remaining attempts retry against it.
- **Telebirr relay: connect timeout was discarding handshakes that were about to succeed.** The provider's handshake is bimodal — probes on the relay host succeeded at 26ms, 38ms, 1064ms, 3081ms and 3319ms, and failed past 4000ms. `CURLOPT_CONNECTTIMEOUT` was 2s, so it cut off every attempt in the 2–3.3s band. That produced three consecutive `errno=28` on a host whose TCP connect to the same address completed in **0ms**. Per-attempt timeout is now 4s with the connect timeout equal to it, and `RELAY_BUDGET_MS` rises to 13.5s to keep 1s pre-check + 3 × 4s inside it.
- **Telebirr relay budget**: A Telebirr verification failed after 18s reporting that the relay "did not respond", and blaming the relay's upstream provider fetch. Its budget (a 4s reachability pre-check plus a 10s fetch) left only 4s of headroom, and its post-fetch stages were unbounded — `DOMDocument::loadHTML` plus 14 XPath queries ran eagerly whether or not any field needed the DOM. See the diagnosis above: this was a reporting failure, not the outage itself.
  - `verify.php`: an explicit `RELAY_BUDGET_MS` bounds the whole script, and the DOM is now built lazily, only when a regex extraction misses, and skipped outright if the budget is spent. Provider pages are capped at 1MB (enforced for both advertised and chunked responses) and an oversized page fails explicitly rather than being truncated, because a partial page parses into plausible but wrong field values. Responses carry `relayTiming`.
  - `verifyTelebirr.ts`: `TELEBIRR_PROXY_TIMEOUT_MS` now defaults to `16000`, a slice of the 20s pool total rather than equal to it. The two budgets were inverted, so the pool deadline could never fire and a single attempt consumed the whole request. A per-attempt value at or above the total is clamped down.
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
