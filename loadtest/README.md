# Load & latency testing

Zero-dependency harness for measuring the deployed verifier-api and the app in a
synthetic lab. Everything is plain Node (18+) — no k6, no autocannon, no install
step, so it runs on a laptop, in the Render container, or on a GitHub runner.

```
loadtest/
  run.mjs               # load/latency runner (profiles, budgets, reports)
  db-traffic.mjs        # SQL statements per API request (performance_schema)
  seed.mjs              # workspace + API key for lab runs
  stub-upstream.mjs     # fake verify.php / mpesa.php (never touches real providers)
  live-profile.json     # parameters used by push-triggered live runs
  lib/http.mjs          # keep-alive client with connect/TLS/TTFB timings
  lib/scenarios.mjs     # scenario catalogue
  lib/stats.mjs         # percentiles + histogram
  ci/db-latency.sh      # netem: emulate a cross-region database
```

## Quick start (against anything)

```bash
# warm latency of the anonymous surface
node loadtest/run.mjs --base-url https://verify.noveld.com.et --profile latency

# staged ramp, mixed scenarios, with an API key (lab / local runs, where the
# database is reachable and a key can be minted with loadtest/seed.mjs)
node loadtest/run.mjs --base-url https://verify.noveld.com.et \
  --profile load --concurrency 20 --stages 1:10,5:10,10:15,20:15,40:15 \
  --api-key "$VERIFIER_API_KEY"

# ...or against a live deployment, using the dashboard-secret path: it needs no
# database access, just the DASHBOARD_SECRET of the target and the id of any
# existing workspace (the API looks it up and attributes the run to it)
node loadtest/run.mjs --base-url https://verify.noveld.com.et \
  --profile load --stages 1:15,5:15,10:15,25:20,50:20,100:120 \
  --dashboard-secret "$DASHBOARD_SECRET" --workspace-id "ws_…"

# include scenarios that call real providers (opt-in: they hit Ethio Telecom,
# Safaricom and banks, and they consume verification quota)
node loadtest/run.mjs --base-url https://verify.noveld.com.et \
  --profile latency --allow-external --scenarios verify_mpesa_external --api-key "$KEY"

# cold start: idle for 20 minutes first, then measure the wake-up
node loadtest/run.mjs --base-url https://verify.noveld.com.et --profile coldstart --coldstart-sleep 1200
```

Reports land in `loadtest-results/*.md` and `*.json`; the Markdown is also
appended to `$GITHUB_STEP_SUMMARY` when running in Actions.

## Profiles

| Profile | What it does |
|---|---|
| `smoke` | one request per scenario — sanity + availability |
| `latency` | discarded warm-up, then N sequential samples per scenario (clean p50/p95/p99) |
| `load` | closed-loop stages (`--stages c:seconds,…`) — finds the throughput ceiling |
| `soak` | one long fixed-concurrency stage (leak hunting) |
| `coldstart` | sleeps, then measures the first request after an idle period |
| `all` | coldstart + latency + load |

## Scenarios

Anonymous: `health`, `root`, `status_summary`, `ready`, `auth_missing_401`, `auth_invalid_403`.
Authenticated (need `--api-key`, or `--dashboard-secret` + `--workspace-id`):
`verify_validate_400`, `permissions_403`, `verify_mpesa_external`,
`verify_telebirr_external`, `verify_universal_external`.

Two credential modes exist because they answer different questions:

| Mode | Headers | Use it when |
|---|---|---|
| `--api-key sk_live_…` | `x-api-key` | the database is reachable and you can mint a key (`loadtest/seed.mjs`); this is the customer path |
| `--dashboard-secret … --workspace-id …` | `x-dashboard-key` + `x-workspace-id` | measuring a *live* deployment: no database access needed, and it exercises the same auth/quota/billing middleware |

`*_external` scenarios are refused unless `--allow-external` is passed — a load
test must never hammer a real bank, Ethio Telecom or Safaricom, and every
verification consumes quota.

## Budgets (CI gate)

