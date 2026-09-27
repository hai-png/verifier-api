# Deployment location and dashboard-path check

Checked 2026-09-26, approximately 12:12–12:13 UTC. Public network observations and checked-out source only; no hosting-control-plane credentials or authenticated receipt requests used.

**Owner confirmation after this check:** TiDB is in **Frankfurt**, and the repeatedly slow providers are **Dashen and Telebirr**. The earlier database-region uncertainty is resolved by that confirmation (not private control-plane access). The local unified-pipeline changes are documented in `DEPLOYMENT.md`; they are not deployed.

## What is verified

| System | Observation | Conclusion and limitation |
|---|---|---|
| Dashboard `dashboard.noveld.com.et` | DNS A: `172.67.142.4`, `104.21.79.48`; public `/verify/` page is titled Noveld Pay Dashboard and requires sign-in. Repository `web/next.config.ts` configures a static Cloudflare Pages export. | Cloudflare-facing frontend. Anycast addresses do not establish the origin's city or the edge serving the user's computer. Pages hosting is consistent with configuration but not independently confirmed through its control plane. |
| API `verify.noveld.com.et` | CNAME `verifier-api-selfhosted.onrender.com` → `gcp-us-west1-1.origin.onrender.com`. | Render origin routing identifies GCP us-west1 (Oregon). This is origin DNS evidence, not geolocation of the shared public ingress IPs. |
| Proxy `proxy.noveld.com.et` | A `213.55.96.150`; root page is a Plesk default page. AFRINIC RDAP identifies the address block as ET, Ethio Telecom. | Ethiopia-registered Ethio Telecom network, Plesk web host. Registration does not prove an exact physical data-center location. API proxy URL configuration is private, so the currently active relay hostname is not independently confirmed. |
| Database | Live diagnostics report configured and ready; no active DB hostname/region is exposed. Repository setup examples use a TiDB `us-east-1` hostname. | Actual database location **unverified**. The example is not deployment evidence. Need the region shown in the DB console or hostname only—not the full connection string. |
| Redis / queues | Live readiness says `REDIS_URL not set — queues disabled`; status says `redisConfigured:false`. | Not configured on the observed API instance; not a verification latency contributor there. |
| Provider backends / OCR | Live status enables eight providers and reports primary verification skipped and one Telebirr relay. | Provider data-center locations and OCR configuration are not disclosed. Service names and company country do not prove hosting location. No real provider requests were sent. |

Sources: live DNS; https://dashboard.noveld.com.et/verify/; https://verify.noveld.com.et/status/summary; https://verify.noveld.com.et/ready; https://proxy.noveld.com.et/; https://rdap.afrinic.net/rdap/ip/213.55.96.150.

## The important route mismatch

`web/src/components/VerifyForm.tsx` submits directly from the browser to:

```
POST ${NEXT_PUBLIC_API_URL}/dashboard/:workspaceId/verify
Authorization: Bearer <session token>
```

The default API base is `https://verifier-api-selfhosted.onrender.com`; its actual build-time override requires the browser Network request URL to confirm. The dashboard is a static client, not a server-side proxy hop for each submission.

In `src/routes/dashboard.ts:656`, this route:

1. Uses session signature validation (`requireSession` in `src/routes/auth.ts`). That middleware does not itself perform a database lookup.
2. Awaits workspace membership lookup.
3. Awaits workspace lookup.
4. Loads billing configuration (a database read on a cache miss).
5. Awaits atomic credit deduction for non-unlimited workspaces.
6. Calls `runSmartVerify`, which calls the selected provider.
7. Returns the result.

These are at least three sequential database operations before the provider for the normal charged path, plus a billing-config query on a cache miss. Operations are not necessarily one SQL statement each; actual statement counts require tracing.

**This path is not mounted under the `/verify-*` verification-result cache or the early `/verify-cbe` validation middleware.** Repeated successful dashboard checks therefore do not benefit from that cache in this source. The earlier API-key/header-auth tests did not benchmark this session-authenticated browser route. In particular, a ~127 ms invalid-CBE rejection in the local lab is not a forecast for a successful browser verification.

The frontend has no intentional four-second delay: it awaits `fetch` and JSON parsing, then displays the result. Cross-origin JSON plus an Authorization header can also require an OPTIONS preflight. The configured CORS middleware has no explicit preflight `maxAge`; whether a given click sends OPTIONS must be checked in DevTools.

## Live database evidence and its limits

The observed instance was newly started: uptime 31 seconds, Node v24.21.0, database mean 312 ms over four startup statements. A later sample at uptime 58 seconds reported six statements, mean 259 ms. Rounded cumulative totals imply about 153 ms average for the two added statements, but background activity and rounding prevent treating this as a request-specific trace. Startup aggregate timings alone are not steady-state verification timings.

Readiness reported true. The public summary exposes no deployed commit SHA; neither the exact deployed source revision nor the user's four-second verification trace is established by these checks.

The sandbox shell still cannot complete TLS to the deployment. Public page-fetch tools could retrieve the endpoints, but their execution time is not a browser/API benchmark. No new GitHub Actions run was initiated.

## Explanation of the reported four seconds

Four seconds is plausible for browser/network time + sequential remote DB work + a real provider/relay fetch (and, for some providers, receipt parsing/browser work). For proxy-backed traffic from an Ethiopian user, the API's Oregon location can mean an Ethiopia → Oregon → Ethiopian relay route, followed by the reverse response path. Exact hop use depends on active private environment configuration and selected provider.

It is **not yet proven** how much of the four seconds belongs to each phase. Nor is there evidence that moving the static frontend alone would solve it.

## What to capture next

- Selected provider and whether first or repeated verification is slow. No receipt details needed.
- Browser DevTools Network: sanitized request origin/path, OPTIONS duration if present, POST duration, and its Timing-tab Waiting/TTFB. Hide Authorization, cookies, account/reference data and response bodies; a full unredacted HAR is unnecessary.
- Database console region, or database hostname only. Do not share DATABASE_URL or credentials.
- Render service region/plan and active relay hostname(s), without keys or query strings, to confirm settings rather than configuration examples.

Then instrument the exact dashboard route with phase timings (authorization/access, billing, provider, total), benchmark that path, and share the verified cache/validation/billing pipeline without weakening authentication, quota enforcement or freshness semantics. Co-locate API/database based on confirmed regions and measured RTT; choose the API region with both the user's network and Ethiopian relay in mind. Do not migrate or delete the existing database merely on the basis of an example hostname.
