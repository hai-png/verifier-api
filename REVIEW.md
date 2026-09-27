# Repository review — findings and dispositions

A detailed pass over the whole repository: code quality, security, correctness,
configuration, build and repository hygiene. Every finding below was either fixed
in this branch or is recorded as deliberately open with the reason.

**Verification at the time of writing:** `tsc --noEmit` clean across `src/` and
`web/`; `pnpm test` 172/172 passing (109 before this work, +63 new);
`next build` succeeds for `web/`.

Severity is about consequence, not about effort: **critical** means money or
authentication can be defeated, **high** means data exposure or a correctness bug
in a billing/settlement path, **medium** means a resource, hygiene or
maintainability defect with a plausible failure mode, **low** means it should be
fixed but nothing breaks today.

---

## 1. Verification correctness — can a payment be claimed that did not happen?

This is the product. A false `verified: true` is worse than an outage, because it
is silent and it is paid for.

| Finding | Sev | Status |
|---|---|---|
| `executeVerification` treated "not literally `success === false`" as a confirmed payment | critical | **fixed** |
| `/verify-image` returned `verified: true` for 21 of 23 provider types on the strength of a vision model reading a picture | critical | **fixed** |
| `/verify-image` routed 6 provider types to "trust the image" although this repo has a real adapter for each | high | **fixed** |
| `extractPaymentDetails` returned `{ account: null, amount: null }` for mpesa, awash and zemen | high | **fixed** |
| `accountMatches(null, …)` failed **open** — a receipt naming no recipient passed the recipient check | critical | **fixed** |
| `/admin/verify-payment` used the generic matcher while `/payment-links/:id/confirm` special-cased CBE, so the same receipt settled on one endpoint and was rejected on the other | high | **fixed** |
| Telebirr amounts parsed with `parseFloat("1,234.56 Birr")` → `1`; every payment over 999 ETB failed its amount check | high | **fixed** |
| `verifyMpesa` could return `success: true` with every field `undefined` | high | **fixed** |
| CBE Birr reference and phone interpolated raw into a query string | medium | **fixed** |
| M-Pesa reference interpolated raw into the relay URL (`ABC&debug=true` switched the relay into verbose mode) | medium | **fixed** |
| `verifyCBEBirr` returned a bare receipt object with no `success` field, forcing every caller to special-case it | medium | **fixed** |

**What changed.**

`executeVerification` now requires positive proof: `success === true`, or the
response is refused with a 502 and the payload's *shape* logged. Two adapters
(`verifyCBEBirr`, `verifyTelebirr`) never carried a status field — that absence is
precisely why "not false" had to mean "true". Both now normalise to the same
envelope, `verifyCBEBirr` at the source and `verifyTelebirr` at the dispatcher
boundary, so the service's 1,100-line relay machinery did not have to change.

`paymentMatch.ts` gained mpesa/awash/zemen cases and an explicit
`accountNotReportedByProvider` flag, which is what separates "this provider does
not publish a credited account" (Dashen — pass) from "it should have and did not"
(refuse). One `recipientMatches()` helper is now the single settlement check used
by both the payment-link and admin paths, so they cannot disagree again. When a
receipt yields no account the buyer is told `RECIPIENT_NOT_REPORTED` rather than
"wrong account", which sent everyone chasing a problem that had not happened.

`/verify-image` is the largest change. The image is now treated as what it is —
extraction, not verification:

* The six provider types with a real adapter (cbe-birr, dashen, abyssinia, awash,
  zemen, mpesa) have their extracted reference fed to the bank's own API. The
  bank's answer is authoritative and there is **no OCR fallback** when it says no,
  because a fallback would let a forged picture win whenever the real check
  failed.
* The remaining 15 types return `verified: false` with a machine-readable
  `verification: { method: "ocr_only", authoritative: false, checks: {…} }`.
  Callers can pass `expectedAmount` / `expectedPayerName` / `expectedPayerPhone`
  / `expectedReceiverAccount` / `expectedReference` and have them compared
  server-side — the check the old prose `note` asked the caller to perform by
  hand, now enforced and reported per field, distinguishing *matched*, *did not
  match* and *was not asked about*.
