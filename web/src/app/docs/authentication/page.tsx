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
      <Next href="/docs/verification" label="Single & universal verification" />
    </>
  );
}