```bash
node loadtest/run.mjs --base-url … --profile latency --budget-p95-ms 1500 --budget-error-rate 0.01
```

Exit code 1 when a budget fails, so the workflow fails the build.

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `loadtest-live` | push (`loadtest/**`) + dispatch | probes the deployed origin, runs the harness from GitHub's network, uploads the report |
| `perf-lab` | push (`src/**`, `loadtest/**`, `prisma/**`) + dispatch | real API + MySQL service container + stubbed relay, API pinned to one CPU, optional netem database latency |

### Authenticated runs are rate limited — pace them

A workspace gets `config.freeRateLimit` requests per fixed 60 s window (default
**10** for FREE, 60 for PRO, 30 for a grandfathered FREE workspace), and the
dashboard path keys its bucket on `workspace+IP`. An unpaced authenticated run
therefore measures the 429 path after the first few requests rather than the
verification path. Pace the sequential profiles to stay inside the window:

```bash
# ~7 authenticated requests per minute, well under a FREE workspace's 10
node loadtest/run.mjs --base-url https://verify.noveld.com.et \
  --profile latency --auth-pace-rps 0.12 \
  --scenarios health,ready,verify_validate_400 \
  --dashboard-secret "$DASHBOARD_SECRET" --workspace-id "$WORKSPACE_ID"
```

`--auth-pace-rps` only delays scenarios in the `authenticated` group; anonymous
ones run at full speed. The load profile ignores pacing on purpose — a staged
ramp is how you find the throttle boundary, and the report counts `throttled_429`
separately from errors.

If the credentials are wrong the run still "passes" — every authenticated
sample is just a 401 — so the harness checks for that and prints
`warning: every authenticated scenario returned 401: …`, sets `authHint` in the
JSON/markdown report, and the workflow raises a `::warning::` annotation. The
status codes map to causes like this: 401 = the service ignored the credentials
(wrong `DASHBOARD_SECRET`, or an inactive `x-api-key`), 404 = the dashboard
workspace id does not exist on that deployment, 402 = out of credits, 429 =
pacing too fast for the workspace rate limit.

`loadtest-live` uses whichever credentials exist (Settings → Secrets and
variables → Actions), preferring in this order:

| Secret | What it is |
|---|---|
| `LOADTEST_API_KEY` | a seeded `sk_live_…` key (only useful if the target's database is reachable) |
| `LOADTEST_DASHBOARD_SECRET` + `LOADTEST_WORKSPACE_ID` | the dashboard path — the one used for live runs |

With no credentials at all the workflow still measures the anonymous surface and
logs a warning; requests that need a workspace are skipped.

## Where the round trips go

`loadtest/db-traffic.mjs --timeline` prints the ordered SQL sequence of one
request (from `performance_schema.events_statements_history_long`), and every
instance also reports its own counters on `GET /status/summary`:

```bash
# 10 M-Pesa verifications, then read the delta of the instance's own counters
curl -s http://127.0.0.1:3001/status/summary | jq .diagnostics.database
```

Measured on a post-fix build (60 ms round trip):

| Path | Statements before the response | Statements after it |
|---|---|---|
| `GET /health` | 0 | 0 |
| `GET /ready` | 1 (`SELECT 1`) | 0 |
| `POST /verify-cbe`, unknown key | 1 (key lookup) | 0 |
| `POST /verify-mpesa`, success | ~3 (key lookup, credit decrement, config read) | ~4 (analytics + key-usage batches, delivery-target lookup, or the credit refund on a failure) |

The app-side figure is higher than the statement count the MySQL tool reports
(~3 for the success path) because it also includes the batched
analytics/usage writes that finish after the response — they do not delay the
customer, but they do compete for the connection pool.

## Interpreting results

- `TTFB` is time to first byte as seen by the client; `Total` includes body read.
- `ready` includes one database round trip — compare it with `health` to read the
  database's contribution to latency.
- `throttled_429` and `quota_402` are reported separately from errors: they are
  policy outcomes, not failures.
- The load profile's last stage is usually the saturation point; the per-second
  timeline shows when latency starts climbing.