* The legacy `verified: true` shorthand survives behind `?trustOcr=true` or
  `OCR_TRUST_IMAGES=true`, per call and logged, so an existing integration can
  keep working without the default being a lie. See `src/utils/ocrVerification.ts`.

Unguarded `JSON.parse` on the model's output threw past the two refund paths into
an outer `catch` that did not refund, so the most likely model failure — prose, a
fenced block, `null` — was also the one that charged the customer for our fault.
It now refunds and reports 502.

---

## 2. Credentials at rest and in transit

| Finding | Sev | Status |
|---|---|---|
| `Session.sessionToken` stored the bearer token in plaintext | critical | **fixed** |
| `Webhook.signingSecret` stored plaintext, in a column still named `secretHash` | high | **fixed** |
| Four adapters hardcoded `rejectUnauthorized: false`; Chromium launched with `--ignore-certificate-errors` | critical | **fixed** |
| Dead `req.cookies?.session` fallback, with `cookie-parser` mounted globally and nothing ever calling `res.cookie()` | medium | **fixed** |
| `mpesa.php` shipped a committed placeholder key (`YOUR_SECRET_PROXY_KEY_HERE`), making it an open relay | critical | **fixed** |
| `mpesa.php` disabled certificate verification, followed redirects anywhere, and exposed `?debug=true` | high | **fixed** |
| `verifyMpesa` defaulted its relay to `https://leul.et/mpesa.php` — a third party | high | **fixed** |
| API key substring (`key.substring(0, 8)`) written to logs when no prefix existed | medium | **fixed** |
| Full receipt text and parsed receipt (payer name, phone, account) logged at INFO, four times per CBE Birr verification | high | **fixed** |
| Raw OCR result logged at INFO; raw Telebirr HTML logged at WARN | medium | **fixed** |
| `/status/summary` accepted its secret as `?secret=` | medium | **fixed** |

**What changed.**

Session tokens are stored as SHA-256 (`hashSessionToken`). SHA-256 rather than
bcrypt is deliberate: the token already carries 192 bits of randomness plus an
HMAC, so there is no dictionary to slow down, and the `@unique` index needs an
exact-match lookup that a salted hash cannot provide. Rows written before the
change can no longer be matched, so `purgeLegacyPlaintextSessions()` deletes them
— deciding plaintext credentials should not be in the database only pays off once
they are gone. **Deploying this signs every current user out.**

Webhook signing secrets cannot be hashed (the service must reproduce them to sign
deliveries), so `src/utils/secretVault.ts` encrypts them with AES-256-GCM under
`WEBHOOK_SECRET_KEY`. Values are versioned (`v2.`) so a re-key needs no flag day;
legacy plaintext rows still verify and are re-encrypted at startup. A GCM tag
failure fails closed to *unsigned* rather than signing with a corrupted key,
because a wrong signature is indistinguishable from an attack.

TLS is now one policy (`src/utils/tlsPolicy.ts`). Verification is on by default
and relaxation is an explicit, per-hostname, operator-visible decision seeded with
the four hosts whose chains genuinely do not validate today, logged at startup and
reported on `/status/summary`. `TLS_CA_BUNDLE_PATH` covers the other real failure
— a valid chain whose root is missing from the image — without disabling anything.
Chromium gets `--ignore-certificate-errors` only when the CBE receipt host is on
that list, because the browser ignores Node's agents and was silently a second
unverified path.

The receipt itself is no longer logged. `src/utils/redactPii.ts` provides
`redactReceiptRecord()` (safe-listed, so a field nobody anticipated is dropped
rather than passed through) and `receiptTextDigest()` (character count, line
count, HTML-vs-text, which field *labels* were present — everything needed to
diagnose a parse failure, no values). Raw text is available at `debug` level only.

`mpesa.php` was rewritten to `verify.php`'s already-hardened standard: fail closed
on an unset or short key, `hash_equals`, real HTTP status codes, verification on,
no redirect following, bounded body, reference charset-checked, and diagnostics
behind a server-side `MPESA_PROXY_DEBUG` rather than a public query flag. It also
reads the key from `X-Proxy-Key`, which the API now sends; the query parameter is
still accepted and logs a warning, so the two sides can be deployed in either
order.

`verifyMpesa` no longer defaults to a third-party relay. Like `verifyTelebirr`,
which already refused to guess, it reports a distinct "not configured" error
instead of "failed to fetch from both sources" — there is no second source, and
the old message sent operators looking for a network problem instead of a missing
environment variable.

