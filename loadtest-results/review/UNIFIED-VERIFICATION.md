# Unified verification implementation — local follow-up

## Deployment facts and the reported delay

The owner confirmed **TiDB is in Frankfurt** and that **Dashen and Telebirr remain slow on repeated dashboard checks**. The API's previously observed origin DNS identifies Oregon. The dashboard's session-authenticated verification route previously bypassed the API result cache and implemented its own workspace lookup, billing and provider call.

This implementation removes that split. It does not relocate or deploy any service, and it does not claim that a production four-second request has already become faster.

## Implementation

- **One single-receipt HTTP pipeline:** dashboard session verification, universal API verification, and all eight legacy provider URLs use `src/middleware/verificationPipeline.ts`.
- **One validation/provider engine:** `prepareVerification` and `executeVerification` in `src/services/verifyUniversal.ts`. Compatibility adapters preserve legacy response envelopes without implementing independent provider logic.
- **Workspace access in one query:** dashboard access uses a membership predicate on the workspace query instead of separate membership and workspace reads. No authorization or credit balances are cached.
- **Shared policy:** rate limit, explicit API-key `verify` permission, plan expiry/rollover, atomic credit reservation, and existing infrastructure-failure refunds. Dashboard traffic no longer bypasses those rules. Invalid single inputs do not reserve credits.
- **Canonical tenant cache:** a short-lived final-success cache keyed by workspace/provider/reference/suffix/phone, independent of URL, HTTP method, and response envelope. A dashboard success can serve an equivalent API request only after that request passes fresh gates. Concurrent identical calls coalesce; failures, pending statuses, different tenants, and different case-sensitive tokens do not share completed results.
- **Bounded resources:** configurable completed-entry and in-flight-leader limits; short 503/Retry-After capacity rejection. Dashen uses at most two attempts within a default 15-second total network deadline rather than five 30-second attempts and 2-second retry sleeps.
- **Batch validation before bulk charging:** all entries use the same planner, plan limits use the synchronized tier, and provider fan-out is capped at five concurrent calls. Batch billing remains bulk billing; it does not silently become per-single-request billing.
- **Commerce and OCR reuse the engine:** payment matching/settlement checks, image credits and public quotas are separate product policies, not duplicated bank dispatch. Status probes intentionally bypass customer caching to observe the real provider.
- **Browser diagnostics:** `Server-Timing`, `X-Verify-Cache`, and displayed browser duration/cache status. Receipt responses are `Cache-Control: no-store`; CORS preflights may be cached for 600 seconds. Hidden stale suffix/phone inputs are no longer submitted after changing the selected provider.
- **Dashboard test support:** the load harness supports session-token environment variables and a no-provider `dashboard_validate_400` scenario. Trusted server credentials cannot be mistaken for a browser-session benchmark. JSON reports capture server phase timings and cache outcomes.

## Billing and compatibility

**Cache hits and coalesced requests are still charged per accepted request**, just as the API cache was previously. Caching is not payment-settlement idempotency. The quota update remains conditional/atomic; a cached result cannot bypass an exhausted balance, revoked API key, lost membership, missing permission, or rate limit.

Successful legacy payload shapes are retained. Some legacy endpoints historically return HTTP 200 for a provider-domain failure; those adapters still do so, while the engine marks the result unsuccessful and does not cache it. Dashboard/universal failures retain meaningful statuses. Malformed data is consistently rejected before charging. Keys without the `verify` permission now receive 403 on single-receipt routes. Dashboard users can now encounter plan/rate-limit behavior that the previous fragmented path bypassed.

Public verification remains explicitly throttled and quota/webhook/cache-free. Commerce verification remains fresh before its own account/amount/transaction-reuse checks. Signed health probes bypass the customer cache. Per-process caches and rate counters are not a distributed multi-replica solution.

## Local validation

- Strict backend TypeScript compilation: **passed**.
- Backend suite: **69 tests passed**.
- Zero-dependency harness suite: **11 tests passed**.
- Dashboard TypeScript/production static export: **passed**, 25 static pages generated.
- `git diff --check`: **passed**.

The integration tests run the production Express routers, API/session authentication, workspace-access predicate, permission/rate/quota middleware, cache and dispatcher. Database I/O and bank/telecom calls are stubbed; tests explicitly prove one provider call across repeated dashboard/legacy/universal requests, independent billing, tenant isolation, denied/revoked access, invalid-input handling, last-credit races, public exemptions, and failure non-caching.

Prisma client generation used the no-engine mode locally because engine downloads were unavailable. This is **not** a real-MySQL or deployed latency benchmark. No real bank load, production DB migration, or remote GitHub operation was performed in this closed session. Graphify is unavailable in the checkout.

## Next deployment steps

1. Start a **new coding session** to review and push these local changes; the original PR/session is closed.
2. Run the tests with real MySQL and a dedicated workspace before rollout, especially membership SQL, monthly resets and concurrent quota reservations.
3. Prefer a replacement **Frankfurt API service** alongside the existing Frankfurt TiDB cluster. Keep the database; do not recreate/delete it based on the old us-east example. Preserve proxy/secret/Chromium settings, run schema setup once, test readiness, then cut over the API domain and rebuild the dashboard if its embedded API URL changes. Retain a rollback service.
4. On the deployed dashboard, choose Dashen or Telebirr explicitly and repeat a successful reference in the same workspace within 60 seconds. Expect `X-Verify-Cache: miss` then `hit`, and almost no provider-stage time on the hit. A pending/failed receipt, different arguments, cache expiry/disablement, or another process correctly performs fresh work.
5. Compare browser duration with `access`, `policy`, `quota`, `provider`, and `verify_total`. API-key authentication occurs before the single-receipt pipeline and is not included in its `verify_total`; network/preflight/body parsing also sit outside that number.

**Expected benefit:** repeated successful Dashen/Telebirr checks avoid the second provider fetch; co-location reduces the remaining database round trips. First-time verification still depends on the bank/relay and has no promised sub-second latency.
