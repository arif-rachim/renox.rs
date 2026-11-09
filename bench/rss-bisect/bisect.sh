#!/usr/bin/env bash
# Bisect by value of the shop isolate RSS (#457, task 4).
#
#   bench/rss-bisect/bisect.sh <good> <bad> [budget]
#
# Commits are the first-parent chain <good>..<bad> (plus <good>). A range
# whose two ends differ by more than 0.5 MB is split at its midpoint, which
# is measured with measure.sh; both halves are then queued. A range of one
# first-parent commit is final. Ranges are taken largest difference first.
# Values already in steps.tsv are reused; budget (default 12) counts only
# new measurements. Prints the final ranges that still differ by > 0.5 MB.
set -euo pipefail

[[ $# -ge 2 && $# -le 3 ]] || {
  echo "usage: bench/rss-bisect/bisect.sh <good> <bad> [budget]" >&2
  exit 2
}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
budget=${3:-12}
good=$(git -C "$repo" rev-parse --verify "$1^{commit}")
bad=$(git -C "$repo" rev-parse --verify "$2^{commit}")
mapfile -t chain < <(echo "$good"; git -C "$repo" rev-list --first-parent --reverse "$good..$bad")

value() { # rss_mb of a sha from steps.tsv (last line wins), empty if none
  awk -F'\t' -v s="$1" '$2 == s { sub(/^rss_mb=/, "", $3); v = $3 } END { if (v != "") print v }' "$here/steps.tsv" 2>/dev/null
}
measure() {
  local v
  v=$(value "$1")
  if [[ -z "$v" ]]; then
    if ((budget == 0)); then return 1; fi
    budget=$((budget - 1))
    "$here/measure.sh" "$1" >&2
    v=$(value "$1")
  fi
  echo "$v"
}
diff_gt() { awk -v a="$1" -v b="$2" 'BEGIN { d = b - a; if (d < 0) d = -d; exit !(d > 0.5) }'; }
absdiff() { awk -v a="$1" -v b="$2" 'BEGIN { d = b - a; if (d < 0) d = -d; printf "%.2f", d }'; }

measure "$good" >/dev/null
measure "$bad" >/dev/null
queue=("0 $((${#chain[@]} - 1))")
final=()
left=()
while ((${#queue[@]} > 0)); do
  # Pick the queued range with the largest difference.
  best=0 bestd=-1
  for i in "${!queue[@]}"; do
    read -r lo hi <<<"${queue[$i]}"
    d=$(absdiff "$(value "${chain[$lo]}")" "$(value "${chain[$hi]}")")
    if awk -v a="$d" -v b="$bestd" 'BEGIN { exit !(a > b) }'; then best=$i bestd=$d; fi
  done
  read -r lo hi <<<"${queue[$best]}"
  unset 'queue[best]'
  queue=("${queue[@]}")
  vlo=$(value "${chain[$lo]}") vhi=$(value "${chain[$hi]}")
  diff_gt "$vlo" "$vhi" || continue
  if ((hi - lo == 1)); then
    final+=("${chain[$hi]} $vlo -> $vhi")
    continue
  fi
  mid=$(((lo + hi) / 2))
  if ! measure "${chain[$mid]}" >/dev/null; then
    left+=("${chain[$lo]}..${chain[$hi]} $vlo -> $vhi")
    continue
  fi
  queue+=("$lo $mid" "$mid $hi")
done

echo "commits adding > 0.5 MB (first parent):"
printf '  %s\n' "${final[@]:-none}"
echo "ranges left when the budget ran out:"
printf '  %s\n' "${left[@]:-none}"