---

## 3. Authentication and rate limiting

| Finding | Sev | Status |
|---|---|---|
| Client IP taken from the **leftmost** `X-Forwarded-For` entry — fully caller-controlled | critical | **fixed** |
| Rate limiter used one store for two different windows, so a sweep for one cleared the other | high | **fixed** |
| `rateLimiter` keyed on `'unknown'` when no IP could be derived, merging every such caller into one bucket | medium | **fixed** |
| `loginAllowed` short-circuited: once the per-email budget tripped, the per-IP counter stopped incrementing | high | **fixed** |
| Signup credits hardcoded instead of derived from the billing config | medium | **fixed** |
| Signup did not normalise the email the way login and forgot-password do | medium | **fixed** |
| `/reset-password` was the only unauthenticated credential endpoint with no throttle | medium | **fixed** |
| No cleanup of expired sessions or unused password-reset tokens, ever | medium | **fixed** |
| PII (email, name) in signup and login log lines | medium | **fixed** |

**What changed.**

`src/utils/requestIp.ts` resolves the client IP from `CF-Connecting-IP` (optionally
corroborated by `CLOUDFLARE_INGRESS_SECRET`), else the **rightmost**
`X-Forwarded-For` entry — the one the trusted proxy appended — else the socket.
Values must be address literals, so a 10 KB header cannot be stored verbatim as a
throttle key. Which source is in use is reported by `clientIpTrustState()` on
`/status/summary` and at startup, because an IP-based throttle is only as good as
this answer.

The leftmost-entry bug was the serious one: prepending to `X-Forwarded-For`
produced an unlimited number of fresh buckets, which defeated both the anonymous
`POST /verify/public` cap (10/hour) and the anonymous `rateLimiter` cap (6/hour)
with a single header.

`src/utils/expiringStore.ts` now carries a per-entry `windowMs`, evicts the entry
closest to expiry rather than an arbitrary one, and reports eviction counts. The
rate limiter uses separate stores for the 60-second plan window and the one-hour
anonymous window, limits at workspace level, and never falls back to `'unknown'`.

`resetAllowed()` increments both of its counters before comparing either, which is
the shape `loginAllowed` now has; the per-token key is the SHA-256 the route
already computes, because a throttle map is not a place to keep a live credential.

`src/utils/sessionMaintenance.ts` sweeps lapsed sessions and unused reset tokens
on an interval, jittered, batch-bounded, `unref`'d, and collapsed against itself
so a slow sweep cannot stack up. `@@index([expires])` was added to `Session` and
`VerificationToken`; without it the sweep is a full scan of a table that has grown
with every login the service has ever had.

---

## 4. Resource bounds and shutdown

| Finding | Sev | Status |
|---|---|---|
| `initializeStatsCache` ran two unbounded `GROUP BY`s over all of `UsageLog` at boot, loading every row into memory | high | **fixed** |
| `getUsageStats` ran the same two unbounded aggregations per admin call and serialised every distinct IP into the response | high | **fixed** |
| Stats keyed on the raw request path, so every receipt reference and crawler probe became its own endpoint — in memory and in the `UsageLog.endpoint` column | high | **fixed** |
| `/verify-batch` bypassed the result cache entirely | medium | **fixed** |
| A batch of 500 identical references made 500 provider calls and consumed 500 credits | high | **fixed** |
| Batch usage logs written by a detached `void (async () => createMany())()`, in flight when shutdown disconnected Prisma | medium | **fixed** |
| `waitForRuntime` was mounted **after** the routers, so `/admin/*` was reachable before the runtime was ready | high | **fixed** |
| Teardown sequence written out twice, and the two copies had drifted | medium | **fixed** |
| `scripts/reset-db.js` dropped every table with no confirmation, no environment guard, and `exit(0)` on failure | critical | **fixed** |
| The production image copied `scripts/` in, shipping the database-wiping script | medium | **fixed** |

**What changed.**

Both aggregations are ordered and limited, the limit clamped to an integer by
construction; `getUsageStats` reports `truncated: { endpoints, ips, limit }` so a
shortened list cannot be read as a complete one. Returning a census of every
client IP to an admin-key holder was personal data nobody needed in bulk — an
operator wants the busiest groups.

