# Deployment performance review — 26 September 2026

## Executive summary

Target: **https://verify.noveld.com.et**, confirmed by the owner as an isolated test target. Live tests ran from GitHub Actions, not from Ethiopia. The Arena sandbox could resolve DNS but could not establish TLS to either the custom hostname or the Render hostname; its failed connection timings are **not server latency measurements**.

The live service handled **9,655 anonymous/rejection-path requests with zero observed HTTP/transport errors**. Throughput flattened around **131–133 requests/second**. Doubling concurrency from 25 to 50 increased p95 from **402 ms to 893 ms**, for only a 1.5% throughput gain. This is a workload-specific, short-run saturation observation, not an SLA or real-payment capacity claim.

Authenticated malformed CBE requests were unnecessarily reserving credits before validation. The branch now validates after authentication/rate limiting but before quota reservation. In the first post-fix synthetic lab, CBE validation p95 was **131 ms**, versus **369 ms** in the earlier same-topology report (about 64% lower). This is a historical comparison, not a controlled paired production experiment; the older harness also included warmups.

**Code changes are on `arena/01a0dd05-verifier-api`; they have not been deployed to the live service.** Live reruns still characterize the currently deployed service, not these fixes.

## Evidence

| Run | Scope | Evidence |
|---|---|---|
| 36238798670 | Live paced latency; 25 measured samples per scenario | [Report](../live-latency-2026-09-26T11-30-15-568Z.md), [JSON](../live-latency-2026-09-26T11-30-15-568Z.json), [Actions](https://github.com/hai-png/verifier-api/actions/runs/36238798670) |
| 36238851511 | Live anonymous ramp: 1/5/10/25/50 workers | [Report](../live-load-2026-09-26T11-32-20-867Z.md), [JSON](../live-load-2026-09-26T11-32-20-867Z.json), [Actions](https://github.com/hai-png/verifier-api/actions/runs/36238851511) |
| 36238851505 | First CBE-fix lab: real MySQL, 30 ms one-way injected DB latency, 400 ms stub relay, API pinned to one CPU | [Report](../lab-all-2026-09-26T11-32-40-172Z.md), [Actions](https://github.com/hai-png/verifier-api/actions/runs/36238851505) |
| Historical lab | Same configured topology, before this branch | [Report](../lab-all-2026-09-26T09-13-54-725Z.md) |

### Live warm latency baseline

175 measured requests; 21 warmups excluded; no observed errors or throttles. Authenticated requests paced at 0.12 requests/second.

| Endpoint/path | Total p50 | Total p95 |
|---|---:|---:|
| `/health` | 83.6 ms | 114.6 ms |
| `/` | 75.2 ms | 91.4 ms |
| `/status/summary` | 75.8 ms | 85.0 ms |
| `/ready` | 227.2 ms | 238.0 ms |
| Missing API key | 75.6 ms | 78.4 ms |
| Unknown API key | 232.3 ms | 241.0 ms |
| Authenticated malformed CBE | 912.4 ms | 1,190.6 ms |

The ~150 ms readiness overhead relative to metadata is consistent with expensive database round trips. It does not, by itself, prove which database region or pool setting is responsible. Client network latency also differed between GitHub runners (~35–85 ms baseline).

### Live load ramp

Equal-ring mix of health, metadata, status summary, readiness, missing key and fresh unknown key. No real bank/telecom calls. Although credentials were available to the workflow, these six scenarios do not use them.

| Concurrent workers | Requests | Observed RPS | Total p95 | Total p99 | Errors |
|---:|---:|---:|---:|---:|---:|
| 1 | 144 | 9.5 | 213.5 ms | 230.3 ms | 0 |
| 5 | 623 | 40.9 | 217.2 ms | 375.3 ms | 0 |
| 10 | 1,536 | 76.0 | 223.3 ms | 752.0 ms | 0 |
| 25 | 3,308 | 130.6 | 401.9 ms | 800.5 ms | 0 |
| 50 | 4,044 | 132.6 | 893.0 ms | 1,097.2 ms | 0 |

At 50 workers, readiness and unknown-key p95 were approximately 1 second, while health p95 also rose to 409 ms. That indicates broader queueing/resource pressure, not just a slow readiness query. Isolated outliers reached 4 seconds earlier in the ramp. No server CPU/pool trace was captured during the live ramp, so attributing saturation to a particular resource would be speculative.

## Final verification

- **Final lab passed:** [run 36239443093](https://github.com/hai-png/verifier-api/actions/runs/36239443093), [report](../lab-all-2026-09-26T11-44-01-550Z.md), [JSON](../lab-all-2026-09-26T11-44-01-550Z.json).
- **Final live latency passed:** [run 36239410563](https://github.com/hai-png/verifier-api/actions/runs/36239410563), [report](../live-latency-2026-09-26T11-42-49-970Z.md). Its 175 measured requests had no observed errors. Health p95 was 59 ms, readiness 197 ms, unknown-key rejection 219 ms, and malformed-CBE rejection **1,315 ms**. Different runner/network conditions changed baseline latency; the un-deployed application fixes cannot account for this difference.

The final lab used the corrected **successful Telebirr fixture**, deliberately negative M-Pesa fixture, real MySQL, ~60 ms injected DB round trip, 400 ms relay delay, one CPU and one test workspace. Result caching was disabled. All 25 sequential Telebirr responses were HTTP 200 and the dedicated success assertion passed. M-Pesa HTTP 200 still represents a negative business result.

| Final lab measurement | Result |
|---|---:|
| Measured sequential + load requests (excluding readiness warm probes) | 2,459 |
| HTTP/transport errors | 0 |
| Malformed-CBE total p95 | **127.3 ms** |
| Uncached synthetic Telebirr total p95 | **776.4 ms** |
| Mixed load, 10 workers | **40.9 RPS**, p95 **851.6 ms** |
| Mixed load, 20 workers | **40.1 RPS**, p95 **1,502.9 ms** |
| Mixed load, 40 workers | **36.5 RPS**, p95 **2,850.9 ms** |

The synthetic mix saturates near 10 workers under these constraints. A single workspace can also concentrate contention on its credit row. This is **not 41 successful verifications/second**: the ring also contains public, authentication and policy-rejection requests. The final lab changed the Telebirr outcome and cache configuration, so its capacity cannot be used as an isolated A/B estimate of the readiness-coalescing change. The unit tests establish coalescing and recovery correctness.

## Findings and disposition

| Priority | Finding | Action / status |
|---|---|---|
| High | Invalid CBE requests pay for quota reservation and refund | **Fixed in branch.** Shared validation covers GET, HEAD and POST, preserves legacy/link/new-reference acceptance, and runs after auth/throttling. Successful requests retain quota enforcement. First lab p95 131 ms versus historical 369 ms. Deploy and repeat live validation to confirm. |
| High | Database round-trip overhead dominates DB-backed paths | **Deployment action pending.** Confirm API and DB regions and connection RTT; co-locate them where feasible. Do not increase pool size blindly or cache authorization/credit balances to hide the problem. |
| High | Throughput plateaus while tail latency grows | **Operational limit identified.** For this anonymous mix, 25 workers is near the measured throughput knee; 50 offers almost no benefit. Keep normal operation below saturation with headroom. Authenticated/provider workloads need separate limits. Scale compute/DB only after observing CPU, pool waits and event-loop delay. |
| Medium | Concurrent readiness probes each consume a DB operation | **Fixed in branch.** Share only the in-flight database check. No TTL and no completed success/failure cache; the next check always performs fresh work. Unit tests cover 100 callers, failure fan-out and recovery. |
| High | Harness could report invalid measurements as passing | **Fixed.** Warmups excluded; expected HTTP contracts enforced; all-failure and rejected-auth runs fail; healthy anonymous requests cannot conceal rejected test credentials. Deliberate permission failures are not misdiagnosed as invalid keys. |
| Medium | Timing/reporting defects | **Fixed.** Wall-clock timeout includes queueing/streaming; fresh unknown key per request; stage timeline offsets do not overlap; sequential throughput includes pacing; RSS uses the OS high-water mark. Numeric/profile inputs validated before traffic. |
| Medium | Lab Telebirr fixture produced 404 instead of exercising success | **Fixed fixture and CI assertion.** Corrected receipt labels, assert real-parser success, disable positive-result caching in the lab so the full provider path is exercised. Earlier lab provider results must not be treated as successful-verification capacity. |
| Medium | FREE workspace `/products` scenario yields 402, not its historical `permissions_403` name | **Documented measurement limitation.** This is the tier-entitlement gate, not an API-key permission measurement. Policy responses remain separately classified. Use a paid test workspace to isolate the 403 permission path. |
| Medium | M-Pesa lab returns HTTP 200 with a negative business result | **Explicitly scoped.** It is a negative-receipt fixture, not successful PDF-verification capacity. No real M-Pesa load was sent. PDF/browser/OCR positive-path benchmarking remains separate work. |
| Medium | M-Pesa info log included relay URL containing its proxy key | **Fixed in branch.** Log source name only, not the URL. This does not purge historical logs; if production logs exposed real proxy keys, review access and rotate those keys. |
| Low | Publisher copied every historical report into both live and lab folders | **Fixed future publishing.** Root reports are the source of truth; auxiliary diagnostics remain per-label. Existing historical duplicates were not deleted. |
| High | CI failure could annotate an old checkout report as current evidence | **Fixed.** Reports carry a workflow run ID; annotation selection requires the current ID. Build/test failures are captured separately. No old report is accepted as evidence of a failed run. |
| Medium | Build script silently ignored TypeScript errors | **Fixed.** Removed `tsc || true`; strict compilation now gates builds. Local strict typecheck passed. |
| Low | Obsolete push-triggered runs could queue unnecessary live traffic | **Fixed.** New live workflow revisions cancel obsolete runs on the same branch. Default profile restored to paced latency, not the capacity ramp. |

## Validation and limitations

- **Nine** zero-dependency harness regression tests passed locally (including rejection of stale CI reports).
- All **50** tests in the repository test command passed locally after generating a no-engine Prisma client; `tsc --noEmit` also passed. No local database benchmarks used that no-engine client.
- The corrected synthetic Telebirr fixture passed through the real parser locally.
- Final CI run **36239443093 passed**: strict build, all 50 repository tests, harness tests, real-MySQL startup, synthetic-success assertion, and latency/load profiles. [Build/test output](../lab/build-test.txt).
- Prisma engine downloads were blocked locally; generating the client without runtime engines enabled strict compilation and the unit suite. Real-engine startup/database validation runs in CI. The build script no longer swallows TypeScript errors. A CI configuration error initially disabled the verification cache for unit tests as well as load tests; this was reproduced locally and corrected by isolating the unit-test cache setting.
- HTTP success is not necessarily business verification success. M-Pesa negative results and entitlement responses are called out above.
- Closed-loop ramps reduce arrivals as the server slows; these are not open-arrival-rate stress tests. Short stages and 25 sequential samples are insufficient for long-term availability or reliable extreme-tail estimates.
- No live provider load, destructive operations, actual cold-start/idle measurement, or prolonged soak test was performed. The lab `all` profile's zero-idle readiness probes are not cold starts.
- MySQL performance-schema tooling undercounts some prepared statements; its fractional statement estimates must not be interpreted as an exact per-request SQL count. Use Prisma counters and request-scoped tracing for confirmation.

## Deployment and acceptance checklist

1. Deploy the reviewed branch through the normal deployment process; record the deployed commit and API/DB regions.
2. Repeat paced authenticated malformed-CBE latency (25+ measured samples). Confirm 400 responses, no provider calls and no credit-reservation/refund writes for invalid input. Verify valid CBE requests still charge normally.
3. Confirm readiness failure/recovery against a controlled DB outage in staging; concurrent probes should share one operation, but subsequent probes must not reuse stale results.
4. Repeat the exact anonymous ramp from the same region. Initial comparison budgets: p95 <500 ms at 25 workers, HTTP/transport error rate <1%, and no unexplained worsening of endpoint p99. These are proposed review budgets, not existing SLAs.
5. Measure successful, uncached authenticated verification separately using local stubs and a dedicated workspace. Keep real-provider calls low-volume and explicitly approved. Include CBE browser/PDF and OCR paths before claiming whole-product capacity.
6. Co-locate API and DB if the ~150 ms round-trip overhead is confirmed; compare readiness-minus-health latency before and after. Inspect database connection wait time, CPU and event-loop delay while ramping.
7. After improvements, run an approved 15–30 minute soak below the measured throughput knee, with server memory/pool telemetry. Set capacity and alerts from that evidence, not from the anonymous 133 RPS figure alone.
