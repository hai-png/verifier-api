# Telebirr relay: audit of the 2026-09-27 fixes and the root cause

Written 2026-09-28 after reading every commit on `selfhosted` from
`d27a6ba` (2026-09-27 10:29 +0100) to `899c9fd` (2026-09-28 06:13 +0100),
and every measurement those commits recorded from the relay host.

## TL;DR

* **The fault is per-connection, not per-request.** From the relay host, each
  TCP connection to `transactioninfo.ethiotelecom.et` (196.188.116.120) either
  completes its TLS handshake in ~30 ms, or the ClientHello goes out and
  nothing ever comes back. About half of connections are dead. This was
  measured on 2026-09-27 and recorded in `a3ea1f2`/`fdbbeca`; it was just
  never treated as the fault.
* **Every fix changed how long the relay waited on one connection. None
  changed how many connections it tried.** That is why none of them worked:
  with p(dead) ≈ 0.5, three sequential attempts still fail 12.5% of requests
  outright and burn up to 12 s on the rest.
* **The relay now hedges fresh connections** (2 at once, 900 ms handshake
  deadline, up to 4 rounds). Common case: one 30 ms handshake. Worst case:
  5.7 s. P(all 8 flows dead) ≈ 0.4%.
* **Where the flows die is still unproven** — provider TLS endpoint, route,
  or host — and it decides the permanent fix. `tools/telebirr-tls-probe.php`
  is rewritten to answer that in one ≤20 s run. Run it.

## The evidence, gathered from the commits

All of these were measured on the relay host by the previous fixes.

| Observation | Source |
|---|---|
| Relay host is `proxy.noveld.com.et` = **213.55.96.150**, Ethio Telecom AS24757, Addis Ababa, a shared-hosting /24 with several hundred hosted domains | DNS + ipinfo (this audit) |
| Provider is 196.188.116.120, also Ethio Telecom | seed constant, confirmed by DNS |
| TCP connect to the provider: **0 ms** | `a3ea1f2` (`tcpProbeMs=0`) — physically plausible, same network |
| TLS handshake successes: **26, 38, 1064, 3081, 3319 ms**; failures: nothing received by 4000 ms | `a3ea1f2` |
| 8 consecutive real receipts: 4 at 0.30–0.37 s, 4 at 7.4–12.3 s; a further one failed after three attempts | `fdbbeca` |
| 15 s spacing between requests: 2 of 5 failed outright | `fdbbeca` |
| `domMs=1` on every success; page is 26 KB | `fdbbeca`, `a720256` |
| Provider is TLS 1.2 only (TLS 1.3 → `tlsv1 alert protocol version`, 16 ms, deterministic) | `2d738b7` |
| Host: cURL 7.61.1, OpenSSL 1.1.1k, `max_execution_time=30`, `gethostbyname()` blocks 28–56 s | `2d738b7`, `a3ea1f2`, `dd24901` |
| Render (the API host) cannot reach the provider at all: `timeout of 8000ms exceeded` | `df8afed` |

## Reading the evidence

**The handshake timings are TCP retransmission backoff.** Linux's minimum RTO
is 200 ms, doubling on each loss: 0.2, +0.4, +0.8, +1.6 → cumulative 0.2, 0.6,
1.4, **3.0 s**. The "slow successes" at 3081 and 3319 ms are a handshake packet
lost, retransmitted, lost, retransmitted, lost, retransmitted, and finally
getting through, plus ~80–300 ms for the handshake and page. The next
retransmit would land at 6.2 s, past the 4 s attempt timeout. So there are not
three modes (fast/slow/dead); there are two — live and dead — and "slow" is a
dead flow that a retransmit rescued.

**The 7.4–12.3 s successes in `fdbbeca` are the same thing seen through the
relay's retry loop:** 4 s (dead) + 3.3 s (rescued) = 7.3 s; 4 + 4 + 0.3 = 8.3 s;
4 + 4 + 3.3 = 11.3 s; 4 + 4 + 4.3 = 12.3 s. Every one of those is the relay
waiting the full 4 s on a flow that was dead after its first 100 ms.