Endpoint labelling moved to the `finish` event, where Express has matched a route
and `req.route.path` is available. That is the only bounded label there is.
Unrouted requests are counted under a collapsed path in memory (`/pl/:id/pay` —
which is how a crawl shows up) but recorded as `(unrouted)` in the database, where
unbounded cardinality is expensive.

`/verify-batch` collapses identical `(provider, reference, suffix, phoneNumber)`
tuples to one provider lookup before spending anything, refunds the duplicate
credits through `refundPartialQuota()` (which reduces the recorded charge first,
so the response-finish hook cannot refund the same units twice), runs each lookup
through the same cache and in-flight coalescing single verification uses, and
labels each result row with `duplicateOf`. The cache only replays *successful*
lookups — a negative answer is deliberately never stored — so collapsing in the
route is what covers a batch of failures. Usage rows go through the buffered
writer that graceful shutdown drains.

`reset-db.js` is now a dry run by default and requires `--yes`, a typed-back
`--target host/database`, and `--force` if the core commerce tables hold rows.
`NODE_ENV=production` is refused outright and any failure exits non-zero. The
Dockerfile no longer copies `scripts/` at all.

---

## 5. Dashboard (`web/`)

| Finding | Sev | Status |
|---|---|---|
| `NEXT_PUBLIC_API_URL` defaulted, in six separate files, to a specific third-party Render host | critical | **fixed** |
| Two session-token keys: pages used `noveld_token`, `lib/api.ts` used `nvd_token` | high | **fixed** |
| `getToken()`/`setToken()` in `lib/api.ts` were dead code operating on a key nothing read | medium | **fixed** |
| `web/README.md` and `DEPLOYMENT.md` documented a `deploy-web.yml` workflow that does not exist | medium | **fixed** |
| Deployed CSP allowed `https://*.onrender.com` — any app on a third-party PaaS — and did *not* allow the self-hoster's own configured API origin | critical | **fixed** |
| `API_HOST` in `components/Docs.tsx` hardcoded one production domain, used in every published curl example | medium | **fixed** |
| Docs page for `/verify-image` uploaded the wrong form field (`image=`; the endpoint accepts only `file` and 400s otherwise) and never said that 15 of 23 providers are OCR reads with nothing confirmed | high | **fixed** |
| `web/` had **no CI coverage at all** — no typecheck, no build, no assertion about where it points | high | **fixed** |
| `APP_URL` exported from `lib/config.ts` read `NEXT_PUBLIC_APP_URL`, which nothing in the tree consumes | low | **removed** |
| Session token in `localStorage` is XSS-exfiltratable | low | **open, by design** |

**What changed.**

This is the `selfhosted` branch. A fork that built the dashboard without setting
`NEXT_PUBLIC_API_URL` would have posted its users' login credentials, bearer
tokens and verification API keys to a server nobody reading the file controls —
silently, over valid TLS. There is one definition now (`web/src/lib/config.ts`),
no third-party default, a build-time warning in `next.config.ts` when the variable
is unset, and same-origin fallback, which on a static export fails visibly against
a host the operator controls.

`nvd_token` was a trap rather than a live bug: nothing ever called `setToken()`,
so the real session lived in `noveld_token` the whole time. `lib/api.ts` is now
the single owner of the key — kept as `noveld_token`, because renaming it would
sign every user out on deploy — the pages use its helpers, and `getToken()`
deletes any `nvd_token` it finds, since a credential under a key no logout path
knows about is a credential that never gets removed.

**The CSP was the second half of the same defect.** `web/public/_headers` — the
file that actually ships, since `output: "export"` has no `headers()` block —
listed `connect-src 'self' https://verify.noveld.com.et https://*.onrender.com`.
The wildcard authorized the browser to send this dashboard's bearer token to *any*
Render app, so the policy that was supposed to constrain exfiltration exempted an
entire third-party platform; and it named no self-hoster origin, so a correctly
configured fork had its API calls blocked by its own security headers. Too
permissive and too restrictive at once.

