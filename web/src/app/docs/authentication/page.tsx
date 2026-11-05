import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next } from "@/components/Docs";

export default function Authentication() {
  return (
    <>
      <DocH>Authentication</DocH>
      <DocLead>Three credentials for three audiences: integrations, browsers, operators.</DocLead>

      <DocH2>API keys (server integrations)</DocH2>
      <DocP>
        Send the key in the <code>x-api-key</code> header on every verification and commerce
        request. Keys are workspace-scoped and carry permissions (<code>verify</code>,{" "}
        <code>webhooks</code>, …). Create and revoke them in the dashboard — the raw key is shown
        only once.
      </DocP>
      <Code code={`x-api-key: sk_live_9f2c…`} />

      <DocH2>Session tokens (dashboard browser)</DocH2>
      <DocP>
        The dashboard logs in via <code>POST /auth/login</code> and sends the returned token as{" "}
        <code>Authorization: Bearer</code>. Session routes live under <code>/auth</code>,{" "}
        <code>/workspaces</code> and <code>/dashboard</code>.
      </DocP>
      <Endpoint method="POST" path="/auth/signup" desc="Create user + workspace, returns a session token." />
      <Endpoint method="POST" path="/auth/login" desc="Validate credentials, returns a session token." />
      <Endpoint method="GET" path="/auth/me" desc="Current user + workspaces (Bearer token)." />
      <Endpoint method="POST" path="/auth/logout" desc="Invalidate the current session." />

      <DocH2>Admin key (operators)</DocH2>
      <DocP>
        <code>x-admin-key</code> unlocks <code>/admin/*</code> (workspace tiers, credit overrides,
        assisted password resets). Never ship it to browsers or client apps.
      </DocP>

      <DocH2>Telegram sign-in</DocH2>
      <DocP>
        Users can sign in with Telegram instead of email: the dashboard&apos;s &quot;Continue
        with Telegram&quot; button and Telegram Mini App single sign-on both call{" "}
        <code>POST /auth/telegram</code>. The signed payload Telegram produces is verified
        against Telegram&apos;s own algorithms and must be no older than 24 hours.
      </DocP>
      <Endpoint method="POST" path="/auth/telegram" desc="Sign in (or register) with a Telegram payload; returns the same nvd_sess_ session token as email login." />
      <DocP>
        Two payload shapes are accepted. The Login Widget posts the user object directly —{" "}
        <Code inline code={`{"id":424242,"first_name":"Marta","username":"marta_bekele","auth_date":1735689600,"hash":"…"}`} />
        . A Mini App forwards its raw <code>initData</code> query string —{" "}
        <Code inline code={`{"initData":"auth_date=…&user=…&hash=…"}`} />. On success the
        response is the email-login shape plus <code>&quot;created&quot;</code>: the first sign-in
        creates the account with no email and no password — Telegram is then the only way back
        in (a password can be added later through password reset). The Telegram sign-in is
        rate-limited per IP and per Telegram account; if the server has no bot token configured
        it answers <code>503</code>.
      </DocP>
      <Next href="/docs/verification" label="Single & universal verification" />
    </>
  );
}
