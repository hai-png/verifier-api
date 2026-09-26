# Load & latency testing

Zero-dependency harness for measuring the deployed verifier-api and the app in a
synthetic lab. Everything is plain Node (18+) — no k6, no autocannon, no install
step, so it runs on a laptop, in the Render container, or on a GitHub runner.

```
loadtest/
  run.mjs               # load/latency runner (profiles, budgets, reports)
  db-traffic.mjs        # SQL statements per API request (MySQL general_log)
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

# staged ramp, mixed scenarios, with an API key
node loadtest/run.mjs --base-url https://verify.noveld.com.et \
  --profile load --concurrency 20 --stages 1:10,5:10,10:15,20:15,40:15 \
  --api-key "$VERIFIER_API_KEY"

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
Authenticated (need `--api-key`): `verify_validate_400`, `permissions_403`,
`verify_mpesa_external`, `verify_telebirr_external`, `verify_universal_external`.

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

`loadtest-live` needs the repository secret `LOADTEST_API_KEY` for the
authenticated scenarios (Settings → Secrets and variables → Actions). Without
it the anonymous surface is still measured end to end.

## Interpreting results

- `TTFB` is time to first byte as seen by the client; `Total` includes body read.
- `ready` includes one database round trip — compare it with `health` to read the
  database's contribution to latency.
- `throttled_429` and `quota_402` are reported separately from errors: they are
  policy outcomes, not failures.
- The load profile's last stage is usually the saturation point; the per-second
  timeline shows when latency starts climbing.
