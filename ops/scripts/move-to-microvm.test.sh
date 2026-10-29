#!/usr/bin/env bash
# Tests ops/scripts/move-to-microvm.sh (#259): the stub exits 0 with
# --dry-run and 75 (EX_TEMPFAIL) otherwise, prints its plan, and refuses a
# bad tenant id or a missing argument with 64.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
hook=$here/move-to-microvm.sh
fail() { echo "FAIL: $*" >&2; exit 1; }

out=$("$hook" --dry-run t_hello /var/lib/renox/data/t_hello/app.db) || fail "dry run exit $?"
grep -q "plan for tenant t_hello" <<<"$out" || fail "no plan"
grep -q "dry run, nothing done" <<<"$out" || fail "dry run not reported"

set +e
"$hook" t_hello /var/lib/renox/data/t_hello/app.db >/dev/null 2>&1; code=$?
"$hook" 'bad tenant;rm' /x >/dev/null 2>&1; bad=$?
"$hook" t_hello >/dev/null 2>&1; missing=$?
set -e
[[ $code -eq 75 ]] || fail "stub exit $code, want 75"
[[ $bad -eq 64 ]] || fail "bad tenant id exit $bad, want 64"
[[ $missing -eq 64 ]] || fail "missing argument exit $missing, want 64"
echo "move-to-microvm.test.sh: ok"
