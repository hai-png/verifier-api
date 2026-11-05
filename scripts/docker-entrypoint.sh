#!/bin/sh
# Container entrypoint for the verifier-api image.
#
# Boot order matters:
#   1. prisma db push (idempotent; see the earlier CMD comment below) — kept
#      non-fatal on purpose: a transient TiDB scale-to-zero DDL lock timeout
#      during a cold start must not crash-loop the deploy. /ready is the real
#      gate and returns 503 while the database is unreachable.
#   2. Embedded Redis — started ONLY when REDIS_URL points at the container's
#      own loopback. Upstash meters every command, so BullMQ's idle blocking
#      poll (~34k cmds/day for two workers) blew the free quota. A redis-server
#      that runs inside the same image has no meter and no idle cost; webhooks
#      and telegram deliveries flow through the existing BullMQ code unchanged.
#      Persistence is disabled deliberately: durable delivery state lives in
#      TiDB (WebhookDelivery / NotificationDelivery rows), and both queue
#      modules reconcile-and-re-enqueue pending rows on boot, so losing the
#      in-RAM queue when the container stops is safe. If the process dies
#      mid-flight, restart it (connectRetry backoff in redisConnection.ts
#      reconnects BullMQ automatically after a crash).
#   3. exec node — exec keeps node as PID 1 so Render's SIGTERM reaches it and
#      graceful shutdown can drain write-behind buffers / close the browser.
set -u

if [ "${SKIP_SCHEMA_PUSH}" != "true" ]; then
  if ! npx prisma db push --skip-generate; then
    echo 'WARNING: prisma db push failed - starting the API anyway; apply the schema manually'
  fi
fi

case "${REDIS_URL:-}" in
  redis://127.0.0.1:* | redis://localhost:*)
    (
      while true; do
        redis-server \
          --bind 127.0.0.1 \
          --port "${REDIS_LOCAL_PORT:-6379}" \
          --save "" \
          --appendonly no \
          --dir /tmp \
          --maxmemory "${REDIS_LOCAL_MAXMEMORY:-128mb}" \
          --maxmemory-policy noeviction \
          --loglevel warning
        echo "redis-server exited; restarting in 5s" >&2
        sleep 5
      done
    ) &
    ;;
  *)
    echo "REDIS_URL is empty or external - queues run against that URL; no embedded Redis started."
    ;;
esac

exec node dist/index.js
