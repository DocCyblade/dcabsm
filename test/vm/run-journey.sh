#!/bin/bash
# Dev tool (spec 13.4): runs the V1 journey on the lab VM for one OS, from its clean snapshot.
# Run by hand from the author's machine, ONE VM at a time. Never runs in CI.
#
#   test/vm/run-journey.sh <debian-13|ubuntu-24.04|ubuntu-26.04|turnkey> [options]
#
#   --vm <NAME>               use this registered VM when several fit the OS
#   --install-sh              run install.sh --version (needs a signed, published release);
#                             the default unpacks the unsigned CI tarball where install.sh would
#   --self-update-from <ver>  afterwards, also install <ver> (published) from the first snapshot and
#                             run `self update` (spec 13.5 step 3)
#
# Needs the CI-built tarball in dist/release (or $TARBALLS) and the registry
# ~/.config/test-vms.env (mode 600, outside the repo; see test/vm/test-vms.env.example).
# With no VM for the OS it prints "skipped: no VM for <os>" and exits 0. TurnKey runs once per
# snapshot (clean-core, clean-nodejs). The scripts only roll back to an existing snapshot and power
# the VM on: they never create, delete or reconfigure a VM. All output has addresses and lab
# details removed (lab-cli.ts redact), so a log can go into a PR.
set -euo pipefail

[ -z "${CI:-}" ] || { echo "the lab journey never runs in CI" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
lab() { node "$here/lab-cli.ts" "$@"; }

os="${1:-}"
case "$os" in
  debian-13 | ubuntu-24.04 | ubuntu-26.04 | turnkey) shift ;;
  *) echo "Usage: $0 <debian-13|ubuntu-24.04|ubuntu-26.04|turnkey> [--vm <NAME>] [--install-sh] [--self-update-from <ver>]" >&2; exit 2 ;;
esac
vm_args=(); install_mode=unpack; prev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vm) [ $# -ge 2 ] || { echo "--vm needs a value" >&2; exit 2; }; vm_args=(--vm "$2"); shift 2 ;;
    --install-sh) install_mode=script; shift ;;
    --self-update-from) [ $# -ge 2 ] || { echo "--self-update-from needs a version" >&2; exit 2; }; prev="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SKIPPED=""; SSH_TARGET=""; SNAPSHOTS=""
eval "$(lab resolve "$os" ${vm_args[@]+"${vm_args[@]}"})"
if [ -n "$SKIPPED" ]; then
  echo "$SKIPPED"
  echo "RESULT $os: SKIPPED"
  exit 0
fi

tarballs="${TARBALLS:-$repo/dist/release}"
tarball=$(ls "$tarballs"/dcabsm-*-linux-amd64.tar.gz 2> /dev/null | head -n 1 || true)
[ -n "$tarball" ] || { echo "no dcabsm-*-linux-amd64.tar.gz in $tarballs (npm run build && npm run package)" >&2; exit 2; }
version=$(basename "$tarball" | sed -E 's/^dcabsm-(.*)-linux-.*$/\1/')

sshopts=(-o BatchMode=yes -o ConnectTimeout=10)
remote="/var/tmp/dcabsm-journey"
# Run a command on the VM as root, with lab details removed from what comes back.
on_vm() {
  ssh "${sshopts[@]}" "$SSH_TARGET" "if [ \"\$(id -u)\" = 0 ]; then $*; else sudo -n $*; fi" 2>&1 | lab redact "$os" ${vm_args[@]+"${vm_args[@]}"}
}
vm_read() { ssh "${sshopts[@]}" "$SSH_TARGET" "$@" 2> /dev/null; }
vm_quiet() { ssh "${sshopts[@]}" "$SSH_TARGET" "$@" > /dev/null 2>&1; }

journey() { # journey <snapshot> <self-update|main>
  local snapshot="$1" kind="$2" steps step
  echo
  echo "######## $os from $snapshot ($kind)"
  lab rollback "$os" "$snapshot" ${vm_args[@]+"${vm_args[@]}"} || return 1
  vm_quiet "mkdir -p $remote" || return 1
  scp "${sshopts[@]}" -q "$tarball" "$repo/install.sh" "$here/journey-remote.sh" "$SSH_TARGET:$remote/" || return 1
  if [ "$kind" = self-update ]; then steps=$(lab plan "$os" --self-update); else steps=$(lab plan "$os"); fi
  for step in $steps; do
    echo
    echo "== $step"
    if [ "$step" = reboot ]; then
      # The VM only counts as rebooted when its boot id changes: SSH answering again proves nothing.
      local before after=""
      before=$(vm_read cat /proc/sys/kernel/random/boot_id) && [ -n "$before" ] || { echo "could not read the boot id before the reboot" >&2; return 1; }
      # The connection usually drops as the VM goes down, so this command's own status says nothing.
      if vm_quiet "systemctl reboot || sudo -n systemctl reboot"; then :; fi
      sleep 15
      for _ in $(seq 1 90); do
        after=$(vm_read cat /proc/sys/kernel/random/boot_id) || after=""
        [ -n "$after" ] && [ "$after" != "$before" ] && break
        after=""; sleep 2
      done
      [ -n "$after" ] || { echo "the VM did not reboot (its boot id never changed)" >&2; return 1; }
    fi
    on_vm "env JOURNEY_VERSION=$version JOURNEY_STAGE=$remote JOURNEY_ARCH=amd64 JOURNEY_INSTALL=$install_mode JOURNEY_PREV=$prev bash $remote/journey-remote.sh $step" || return 1
  done
}

failed=0
results=()
for snapshot in $SNAPSHOTS; do
  if journey "$snapshot" main; then results+=("PASS $os $snapshot"); else results+=("FAIL $os $snapshot"); failed=1; fi
done
if [ -n "$prev" ]; then
  first="${SNAPSHOTS%% *}"
  if journey "$first" self-update; then results+=("PASS $os $first self update"); else results+=("FAIL $os $first self update"); failed=1; fi
fi

echo
for r in "${results[@]}"; do echo "RESULT $r"; done
exit "$failed"
