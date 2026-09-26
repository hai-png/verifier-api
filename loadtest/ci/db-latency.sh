#!/usr/bin/env bash
# Emulate a cross-region database: add `delay` ms to every packet on loopback
# that targets MySQL (port 3306). Used by the perf lab so a local MySQL behaves
# like TiDB-in-us-east talking to Render-in-us-west.
#
#   sudo loadtest/ci/db-latency.sh apply 30
#   sudo loadtest/ci/db-latency.sh clear
set -euo pipefail

ACTION="${1:-apply}"
DELAY_MS="${2:-30}"
PORT="${MYSQL_PORT:-3306}"
MARK=10
HANDLE=30

clear_rules() {
  tc qdisc del dev lo root 2>/dev/null || true
  iptables -t mangle -D OUTPUT -p tcp --dport "$PORT" -j MARK --set-mark "$MARK" 2>/dev/null || true
  iptables -t mangle -D OUTPUT -p tcp --sport "$PORT" -j MARK --set-mark "$MARK" 2>/dev/null || true
}

case "$ACTION" in
  apply)
    clear_rules
    # Mark both directions: client->server and the response. One-way delay d
    # therefore costs ~2d per round trip, which is how a cross-region database
    # behaves (delay 75ms ~= TiDB us-east to Render us-west).
    iptables -t mangle -A OUTPUT -p tcp --dport "$PORT" -j MARK --set-mark "$MARK"
    iptables -t mangle -A OUTPUT -p tcp --sport "$PORT" -j MARK --set-mark "$MARK"
    tc qdisc add dev lo root handle 1: prio bands 4
    tc filter add dev lo parent 1:0 protocol ip prio 1 handle "$MARK" fw flowid 1:3
    tc qdisc add dev lo parent 1:3 handle "$HANDLE": netem delay "${DELAY_MS}ms"
    echo "applied ${DELAY_MS}ms one-way delay (~$((DELAY_MS * 2))ms round trip) to loopback traffic on port ${PORT}"
    tc -s qdisc show dev lo
    ;;
  clear)
    clear_rules
    echo "cleared loopback delay rules"
    ;;
  *)
    echo "usage: $0 {apply|clear} [delay_ms]" >&2
    exit 2
    ;;
esac
