import { DocH, DocLead, DocH2, DocP, Code, Endpoint, Next } from "@/components/Docs";

export default function Operations() {
  return (
    <>
      <DocH>Operations</DocH>
      <DocLead>
        Health endpoints, environment configuration, and what degrades when a dependency is
        unavailable — and what does not.
      </DocLead>

      <DocH2>Health endpoints</DocH2>
      <Endpoint
        method="GET"
        path="/health"
        desc="Liveness. Answers as soon as the process is listening, before the database or any queue has been contacted."
      />
      <Endpoint
        method="GET"
        path="/ready"
        desc="Readiness. Returns 200 only once startup completed and the database answered. Render polls this as the health check."
      />
      <Code
        code={`curl https://verify.noveld.com.et/health
# {"status":"ok","uptimeSeconds":2248,...}`}
      />

      <DocH2>Verifications do not depend on the queues</DocH2>
      <DocP>
        Redis carries webhook and notification delivery only. Every{" "}
        <Code code="/verify*" inline /> endpoint works without it, and the service stays up and keeps
        serving if Redis is unreachable, over quota, or misconfigured. A queue failure is logged,
        delivery for that queue is disabled, and the condition is reported — it never takes the API
        down with it.
      </DocP>
      <DocP>
        This is deliberate. An optional dependency failing should degrade a service, not evict it. If
        a queue outage made <Code code="/ready" /> return 503, the platform would treat a service
        that is correctly answering verifications as unhealthy and restart it — against a dependency
        that a restart cannot fix.
      </DocP>
      <Code
        code={`curl https://verify.noveld.com.et/ready
{
  "ready": true,
  "degraded": ["webhookQueue"],
  "checks": {
    "startup": { "ready": true },
    "database": { "ready": true },
    "webhookQueue": { "ready": false, ... },
    "notificationQueue": { "ready": true, ... }
  }
}`}
      />
      <DocP>
        Read <Code code="ready" /> for &ldquo;should traffic come here&rdquo; and{" "}
        <Code code="degraded" /> for &ldquo;what is impaired&rdquo;. They are separate questions and
        the response answers both.
      </DocP>

      <DocH2>Queue recovery</DocH2>
      <DocP>
        Webhook deliveries are recorded in the database before they are queued, and a reconciler
        re-enqueues anything left mid-flight. Changing <Code code="REDIS_URL" inline /> therefore does
        not silently drop deliveries: pending work is picked up again from the database. In-flight
        attempts are lost and retried rather than completed — safe, because webhook handlers are
        expected to be idempotent.
      </DocP>

      <DocH2>Environment configuration</DocH2>
      <DocP>The variables that change behaviour rather than credentials:
      </DocP>
      <Code
        code={`VERIFY_AMOUNT_BASIS       net | gross        Basis for amount checks. Default net.
CORS_ALLOWED_ORIGINS    comma-separated      Browser origins allowed to call this API.
                                            Unset means same-origin only.
TRUST_FORWARDED_HEADERS  true | false        Honour CF-Connecting-IP / X-Forwarded-For.
                                            Off by default: those headers are only
                                            trustworthy from a proxy you deployed.
WEBHOOK_LEGACY_SIGNATURE true | false         Accept the pre-2024 webhook signature scheme.
STARTUP_WAIT_MS          milliseconds        How long a request waits for a cold database.`}
      />
      <DocP>
        <Code code="CORS_ALLOWED_ORIGINS" inline /> is required whenever the dashboard is served from
        a different host than the API, which is the normal deployment. Leave it unset and every
        browser request fails preflight — a CORS error in the console next to a 200 in the network
        tab. Trailing slashes are stripped when parsed, so pasting the dashboard URL verbatim works.
      </DocP>
      <DocP>
        The previous default reflected any <Code code="Origin" inline /> header, which let any website
        send authenticated requests using your operator&apos;s session. The allow-list replaces it.
      </DocP>

      <DocH2>Failure behaviour</DocH2>
      <DocP>
        Startup fails closed on missing configuration rather than starting half-configured. The
        startup log names every missing variable at once, so a rejected deploy tells you the whole
        list instead of one item per attempt:
      </DocP>
      <Code
        code={`Refusing to start: ADMIN_SECRET, DASHBOARD_SECRET must be set to a
random value of at least 16 characters. DATABASE_URL is not set either —
without it nothing can connect to the database.`}
      />
      <DocP>
        An unreachable database is <em>not</em> fatal: the process starts, <Code code="/ready" />{" "}
        reports it, and requests wait briefly and then receive a 503 with a reason rather than a
        hung connection. Both web services and the database scale to zero, so a slow resume after
        idleness is normal and should not be treated as an outage.
      </DocP>

      <DocH2>Log handling</DocH2>
      <DocP>
        Redis credentials can appear inside error objects: when an <Code code="AUTH" inline /> command
        fails, the Redis parser attaches the command and its arguments — including the password — to
        the error. Logging the error object therefore writes the credential to logs in plaintext, once
        per reconnect. Only error messages are logged for queue failures, and connection strings are
        masked before they are written anywhere.
      </DocP>
      <DocP>
        If a database password has ever appeared in your logs, rotate it. Redaction prevents future
        exposure; it cannot un-expose what is already stored.
      </DocP>
      <Next href="/docs/reference/errors" label="Errors & retries" />
    </>
  );
}