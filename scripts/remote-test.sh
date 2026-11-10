#!/bin/bash
# Dev tool: runs the container journey on a private Proxmox test VM instead of in CI (spec 13.2).
# Rolls the VM back to its clean snapshot, copies this working tree over, builds the tarballs
# there and runs test/container/run.sh. The VM comes from the registry ~/.config/test-vms.env;
# no host, address or token lives in this repo.
#
#   scripts/remote-test.sh [<debian-13|ubuntu-24.04|ubuntu-26.04>...] [--live] [--no-reset]
#
# With no OS, all three run. Set TVM=<NAME> to use another registered VM (default CI01).
set -euo pipefail

registry="${TVM_REGISTRY:-$HOME/.config/test-vms.env}"
[ -r "$registry" ] || { echo "no test VM registry at $registry" >&2; exit 2; }
set -a; . "$registry"; set +a

vm="${TVM:-CI01}"
get() { local k="TVM_${vm}_$1"; printf '%s' "${!k:-}"; }
host=$(get SSH_HOST); node=$(get NODE); vmid=$(get VMID); snapshot=$(get SNAPSHOT)
token="$(get TOKEN_ID)=$(get TOKEN_SECRET)"
pve_key=$(get PVE); url_var="PVE_${pve_key}_URL"; url="${!url_var:-}"
[ -n "$host" ] && [ -n "$node" ] && [ -n "$vmid" ] && [ -n "$snapshot" ] && [ -n "$url" ] \
  || { echo "VM $vm is not fully described in $registry" >&2; exit 2; }

oses=(); live=""; reset=1
for arg in "$@"; do
  case "$arg" in
    --live) live="--live" ;;
    --no-reset) reset=0 ;;
    debian-13 | ubuntu-24.04 | ubuntu-26.04) oses+=("$arg") ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ ${#oses[@]} -gt 0 ] || oses=(debian-13 ubuntu-24.04 ubuntu-26.04)

api() { curl -sk -X "$1" -H "Authorization: PVEAPIToken=$token" "$url/api2/json/nodes/$node/$2"; }

wait_task() {
  local upid="$1" status
  for _ in $(seq 1 120); do
    status=$(api GET "tasks/$upid/status" | jq -r '.data.status // empty')
    [ "$status" = "stopped" ] && return 0
    sleep 2
  done
  echo "Proxmox task did not finish: $upid" >&2; return 1
}

if [ "$reset" = 1 ]; then
  echo "== rolling $vm back to $snapshot"
  wait_task "$(api POST "qemu/$vmid/snapshot/$snapshot/rollback" | jq -r '.data')"
  if [ "$(api GET "qemu/$vmid/status/current" | jq -r '.data.status')" != "running" ]; then
    wait_task "$(api POST "qemu/$vmid/status/start" | jq -r '.data')"
  fi
  for _ in $(seq 1 60); do
    ssh -o ConnectTimeout=3 -o BatchMode=yes "$host" true 2> /dev/null && break
    sleep 2
  done
fi
ssh -o BatchMode=yes "$host" true || { echo "cannot reach $host over ssh" >&2; exit 1; }

repo=$(cd "$(dirname "$0")/.." && pwd)
echo "== copying the working tree"
rsync -a --delete --exclude .git --exclude node_modules --exclude dist \
  --exclude 'docs/spec/*-e' "$repo/" "$host:dcabsm/"

echo "== building the tarballs"
ssh "$host" 'cd dcabsm && npm ci --no-audit --no-fund && npm run build && npm run package'

status=0
for os in "${oses[@]}"; do
  echo "== container journey: $os ${live:-pinned}"
  ssh -tt "$host" "cd dcabsm && test/container/run.sh $os $live" || { status=$?; echo "FAILED: $os" >&2; }
done
exit "$status"
