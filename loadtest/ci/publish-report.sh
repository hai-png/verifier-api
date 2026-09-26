#!/usr/bin/env bash
# Commit harness output back into the repository so reports are readable
# outside the Actions UI (log/artifact downloads are not always reachable).
#
# Two workflows can finish at the same time, so the push is rebased and retried
# instead of racing the other run's report commit.
#
#   bash loadtest/ci/publish-report.sh <label>
set -uo pipefail

LABEL="${1:-loadtest}"
DEST="loadtest-results/${LABEL}"
BRANCH="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

mkdir -p "$DEST"
for file in loadtest-console.txt api.log api-restart.log db-traffic.txt startup-cost.txt db-rtt-before.txt stub.log; do
  if [ -f "$file" ]; then cp "$file" "$DEST/" 2>/dev/null || true; fi
done
find loadtest-results -maxdepth 1 -type f \( -name '*.json' -o -name '*.md' \) -exec cp {} "$DEST/" \; 2>/dev/null || true

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

for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:${BRANCH}" 2>/tmp/push-error.txt; then
    echo "published report to ${BRANCH} (attempt ${attempt})"
    exit 0
  fi
  echo "push attempt ${attempt} failed: $(tail -n 2 /tmp/push-error.txt | tr '\n' ' ')"
  # Another workflow pushed a report in the meantime — replay our commit on top.
  git pull --rebase --autostash origin "$BRANCH" >/dev/null 2>&1 || git rebase --abort >/dev/null 2>&1 || true
  sleep $((attempt * 3))
done

echo "warning: could not publish the report after retries (the artifact still exists in the Actions UI)"
exit 0
