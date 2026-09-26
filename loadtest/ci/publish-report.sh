#!/usr/bin/env bash
# Commit harness output back into the repository so reports are readable
# outside the Actions UI (log/artifact downloads are not always reachable).
#
#   bash loadtest/ci/publish-report.sh <label>
set -uo pipefail

LABEL="${1:-loadtest}"
DEST="loadtest-results/${LABEL}"

mkdir -p "$DEST"
for file in loadtest-console.txt api.log api-restart.log db-traffic.txt startup-cost.txt db-rtt-before.txt stub.log; do
  [ -f "$file" ] && cp "$file" "$DEST/" 2>/dev/null || true
done
if [ -d loadtest-results ]; then
  find loadtest-results -maxdepth 1 -type f \( -name '*.json' -o -name '*.md' \) -exec cp {} "$DEST/" \; 2>/dev/null || true
fi

# Keep only the newest handful of runs to avoid unbounded repository growth.
ls -1dt loadtest-results/*/ 2>/dev/null | tail -n +6 | while read -r old; do
  echo "pruning $old"
  rm -rf "$old"
done

git config user.name "github-actions[bot]" 2>/dev/null || true
git config user.email "41898282+github-actions[bot]@users.noreply.github.com" 2>/dev/null || true
git add -f loadtest-results >/dev/null 2>&1 || true
if git diff --cached --quiet; then
  echo "no report changes to publish"
  exit 0
fi
git commit -q -m "ci(${LABEL}): publish load test report for run ${GITHUB_RUN_ID:-local} [skip ci]" || exit 0
git push origin "HEAD:${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}" || echo "warning: could not push the report back"
