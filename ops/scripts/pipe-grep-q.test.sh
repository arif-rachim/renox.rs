#!/usr/bin/env bash
# Regression test for #569: under `set -o pipefail`, `producer | grep -q X`
# fails when grep -q exits on the first match while the producer is still
# writing (the producer gets SIGPIPE, status 141), although X was found.
# Step 10 of single-host-e2e.test.sh flaked this way on `pg_restore --list`.
# Proves: the hazard is real (a deterministic producer that writes after the
# match makes `| grep -q` fail and `| grep X >/dev/null` pass), and
# single-host-e2e.test.sh pipes no command into `grep -q` (here-strings and
# files are fine: there is no writer to kill). No docker, no network.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

# A producer that writes the match, waits until grep has read it, then keeps
# writing far more than a pipe buffer holds.
producer() { echo 'TABLE public tenants'; sleep 0.3; head -c 1048576 /dev/zero | tr '\0' 'x'; echo; }

status=0
producer | grep -q 'TABLE public tenants' || status=$?
if [[ $status -ne 0 ]]; then pass "the hazard: producer | grep -q fails under pipefail (status $status) although the line is there"
else fail "the hazard: producer | grep -q passed; the demonstration no longer shows the SIGPIPE failure"; fi

status=0
producer | grep 'TABLE public tenants' >/dev/null || status=$?
if [[ $status -eq 0 ]]; then pass "the fix: producer | grep PATTERN >/dev/null reads to the end and passes"
else fail "the fix: producer | grep PATTERN >/dev/null failed (status $status)"; fi

status=0
producer | grep 'TABLE public missing' >/dev/null || status=$?
if [[ $status -ne 0 ]]; then pass "the fix still fails when the line is missing (status $status)"
else fail "the fix passed although the line is missing"; fi

# A single `|` (not `||`) followed by grep (optionally run through dx) whose
# options include q or --quiet.
pattern='(^|[^|])\|[[:space:]]*(dx[[:space:]]+)?grep[[:space:]]+(-[[:alpha:]]*q|--quiet)'
script=$here/single-host-e2e.test.sh
if hits=$(grep -nE "$pattern" "$script"); then fail "single-host-e2e.test.sh pipes a command into grep -q: $hits"
else pass "single-host-e2e.test.sh pipes no command into grep -q"; fi

# The pattern itself catches the shapes it must catch and spares the rest.
for line in "x | grep -q y" "x|grep -qi y" "x | dx grep -q y" "x | grep --quiet y"; do
  grep -qE "$pattern" <<< "$line" || fail "the check misses: $line"
done
for line in "grep -q y <<< \"\$x\"" "a || grep -q y f" "x | grep y >/dev/null" "dx grep -q y /root/body"; do
  if grep -qE "$pattern" <<< "$line"; then fail "the check flags a safe line: $line"; fi
done
pass "the check's pattern matches piped grep -q and spares here-strings, files and ||"

if [[ $fails -gt 0 ]]; then echo "$fails check(s) failed"; exit 1; fi
echo "all pipe-grep-q checks passed"
