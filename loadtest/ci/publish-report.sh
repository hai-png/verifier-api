#!/usr/bin/env bash
# Commit harness output back into the repository so reports are readable
# outside the Actions UI (log/artifact downloads are not always reachable).
#
# Two workflows can finish at the same time, so a rejected push is retried:
# the report commit is replayed on top of whatever landed first.
#
#   bash loadtest/ci/publish-report.sh <label>
set -uo pipefail

LABEL="${1:-loadtest}"
DEST="loadtest-results/${LABEL}"
BRANCH="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"

mkdir -p "$DEST"
for file in build-test.txt loadtest-console.txt api.log api-restart.log db-traffic.txt db-timeline.txt db-timeline-errors.txt app-statements.txt startup-cost.txt db-rtt-before.txt stub.log; do
  if [ -f "$file" ]; then cp "$file" "$DEST/" 2>/dev/null || true; fi
done
# Root-level reports remain the source of truth. Only auxiliary diagnostics
# belong in the per-label directory; copying historical reports here duplicated
# every lab run into live/ and every live run into lab/ on each push.
# Per-scenario tool output (db-traffic-*.json, db-timeline-*.json, diag-*.json)
for extra in db-traffic-*.json db-timeline-*.json diag-*.json; do
  [ -f "$extra" ] && cp "$extra" "$DEST/" 2>/dev/null || true
done

# Keep only the newest handful of runs to avoid unbounded repository growth.
ls -1dt loadtest-results/*/ 2>/dev/null | tail -n +6 | while read -r old; do
  echo "pruning $old"
  rm -rf "$old"
done

git config user.name "github-actions[bot]" 2>/dev/null || true
git config user.email "41898282+github-actions[bot]@users.noreply.github.com" 2>/dev/null || true
git add -f loadtest-results >/dev/null 2>&1 || true
if git diff --cached --quiet; then
  echo "no report changes to publish — nothing new under loadtest-results/"
  ls -1 loadtest-results/ | head -20
  exit 0
fi
echo "staged for publishing:"
git diff --cached --name-only | head -20
git commit -q -m "ci(${LABEL}): publish load test report for run ${GITHUB_RUN_ID:-local} [skip ci]" \
  || { echo "::warning::could not commit the report"; exit 0; }

for attempt in 1 2 3 4 5 6; do
  git fetch -q origin "$BRANCH" 2>/dev/null || true

  # Already on the remote (an earlier attempt of this loop published it): done.
  # NOTE: FETCH_HEAD here must be the *git* ref written by fetch, not the
  # ${FETCH_HEAD} shell variable — non-interactive bash never sets that one, and
  # guarding on it silently skipped every recovery attempt.
  if git merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null; then
    echo "report commit is already on ${BRANCH} (attempt ${attempt})"
    exit 0
  fi

  if git push origin "HEAD:${BRANCH}" 2>/tmp/push-error.txt; then
    echo "published report to ${BRANCH} (attempt ${attempt})"
    exit 0
  fi
  echo "push attempt ${attempt} failed: $(tail -n 2 /tmp/push-error.txt | tr '\n' ' ')"

  # Rebuild our report commit on top of whatever landed first.
  #
  # NOT a rebase: actions/checkout does a depth-1 shallow clone, so there is no
  # common ancestor to rebase onto — `git merge-base` returns nothing and the
  # retry could never recover (which is how reports were lost). Copying the
  # report files aside, moving to the branch tip and re-adding them needs no
  # history at all.
  BACKUP="${RUNNER_TEMP:-/tmp}/report-backup"
  rm -rf "$BACKUP"
  mkdir -p "$BACKUP"
  cp -r loadtest-results "$BACKUP/" 2>/dev/null || true
  git reset --hard FETCH_HEAD >/dev/null 2>&1 \
    || git checkout -f FETCH_HEAD >/dev/null 2>&1 \
    || true
  cp -r "$BACKUP/loadtest-results/." loadtest-results/ 2>/dev/null || true
  git add -f loadtest-results >/dev/null 2>&1 || true
  if ! git diff --cached --quiet; then
    git commit -q -m "ci(${LABEL}): publish load test report for run ${GITHUB_RUN_ID:-local} [skip ci]" || true
  fi
  sleep $((attempt * 5))
done

# Visible in the Actions UI *and* through the API (annotations are readable even
# when job logs are not), including the reason the last push was rejected.
PUSH_ERROR="$(tail -n 3 /tmp/push-error.txt 2>/dev/null | tr '\n' ' ' | tr -s ' ')"
echo "::warning::could not publish the report after retries — local $(git rev-parse --short HEAD), branch tip $(git rev-parse --short FETCH_HEAD 2>/dev/null || echo unknown); last push error: ${PUSH_ERROR}"
echo "local HEAD: $(git rev-parse --short HEAD)"
exit 0
