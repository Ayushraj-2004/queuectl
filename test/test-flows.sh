#!/usr/bin/env bash
# Validates the 5 scenarios called out in the assignment, plus a concurrency
# stress test. Run from the project root: npm test  (requires `npm link` first,
# or run `node bin/queuectl.js` in place of `queuectl` below).
set -e

QUEUECTL="node $(cd "$(dirname "$0")/.." && pwd)/bin/queuectl.js"
TESTDIR=$(mktemp -d)
cd "$TESTDIR"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; exit 1; }

echo "== Test workspace: $TESTDIR =="

# --- Scenario 1: basic job completes successfully ---
$QUEUECTL enqueue '{"id":"t1-ok","command":"echo hi"}' > /dev/null
timeout 10 $QUEUECTL worker start --count 1 > /dev/null
sleep 1.5
$QUEUECTL worker stop > /dev/null
sleep 0.5
STATE=$($QUEUECTL list --state completed | grep -c "t1-ok" || true)
[ "$STATE" -eq 1 ] && pass "basic job completes successfully" || fail "job did not complete"

# --- Scenario 2: failed job retries with backoff and moves to DLQ ---
$QUEUECTL enqueue '{"id":"t2-fail","command":"exit 1","max_retries":2}' > /dev/null
timeout 10 $QUEUECTL worker start --count 1 > /dev/null
sleep 4   # base^1 = 2s backoff, give it time to retry once and die
$QUEUECTL worker stop > /dev/null
sleep 0.5
DEAD=$($QUEUECTL dlq list | grep -c "t2-fail" || true)
[ "$DEAD" -eq 1 ] && pass "failed job retries then moves to DLQ" || fail "job did not reach DLQ"

# --- Scenario 3: multiple workers process jobs without overlap ---
rm -f claims.log
for i in $(seq 1 15); do
  $QUEUECTL enqueue "{\"id\":\"t3-job$i\",\"command\":\"echo $i >> $TESTDIR/claims.log\"}" > /dev/null
done
timeout 15 $QUEUECTL worker start --count 4 > /dev/null
sleep 4
$QUEUECTL worker stop > /dev/null
sleep 0.5
TOTAL=$(wc -l < claims.log)
UNIQUE=$(sort -u claims.log | wc -l)
[ "$TOTAL" -eq "$UNIQUE" ] && [ "$TOTAL" -eq 15 ] && pass "4 workers processed 15 jobs with zero duplicate claims" \
  || fail "duplicate or missing claims: total=$TOTAL unique=$UNIQUE"

# --- Scenario 4: invalid commands fail gracefully (no crash, ends in DLQ) ---
$QUEUECTL enqueue '{"id":"t4-badcmd","command":"nonexistent_binary_xyz","max_retries":1}' > /dev/null
timeout 10 $QUEUECTL worker start --count 1 > /dev/null
sleep 2
$QUEUECTL worker stop > /dev/null
sleep 0.5
DEAD=$($QUEUECTL dlq list | grep -c "t4-badcmd" || true)
[ "$DEAD" -eq 1 ] && pass "invalid command fails gracefully and reaches DLQ" || fail "invalid command handling broke"

# --- Scenario 5: job data survives restart ---
$QUEUECTL enqueue '{"id":"t5-persist","command":"echo persist"}' > /dev/null
BEFORE=$($QUEUECTL list | wc -l)
# "restart" = just a fresh CLI process opening the same .queuectl/ dir
AFTER=$($QUEUECTL list | wc -l)
[ "$BEFORE" -eq "$AFTER" ] && [ "$AFTER" -gt 0 ] && pass "job data persists across process restarts" \
  || fail "job data did not persist"

echo ""
echo "All scenarios passed. Test workspace: $TESTDIR"
