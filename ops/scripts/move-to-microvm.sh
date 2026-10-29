#!/usr/bin/env bash
# The node's `[process] microvm_hook` (#259; docs/contracts/deploy-api.md
# section 17, node-listener.yaml `nodeMoveTenant`). The node runs it with the
# tenant id and the absolute path of the tenant's file, an empty environment
# (PATH only) and a 10-minute timeout, and reports its exit code to the
# control plane: 0 = moved, anything else = failed (the tenant serves where
# it was).
#
#   move-to-microvm.sh [--dry-run] <tenant_id> <file>
#
# A documented stub in F6: it prints what a Firecracker launcher would do and
# exits 0 with --dry-run, 75 (EX_TEMPFAIL) otherwise. The real launcher is F7
# work (ops/README.md, "Moving a tenant to a microVM").
set -euo pipefail

dry_run=0
if [[ ${1:-} == --dry-run ]]; then
  dry_run=1
  shift
fi
if [[ $# -ne 2 ]]; then
  echo "usage: $0 [--dry-run] <tenant_id> <file>" >&2
  exit 64
fi
tenant=$1
file=$2
if [[ ! $tenant =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "move-to-microvm: not a tenant id" >&2
  exit 64
fi

cat <<PLAN
move-to-microvm: plan for tenant $tenant
  1. snapshot   sqlite3 '$file' "VACUUM INTO '<run>/microvm/$tenant/app.db'" (a consistent copy; the node has drained the tenant)
  2. start VM   firecracker --config-file <run>/microvm/$tenant/vm.json (the renox-worker image, 1 vCPU, 1 GiB, the copy as a virtio block device)
  3. register   the VM's worker registers with the control plane as node microvm-$tenant
  4. route      the control plane pins $tenant to microvm-$tenant and publishes the route delta
PLAN

if [[ $dry_run -eq 1 ]]; then
  echo "move-to-microvm: dry run, nothing done"
  exit 0
fi
echo "move-to-microvm: no Firecracker launcher on this node (F7); the tenant stays where it is" >&2
exit 75
