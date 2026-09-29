# Load test findings (summary)

The load-test **workflows have been removed** and the generated reports deleted
from this repository. This file is the surviving record of what they measured.

The harness itself is still in `loadtest/` and still runnable by hand — see
[Reproducing](#reproducing) below. Only the automation and its 5.8 MB of
committed output are gone.

## What these numbers are, and are not

These are **lab** numbers, not production:

- 4 vCPU GitHub Actions runner, Node 24, Linux x64
- Local MySQL 8 in a service container, not TiDB
- A **stubbed** relay (`loadtest/stub-upstream.mjs`) with 400 ms of injected
  delay, not Ethio Telecom
- The API pinned to a single CPU (`pin_cpu: true`) so results are comparable
  between runs
- `VERIFY_CACHE_TTL_MS=0`, so the full provider path is measured rather than
  repeated positive cache hits

So treat the absolute numbers as "what this configuration does", not as a
capacity promise for the deployed service. The relative shape is the useful
part.

## Cold start

| Measure | Value |
|---|---|
| Container start → `/ready` answers | 3.01 s |
| First request TTFB (API already up) | 68.4 ms |
| First **authenticated** request | 1.07 s |

The 1.07 s gap over 68 ms is lazy first-use work: middleware, Prisma client
warm-up, and the first real provider-path code path. This is the cost a free
tier pays after a spin-down.

## Latency, sequential and warm (25 iterations × 9 scenarios)

| Scenario | p50 (ms) | p95 (ms) |
|---|---|---|
| `health` | 0.7 | 1.3 |
| `root` | 0.7 | 1.0 |
| `status_summary` | 0.6 | 1.1 |
| `ready` | 62.3 | 63.0 |
| `auth_invalid_403` | 63.0 | 63.7 |
| `verify_validate_400` | 124.0 | 125.0 |
| `permissions_403` | 123.8 | 125.8 |
| `verify_telebirr_external` | 714.8 | 762.4 |
| `verify_mpesa_external` | 710.6 | 771.5 |

Two things worth keeping:

1. **The 62 ms floor on `ready` and `auth_invalid_403` is a single database round
   trip, not application work.** Those endpoints issue 0.00–0.20 statements per
   request (below), and 62 ms is almost exactly the measured local MySQL
   round-trip time. On the deployed service, against a remote TiDB, this floor
   is the cross-region database latency and it is the dominant per-request cost
   on every authenticated path.
2. **The ~710 ms on the external scenarios is the injected stub delay**, not API
   cost. It is 400 ms of stub plus the same ~62–124 ms of database work, twice
   (rate limit, then quota), which is why it lands near 710 ms rather than 400.

## Load stages (15 s each)

| Concurrency | RPS | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Errors |
|---|---|---|---|---|---|---|
| 1 | 5.2 | 63.2 | 714.3 | 741.0 | 769.2 | 0 |
| 5 | 23.9 | 65.4 | 739.3 | 796.4 | 893.6 | 0 |
| 10 | 40.9 | 121.4 | 852.6 | 957.4 | 1017.5 | 0 |
| 20 | 40.3 | 365.1 | 1442.8 | 1625.1 | 1710.3 | 0 |
| 40 | 36.7 | 916.7 | 2850.4 | 3100.2 | 3280.3 | 0 |

**Throughput saturates at about 40 rps around c=10, and past that the system
buys nothing but latency.** From c=10 to c=40 the request rate *falls* (40.9 →
36.7) while p50 rises 7.5× (121 → 917 ms). That is a queued, serialized
resource rather than CPU exhaustion — with the API pinned to one core and every
authenticated path waiting on the database, the database connection pool is the
thing giving.

There were **zero errors, zero 429s and zero 5xx at every stage** across roughly
4500 requests. Nothing shed load; it just got slower, which is the healthier
failure mode.

At c=40 the per-scenario spread shows where the time goes:

| Scenario | p50 (ms) at c=40 |
|---|---|
| `health` / `root` / `status_summary` | 0.4–0.5 |
| `ready` | 486.8 |
| `auth_invalid_403` | 729.2 |
| `verify_validate_400` | 1038.7 |
| `permissions_403` | 980.7 |
| `verify_telebirr_external` | 2606.8 |
| `verify_mpesa_external` | 2634.5 |

The unauthenticated endpoints stay sub-millisecond even at c=40. Everything
that touches the database degrades, roughly in proportion to how many round
trips it makes.

## Database statements per request

| Scenario | API key | Dashboard secret |
|---|---|---|
| `health` | 0.00 | — |
| `auth_invalid_403` | 0.00 | — |
| `permissions_403` | 0.20 | — |
| `ready` | 0.20 | — |
| `verify_validate_400` | 0.40 | 1.20 |
| `verify_mpesa_external` | 3.20 | — |
| `verify_telebirr_external` | 3.60 | — |

This is the number to plan capacity against. A verification costs **3.2–3.6
statements**; a rejected-early request costs **0**. Because the count is low
even on the hot path, the cost is dominated by *latency per round trip* rather
than by query count — which is exactly why a remote database is the thing to
watch, and why `DEPLOYMENT.md` recommends co-locating the API with TiDB.

The dashboard-secret path costs 3× an API key on `verify_validate_400` (1.20 vs
0.40) because it resolves a workspace by secret before it can reject the
payload.

## What was removed, and why that is safe

`loadtest-results/` held 188 files (5.8 MB) across 36 runs: per-run JSON and
Markdown reports plus a `lab/` directory of raw server logs, SQL timelines and
per-scenario JSON. Every run was additive and superseded the last, and the
runner re-published a full report on every push that touched `src/`, `prisma/`
or `loadtest/`. The commit history therefore carried several megabytes of
superseded output, and the committed `api-restart.log` contains request bodies
including a 6-character API key prefix — which is precisely the kind of thing
that should not sit in a repository indefinitely.

The findings above are the part worth keeping.

## Reproducing

The harness is unchanged and needs no workflow:

```bash
# start a stubbed relay and the API, then:
node loadtest/run.mjs \
  --base-url http://127.0.0.1:3001 \
  --profile all \
  --label manual \
  --api-key "$LOADTEST_API_KEY" \
  --iterations 25 --concurrency 10 --duration 15 \
  --stages "1:10,5:10,10:15,20:15,40:15" \
  --out-dir loadtest-results
```

`loadtest-results/` is now git-ignored, so a manual run will not be committed by
accident. `loadtest/db-traffic.mjs` reproduces the statements-per-request table
on its own, and `loadtest/ci/summarize.mjs` renders the same Markdown report
that used to be published to the branch.

Parameter defaults that the removed workflows read from versioned files
(`loadtest/lab-profile.json`, `loadtest/live-profile.json`) are still in place,
so a re-created workflow can pick them up unchanged.