`connect-src` is now computed. `public/_headers` stays `connect-src 'self'`
(fail-closed, and what deploys if the script is ever skipped) and `npm run build`
runs `web/scripts/write-headers.mjs` after `next build` to widen that one directive
to the configured origin. It rejects wildcard hosts, reduces the value to
`URL.origin` so a path or query string cannot widen the policy, strips the
template's comments from the deployed file, and re-reads its own output to assert
every directive survived. That last part is not decoration: the first version of
this script substituted `connect-src[^;]*` file-wide, `[^;]` matched across the
newline into the real directive, and the build produced an `out/_headers` with **no
CSP at all** while exiting 0. A security-headers script that can silently emit no
security headers has to verify its own output.

CI now has a `dashboard` job that typechecks, builds, and asserts all of it — that
the variable is read in exactly one file, that no fallback or third-party origin
exists in `src/`, that the checked-in CSP is wildcard-free and `'self'`-only, and
that the *deployed* `out/_headers` names this build's origin and nobody else's.
Each assertion was verified to fail against the defect it guards.

The docs fixes matter as much as the code ones here: the `/verify-image` page told
integrators to upload a field the endpoint rejects, and described 23 provider types
as though reading a screenshot confirmed a payment. Documentation that overstates a
guarantee produces the same outcome as code that does.

The `localStorage` tradeoff stays. Moving to an httpOnly cookie would mean
re-adding the cookie-authentication path this review removed from the API for good
reason: a credential a browser attaches automatically to every same-site request
is the CSRF shape, and an explicit `Authorization` header is not.

---

## 6. Repository and build hygiene

| Finding | Sev | Status |
|---|---|---|
| `pnpm test` listed 29 test files by name; the suite had 35 | high | **fixed** |
| `fireSessionWebhook(url, payload)` — no callers, no URL validation, no signature | medium | **removed** |
| `cbe-receipt-fix.patch` at the repo root, applying to nothing in either direction | low | **removed** |
| `.gitignore` claimed committed load-test logs contain request bodies and an API key prefix | low | **corrected** |
| `VERIFY_CACHE_TTL_MS` / `VERIFY_CACHE_MAX_ENTRIES` documented twice in `.env.example` with different values | low | **fixed** |
| `mpesa.php` / `verify.php` at the repo root rather than in a deploy directory | low | **open** |
| `loadtest-results/` — 176 files, 5.4 MB of generated reports, tracked | low | **open, by design** |
| `prisma/migrations` history is broken; `db push` is used instead | medium | **documented** |
| `GET /` reported `version: '3.0.3'` from a string literal in `src/index.ts` rather than from `package.json` | medium | **fixed** |
| README's documented `GET /` response listed keys the route does not return (`message`, `health`, `documentation`) at version `2.1.0` | medium | **fixed** |
| README's clone instruction pointed at `github.com/Vixen878/verifier-api`; this repo's remote is `hai-png/verifier-api` | medium | **fixed** |
| `AGENTS.md` instructed agents to prefer a `graphify` knowledge graph and run `graphify query`/`graphify update .` — neither the tool nor `graphify-out/` exists here | medium | **rewritten** |

`pnpm test` now runs `node --test dist/tests/*.test.js`. Six test files were being
skipped by CI entirely — a test that does not run is worse than no test, because it
is counted as coverage.

The `.gitignore` warning was checked rather than trusted: `loadtest-results/`
carries 5,156 `[redacted]` markers, no `"body"` entries, and no `DATABASE_URL`,
`REDIS_URL`, `DASHBOARD_SECRET`, `ADMIN_SECRET`, bearer token or unredacted key.
The only phone-shaped values are synthetic fixtures. The comment now says that,
and says to re-run the sweep before committing new results, because a raw server
log committed again is a credential leak into history that has to be rewritten to
undo.

`AGENTS.md` was twelve lines of instructions for tooling that is not part of this
repository: no `graphify` binary, no `graphify-out/`, nothing tracked, only
`.gitignore` entries for a directory nobody generates. Every command it told an
agent to run failed, and it told agents to prefer that nonexistent graph over
reading the source. It now documents the real build/test commands, the sandbox
gotchas that cost the most time here (`PUPPETEER_SKIP_DOWNLOAD`, `prisma generate`
needing network, `node --test` requiring a glob not a directory, and the
never-settling-promise failure mode that reports `cancelled` with `fail 0`), and
the invariants established by this review, so the next agent does not undo them.

