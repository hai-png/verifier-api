# AGENTS.md

Guidance for AI agents and new contributors working in this repository. Everything
below is verified against the current tree — commands are the real ones, and the
invariants are the ones the test suite and CI enforce.

> This file previously described a `graphify` knowledge graph and told agents to run
> `graphify query` / `graphify update .`. Neither the tool nor `graphify-out/` exists
> in this repository, so every one of those commands failed. It has been replaced
> with instructions that work.

## What this is

A TypeScript/Express 5 payment-verification API for Ethiopian payment providers
(telebirr, CBE, Dashen, Bank of Abyssinia, Awash, Zemen, M-Pesa) plus receipt-image
OCR. Prisma/MySQL (TiDB in production), BullMQ/Redis for webhooks and notifications,
Puppeteer for the CBE flow, winston for logging.

Node `>=24`, pnpm `11.0.0` (`corepack enable` if `pnpm` is missing).

## Commands

```bash
pnpm install                  # see the PUPPETEER_SKIP_DOWNLOAD note below
pnpm typecheck                # prisma generate + tsc --noEmit
pnpm build                    # prisma generate + tsc -> dist/
pnpm test                     # build, then node --test dist/tests/*.test.js
pnpm dev                      # nodemon + ts-node
```

Run tests directly (skipping the rebuild) with:

```bash
LOG_TO_FILES=false node --test dist/tests/*.test.js
```

`LOG_TO_FILES=false` matters: without it every test run writes log files into the
working tree. The suite is **172 tests across 35 files** and must stay green.

The dashboard in `web/` is a **separate npm project** with its own lockfile. It is
*not* part of the pnpm workspace (`pnpm-workspace.yaml` declares no packages), so
root commands never touch it:

```bash
cd web && npm ci && npx tsc --noEmit && npm run build
```

CI covers both (`verify` job for the API, `dashboard` job for `web/`).

## Sandbox / offline gotchas

These bite in any environment without unrestricted network egress:

- **`pnpm install` downloads Chrome** via Puppeteer's postinstall. Set
  `PUPPETEER_SKIP_DOWNLOAD=true` when headless browser tests are not the target:
  `PUPPETEER_SKIP_DOWNLOAD=true pnpm install`. CI installs the real Chromium because
  the CBE flow needs it.
- **`prisma generate` fetches query-engine binaries** from `binaries.prisma.sh`.
  Where that is blocked, `pnpm typecheck`/`build`/`test` all fail at the generate
  step, not at your code. Workaround: materialise the generated client into
  `node_modules/.prisma/client/` by hand (a stub covering the models, relation
  types, `$transaction` overloads and `PrismaTransactionClient` is enough for
  typechecking).
- **`node --test <directory>/` is broken on Node 22+.** Pass the glob
  `dist/tests/*.test.js` instead — that is what `pnpm test` does.
- A test that returns a promise which never settles reports as
  `cancelled ... fail 0`. **Check the cancelled count**, not just the fail count.

## Invariants — do not regress these

Each of these was a real defect that got fixed; CI or the suite catches some, but
not all.

1. **No hardcoded third-party origins.** The dashboard used to fall back to a Render
   host this repo does not control, in six files, on a branch whose purpose is
   self-hosting — so a fork that forgot one environment variable posted its users'
   credentials to a stranger. `web/src/lib/config.ts` is the only file that reads
   `NEXT_PUBLIC_API_URL`, and it defaults to same-origin. CI fails if a fallback or
   a third-party host is reintroduced. `NEXT_PUBLIC_*` is inlined into the client
   bundle at build time: the build is the last chance to notice where credentials go.
   The same variable drives the deployed CSP — `npm run build` runs
   `web/scripts/write-headers.mjs` after `next build` to pin
   `connect-src 'self' <that origin>` in `out/_headers`. `web/public/_headers` must
   stay `connect-src 'self'`: that is the fail-closed default, and it is what
   deploys if the script is ever skipped. Never add an origin or a wildcard to it by
   hand — the wildcard it used to carry authorized the token to any app on a
   third-party PaaS.
2. **`verified` means something authoritative confirmed the payment.** On
   `/verify-image`, an OCR read alone never sets it — `verified` is `true` only for
   the 8 provider types with an upstream API, and the response always carries a
   `verification` block (`method`, `authoritative`, `outcome`, `checks`). `checks`
   uses `null` for "you did not ask", never conflating it with `false`.
   `trustOcr` / `OCR_TRUST_IMAGES` is the opt-in legacy shorthand and every use is
   logged. See `CHANGELOG.md` — this is a breaking change from `3.0.3`.
3. **A provider rejection is final.** There is no fallback from `provider_api` to
   the image read, because a fallback lets a forged picture win whenever the real
   check fails.
4. **Session tokens and webhook secrets are never stored in plaintext.** Tokens are
   SHA-256 hashed (`hashSessionToken`); webhook secrets are AES-256-GCM under
   `WEBHOOK_SECRET_KEY` with a `v2.` prefix (`encryptSecret` / `isEncryptedSecret`,
   `migrateLegacyWebhookSecrets` for old rows).
5. **Client IP resolution is configured, not assumed.** `CLIENT_IP_SOURCE`
   (`auto|cf-connecting-ip|x-forwarded-for|socket`) governs rate limiting and admin
   IP checks. Trusting an unvalidated `X-Forwarded-For` lets a caller spoof its way
   past a rate limit; ignoring a real proxy breaks every client's IP.
6. **The version reported at `GET /` comes from `package.json`**, read at startup.
   Do not reintroduce a version literal in `src/index.ts`.
7. **`.env.example` documents every variable the code reads.** If you add an env
   var, add it there. Several are load-bearing for security posture:
   `WEBHOOK_SECRET_KEY`, `CLIENT_IP_SOURCE`, `CLOUDFLARE_INGRESS_SECRET`,
   `INSECURE_TLS_HOSTS`, `TLS_CA_BUNDLE_PATH`, `OCR_TRUST_IMAGES`,
   `LOG_REQUEST_BODIES`, `MPESA_FALLBACK_URL`.

## Conventions worth knowing

- **Express 5 overload trap:** a multi-handler `router.post(...)` resolves to the
  union rest-parameter overload, and an unannotated arrow function parameter then
  becomes implicit `any`. Annotate: `(req: Request, res: Response, next: NextFunction)`.
- Receipt images are redacted before being returned or logged
  (`redactReceiptRecord`, `redactPii`) — the model's output may contain a payer name
  read off an arbitrary image.
- Image credits are refunded when the failure is ours (503/502 infrastructure) and
  not when the read succeeded and the provider then rejected the reference.
- `scripts/reset-db.js` defaults to a dry run; destructive mode requires an explicit
  flag. Keep it that way.
- Temp uploads are unlinked in a `finally` block — preserve that when touching the
  image route.

## Reference

`REVIEW.md` at the repository root is the full audit: every finding, its severity,
what was changed, and what was deliberately left open. `CHANGELOG.md` carries the
integrator-facing summary under `[Unreleased]`.