**The outcome is fixed at connection setup.** TCP always connects (0 ms), so
SYN/SYN-ACK get through on every flow; the loss starts at the first data
segment. Whatever decides live-vs-dead — an ECMP/LAG member, a load-balancer
backend, a middlebox rule — it keys on the 5-tuple, and a new connection with
a new source port re-rolls it. That is the single actionable property of this
fault, and it points at the fix: **try more flows, not longer waits.**

**"Not rate limiting" was not established.** `fdbbeca` reasoned that because
15 s spacing made things worse, throttling is ruled out. But 213.55.96.150 is a
shared-hosting address with several hundred sites behind it. If the provider's
edge throttles handshakes per source address — and `transactioninfo` is the
most-scraped page in Ethiopian payments, so other tenants on that box very
plausibly scrape it too — our own spacing changes nothing. Throttling of the
shared address remains one of three live hypotheses. It also predicts the
per-flow behaviour (edge accepts TCP, drops or delays the ClientHello).

**DNS was a second, independent fault.** The resolver really does block for
28–56 s and the pinning in `2d738b7`/`a3ea1f2` is correct and kept. But the
flows that die have already connected; the name was resolved before the
handshake started. DNS explains the 34.7 s request in `a3ea1f2` and the
probe hangs; it does not explain a single dead handshake.

## The three remaining hypotheses, and how the probe separates them

| | provider:443 | provider:80 | ethiotelecom.et:443 | outside:443 | meaning | fix |
|---|---|---|---|---|---|---|
| **A** | flaky | clean | clean | clean | provider's TLS endpoint: bad backend behind its balancer, or its edge throttling this address | relay on a different address; report to Ethio Telecom |
| **B** | flaky | flaky | clean | clean | route from this host to 196.188.116.120 (ECMP member, MTU, middlebox) | hosting ticket; relay on a different network |
| **C** | flaky | flaky | flaky | flaky | this host's uplink/NIC/firewall | move the relay |
| **D** | clean | clean | clean | clean | proves nothing (intermittent) | rerun; watch `relayTiming.flows` |

`tools/telebirr-tls-probe.php` runs exactly this table: eight fresh
connections per target, all four targets in parallel per round, every target
by IP literal (no resolver on the path), 2 s handshake deadline, ≤20 s total
against the host's 30 s `max_execution_time`, output flushed per round, and
it prints which row matched.

Whichever row it is, the answer is outside this repository. The hedging in
`verify.php` is the mitigation the code can offer meanwhile, and it is a large
one — but if the probe says **A** with throttling, note that hedging doubles
handshakes per request; `HEDGE_WIDTH` is a constant for that reason.

## Commit-by-commit: why each could not have worked

Times are +0100 as committed.

