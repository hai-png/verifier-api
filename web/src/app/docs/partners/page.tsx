import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next, API_HOST } from "@/components/Docs";

export default function PartnerProvisioning() {
  return (
    <>
      <DocH>Partner provisioning</DocH>
      <DocLead>
        One call provisions a merchant into their own workspace: owner, API key, payout account.
        For partner platforms launching sellers on this service.
      </DocLead>

      <DocH2>How a merchant gets an account</DocH2>
      <DocP>
        Instead of merchants signing up, your platform provisions them. Send{" "}
        <code>POST /internal/provision</code> with your partner bearer secret — a workspace is
        created (or reused), the owner user is linked, a fresh <code>sk_live_</code> API key and
        the payout account are returned in one response. The raw API key is shown only once.
      </DocP>
      <DocP>
        The call is idempotent on <code>(partner, externalId)</code>: the first call for a
        merchant returns <code>201</code>, every replay returns <code>200</code> with a freshly
        minted key and the workspace it belongs to. A replay never changes the plan — upgrades
        are a separate operation. The owner resolves by <code>ownerEmail</code>, then{" "}
        <code>ownerTelegramId</code>; if neither matches, a synthetic owner is created whose
        only login path is Telegram.
      </DocP>
      <Code
        code={`curl -X POST ${API_HOST}/internal/provision \\
  -H "Authorization: Bearer $PARTNER_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{
    "externalId": "shop-1",
    "partner": "your-slug",
    "workspaceName": "Hanna Boutique",
    "ownerName": "Hanna Tesfaye",
    "ownerTelegramId": "556677",
    "plan": "free",
    "payout": {
      "label": "Main account",
      "accountHolderName": "Hanna Tesfaye",
      "providersAllowed": ["telebirr", "cbe"],
      "providerAccounts": { "telebirr": "0911223344", "cbe": "1000123456789" }
    }
  }'`}
      />
      <Code
        code={`{
  "ok": true,
  "workspaceId": "ws_…",
  "apiKey": "sk_live_…",          // only ever sent once
  "apiKeyId": "…",
  "payoutAccountId": "…",
  "payoutAccounts": [ "…same shape as POST /payouts…" ],
  "created": true
}`}
      />
      <Endpoint method="POST" path="/internal/provision" desc="Create or replay a merchant workspace + owner + key + payout account." />
      <Endpoint method="POST" path="/internal/workspaces/{externalId}/api-keys" desc="Mint another API key for a provisioned merchant." />
      <Endpoint method="GET" path="/internal/workspaces/{externalId}" desc="Workspace summary — key prefixes, payout accounts. Contains no secrets." />

      <DocH2>Errors</DocH2>
      <DocP>
        <code>401</code> with a bare <code>&quot;unauthorized&quot;</code> body means the bearer
        secret is wrong or unset (the surface is disabled, not open). <code>422</code> with{" "}
        <code>invalid_request</code> covers validation problems, including a{" "}
        <code>partner</code> slug outside the server&apos;s allow-list.
      </DocP>

      <DocH2>What to tell your merchants</DocH2>
      <DocP>
        With a <code>ownerTelegramId</code> supplied, the owner can sign into the dashboard with
        Telegram (no password needed) and verify payouts / run verification there, or call the
        API with their key from their own server.
      </DocP>
      <Next href="/docs/authentication" label="Authentication" />
    </>
  );
}