The version literal is the small version of a real failure mode: two sources of
truth for one fact, with nothing forcing them to agree. `GET /` now reads
`package.json` at startup and degrades to `'unknown'` rather than throwing, because
self-description must never be able to take the service down.

`pnpm install` cannot complete without `PUPPETEER_SKIP_DOWNLOAD=true` (the
postinstall fetches Chrome from a host this sandbox cannot reach), and
`prisma generate` cannot run at all here (`binaries.prisma.sh` resets the TLS
socket). Both are sandbox limits, not repository defects; CI has network access.

---

## 7. Deliberately open

* **`prisma/migrations` cannot be replayed.** Migration 4 `ALTER`s
  `PlanPricingConfig`, which no migration creates, and migrations 2–3 `ALTER`
  lowercased table names that do not exist on a case-sensitive MySQL or TiDB
  server. `migrate deploy` fails with P3018 and leaves a `_prisma_migrations` row
  with `rolled_back_at = NULL` that blocks every later migration. Deployments use
  `db push`; `prisma/migrations/README.md` and `scripts/reset-db.js` document it.
  Rewriting history against a live database is not something to do from a review
  branch.
* **`loadtest-results/` stays tracked** — the CI report publisher commits there,
  and `git add loadtest-results` only works while the directory is not ignored.
* **PHP relays stay at the repo root** because that is where the Plesk deployment
  instructions tell people to copy them from.
* **`localStorage` session tokens** in the dashboard, per §5.
* **`qs` and the three unaudited-high advisories** (`extract-zip`, `deepmerge-ts`,
  `multer`) are pinned and documented as accepted in `pnpm-workspace.yaml` and
  `DEPLOYMENT.md`; no patched releases exist for two of them and the reachable
  code paths do not execute.

---

## 8. Environment variables introduced

All are optional; all default to today's behaviour except where noted. Each is
reported on `GET /status/summary` (with `x-status-secret`) and logged at startup,
so the running posture is visible without reading the source. Documented in
`.env.example`.

| Variable | Purpose |
|---|---|
| `WEBHOOK_SECRET_KEY` | Enables AES-256-GCM encryption of webhook signing secrets. **Without it they are stored in plaintext** and that is logged as a warning. |
| `INSECURE_TLS_HOSTS` | The complete list of hosts fetched without certificate verification. Seeded with the four that need it; empty means verify everything. |
| `TLS_CA_BUNDLE_PATH` | Extra CA bundle, for a valid chain whose root is missing from the image. Preferred over relaxing verification. |
| `CLOUDFLARE_INGRESS_SECRET` | Corroborates `CF-Connecting-IP` before an IP-based throttle trusts it. |
| `CLIENT_IP_SOURCE` | `auto` (default), `cf-connecting-ip`, `x-forwarded-for` or `socket`. |
| `OCR_TRUST_IMAGES` | Restores the legacy `verified: true` shorthand for OCR-only receipts. Off by default; every use is logged. |
| `SESSION_SWEEP_INTERVAL_MS`, `SESSION_SWEEP_BATCH` | Expired-credential sweep cadence and per-sweep row bound. |
| `STATS_MAX_KEYS`, `STATS_RESPONSE_LIMIT` | Bounds on the in-memory stats maps and on how many groups a stats query may load or return. |
| `MPESA_PROXY_DEBUG`, `MPESA_PROXY_CAINFO` | Relay-side only (`mpesa.php`), not read by the API. |

**Required, and newly so:** `NEXT_PUBLIC_API_URL` at dashboard build time. It has
no default any more; see §5.

**Behavioural changes to plan for when deploying:**

1. Every current dashboard session is invalidated (session tokens are now hashed).
2. `/verify-image` returns `verified: false` for OCR-only receipts unless
   `trustOcr` is opted into. Consumers that only read that boolean need updating —
   they were previously told a forged image was a confirmed payment.
3. M-Pesa verification requires `MPESA_FALLBACK_URL`; it no longer falls back to a
   third-party relay.
4. A receipt that names no credited account is refused rather than accepted. The
   response distinguishes `RECIPIENT_NOT_REPORTED` from `RECIPIENT_MISMATCH`.
5. `reset-db.js` is a dry run unless given `--yes --target <host>/<db>`.