| Commit | Claimed cause | What it changed | Why it could not fix this |
|---|---|---|---|
| `d27a6ba` 10:29 | one generic transport error | API names the failing relay hop | Reporting only. |
| `0744d48` 11:15 | relay dies silently at `max_execution_time` | shutdown handler, staged 502 | Reporting only. Correct and kept. |
| `4816f35` 11:45 | key drift across FPM workers; SNI-less TLS pre-check | key literal; plain-TCP pre-check | Real bugs, unrelated to handshakes. The TCP pre-check added up to 1–4 s of budget per request for a question (does TCP connect?) whose answer is always yes; now removed. |
| `b3ea86a` 12:06 | OpenSSL 3.x rejects the GlobalSign 2018 chain; provider is TLS 1.3-hostile | pin TLS 1.2, `SECLEVEL=1` | Host is OpenSSL 1.1.1k, level 1 already. The TLS 1.2 pin does save one rejected 1.3 hello per connection and is kept. A dead flow is dead at any TLS version. |
| `6f731cb` 20:50 | large page; unbounded DOM; inverted API/relay budgets | lazy DOM, 1 MB cap, `RELAY_BUDGET_MS`, API 18 s → 12 s | Page is 26 KB, `domMs=1`. The budget inversion was real and its fix is kept, but it changes when the API gives up, not whether the flow is alive. |
| `a720256` 21:22 | packets dropped after ClientHello, "route or MTU blackhole", nothing to fix in code | TLS probe matrix | Closest diagnosis of the day, then abandoned by the next commit. Wrong in one respect: "nothing to fix in code" — a per-flow fault is exactly what client-side hedging fixes. |
| `2d738b7` 21:50 | resolver; `CURLOPT_TIMEOUT` does not bound DNS | `CURLOPT_RESOLVE` + seed, 3 × 2.5 s retries | DNS fix is correct and kept. But sequential retries of 2.5 s kept the shape of the problem: one flow at a time, waiting on it. |
| `a3ea1f2` 22:07 | re-resolve on retry reintroduced the 28 s block; 2 s connect timeout too tight | no resolver on any path; 3 × 4 s | The first half is right. The second half went the wrong way: it **widened** the wait per dead flow from 2 s to 4 s to catch the 3.0–3.3 s retransmit rescues, instead of abandoning the flow at ~1 s and opening a new one with a 50% chance of being live in 30 ms. |
| `fdbbeca` 22:34 | "persistent property of the path"; "not rate limiting" | probe gains a streams sample; docs | Recorded the decisive per-flow data (this document is built on it) but concluded "mitigation only, get a second host". The streams-vs-cURL question cannot distinguish A/B/C. |
| `df8afed` 05:26 | API discarded the relay's 502 body | report 5xx body in the relay's words | Real bug, reporting only, kept. |
| `dd24901` 06:02 | probe exceeded `max_execution_time` | probe cut to cURL-vs-streams | Still answering a question that does not locate the fault. |
| `bd4dd28` 06:07 | can't tell which probe build is deployed | `X-Probe-Version` | Housekeeping. |
| `899c9fd` 06:13 | probe used a hostname in a stream URL → resolver hang | address literal + `peer_name` | Correct, and the third time the same rule was violated; the rule is now in the relay's header comment. |

Pattern: eleven of twelve commits either improved reporting (good, kept) or
tuned the wait on a single connection (ineffective by construction). Each one
was validated against one or two live samples of a 50/50 fault, so each looked
like it worked about half the time — which is exactly the trap a per-flow
fault sets.

## What changed in this commit

* `verify.php` — `RELAY_VERSION=2026-09-28.hedged-flows`. Fetch stage
  rewritten on `curl_multi`: `HEDGE_WIDTH=2` fresh connections per round,
  `CURLOPT_CONNECTTIMEOUT_MS=900` (in libcurl this covers the TLS handshake),
  `CURLOPT_TIMEOUT_MS=3000` per flow, `CURLOPT_FRESH_CONNECT`/`FORBID_REUSE`
  so each flow is a new source port, `MAX_ROUNDS=4`, losers torn down the
  moment one flow completes. TCP pre-check removed. `RELAY_BUDGET_MS` 13.5 s
  → 9 s. Success responses carry `relayTiming.flows`, e.g.
  `r1.1 errno=28 900ms r1.2 ok 41ms tls=33ms`.
* `src/services/verifyTelebirr.ts` — mirrored `RELAY_BUDGET_MS` 9 s,
  default `TELEBIRR_PROXY_TIMEOUT_MS` 16 s → 12 s.
* `tools/telebirr-tls-probe.php` — rewritten to the table above.
* Deploy order still matters: **upload `verify.php` first, then deploy the
  API.** Confirm with the bad-key request that `relayVersion` reads
  `2026-09-28.hedged-flows`.

## What to do next, in order

1. Upload `verify.php`; confirm the version; run ~10 real verifications and
   read `relayTiming.flows` in the API logs. Expect most to be `r1.1 ok` or
   `r1.2 ok`, and the p95 to fall from ~12 s to under 1 s.
2. Upload the probe, run it two or three times across the day, delete it.
   Its last section names the row (A/B/C/D).
3. Act on the row. In all of A/B/C the durable fix is a second relay on a
   different address *and* network (a VPS on Ethio Telecom's cloud or on
   Safaricom Ethiopia, not another shared host on 213.55.96.0/24), configured
   as a second entry in the relay list so the API's hedging and circuit
   breaker finally have something to act on. Only A-with-throttling would make
   `HEDGE_WIDTH=2` a cost worth revisiting; the probe output is the evidence
   to send to Ethio Telecom in that case.
