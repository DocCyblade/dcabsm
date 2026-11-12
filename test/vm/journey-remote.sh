#!/bin/bash
# Runs ON a lab VM, as root, one journey step per call: run-journey.sh copies this over and calls
# `journey-remote.sh <step>` for each step that test/vm/lab.ts plans (spec 13.4). State lives on the
# VM between steps. Step shapes follow test/container/journey.sh.
#
# Environment (set by run-journey.sh):
#   JOURNEY_VERSION  the DCABSM version in the CI-built tarball
#   JOURNEY_STAGE    where the tarball, install.sh and this script were copied
#   JOURNEY_ARCH     amd64 (the lab VMs are amd64)
#   JOURNEY_INSTALL  "unpack" (default: unpack the unsigned CI tarball where install.sh would put it)
#                    or "script" (run install.sh --version, which needs a signed published release)
#   JOURNEY_PREV     the previous published DCABSM version, for the self-update steps
#   JOURNEY_OLD, JOURNEY_NEW  the two Actual Releases to use (default 26.10.0 and 26.11.0)
set -euo pipefail

version="${JOURNEY_VERSION:?}"
stage="${JOURNEY_STAGE:?}"
arch="${JOURNEY_ARCH:-amd64}"
install_mode="${JOURNEY_INSTALL:-unpack}"
old="${JOURNEY_OLD:-26.10.0}"
new="${JOURNEY_NEW:-26.11.0}"
step_id="${1:?step}"

fail() {
  echo "JOURNEY FAILED in step '$step_id': $*" >&2
  exit 1
}
out=""
status=0
run() {
  echo "\$ $*"
  set +e
  out=$("$@" 2>&1)
  status=$?
  set -e
  [ -z "$out" ] || echo "$out"
}
expect_ok() {
  run "$@"
  [ "$status" -eq 0 ] || fail "'$*' exited $status, and should have succeeded"
}
expect_in() { case "$out" in *"$1"*) ;; *) fail "expected '$1' in the output above" ;; esac }
expect_not_in() { case "$out" in *"$1"*) fail "did not expect '$1' in the output above" ;; *) ;; esac }
wait_for() { # wait_for <seconds> <command...>
  local limit="$1"
  shift
  for _ in $(seq 1 "$limit"); do
    "$@" > /dev/null 2>&1 && return 0
    sleep 1
  done
  fail "timed out waiting for: $*"
}
up() { curl -skf --max-time 5 --resolve "$1:443:127.0.0.1" "https://$1/health" | grep -q UP; }
info() { curl -skf --max-time 5 --resolve "$1:443:127.0.0.1" "https://$1/info"; }
hosts() { # hosts <name>...: make the names resolve to this VM
  for h in "$@"; do grep -q " $h\$" /etc/hosts 2> /dev/null || echo "127.0.0.1 $h" >> /etc/hosts; done
}
appliance() { sed -n 's/^turnkey-\([a-z]*\)-.*/\1/p' /etc/turnkey_version 2> /dev/null; }

[ "$(id -u)" -eq 0 ] || fail "must run as root"
echo "== step $step_id: $(. /etc/os-release && echo "$PRETTY_NAME") ($(uname -m)), dcabsm $version"

case "$step_id" in
  install)
    bash -n "$stage/install.sh" || fail "install.sh does not parse"
    if [ "$install_mode" = script ]; then
      expect_ok bash "$stage/install.sh" --yes --version "$version"
    else
      # Nothing is signed in CI, so unpack the tarball where install.sh would put it.
      mkdir -p /opt/dcabsm/.stage /usr/local/bin /usr/share/bash-completion/completions
      tar -xzf "$stage/dcabsm-$version-linux-$arch.tar.gz" -C /opt/dcabsm/.stage --strip-components=1
      mv /opt/dcabsm/.stage "/opt/dcabsm/$version"
      ln -sfn "/opt/dcabsm/$version/bin/dcabsm" /usr/local/bin/dcabsm
    fi
    expect_ok dcabsm --version
    expect_in "DCABSM $version"
    ;;

  install-prev) # the self-update journey starts from the previous published version
    expect_ok bash "$stage/install.sh" --yes --version "${JOURNEY_PREV:?}"
    expect_ok dcabsm --version
    expect_in "DCABSM $JOURNEY_PREV"
    ;;

  tk-setup-prompt)
    [ -n "$(appliance)" ] || fail "this VM is not a TurnKey appliance"
    # Answer no at the plan: it must list what setup disables and change nothing.
    echo "\$ dcabsm host setup  (answering n)"
    set +e
    out=$(printf 'n\n' | script -qec "dcabsm host setup" /dev/null 2>&1)
    status=$?
    set -e
    echo "$out"
    expect_in "Continue?"
    if [ "$(appliance)" = nodejs ]; then
      expect_in "nodejs Nginx site"
      expect_in "nothing is deleted"
    fi
    [ ! -e /etc/dcabsm/dcabsm.json ] || fail "a declined setup left dcabsm.json behind"
    [ "$(appliance)" != nodejs ] || [ -e /etc/nginx/sites-enabled/nodejs ] ||
      fail "a declined setup removed TurnKey's nodejs site"
    ;;

  setup)
    expect_ok dcabsm host setup --release "$old" --yes
    systemctl is-active --quiet nginx || fail "Nginx is not running after setup"
    # A real VM is a supported Host, never the Unsupported Host of the container journey.
    ! grep -q unsupportedHost /etc/dcabsm/dcabsm.json || fail "setup marked a lab VM as unsupported"
    ;;

  tk-pieces)
    if [ "$(appliance)" = nodejs ]; then
      [ ! -e /etc/nginx/sites-enabled/nodejs ] || fail "TurnKey's nodejs site is still enabled"
      ! systemctl is-active --quiet pm2-node.service || fail "pm2-node.service is still running"
    fi
    run nginx -T
    [ "$status" -eq 0 ] || fail "nginx -T failed"
    expect_in "ssl_reject_handshake on"
    # DCABSM's catch-all is the only default server on 443 (one listen line per address family).
    count=$(printf '%s\n' "$out" | grep -cE '^[[:space:]]*listen[^;]*443[^;]*default_server' || true)
    { [ "$count" -ge 1 ] && [ "$count" -le 2 ]; } || fail "expected DCABSM's catch-all as the one 443 default server, found $count listen lines"
    nginx -t || fail "nginx -t fails after setup"
    ;;

  create-alpha)
    hosts alpha.test beta.test delta.test
    expect_ok dcabsm instance create alpha --hostname alpha.test --self-signed --release "$old"
    wait_for 60 up alpha.test
    run info alpha.test
    expect_in "$old"
    run curl -sI --max-time 5 --resolve alpha.test:80:127.0.0.1 http://alpha.test/
    expect_in "301"
    ;;

  create-beta)
    hosts beta.test
    expect_ok dcabsm instance create beta --hostname beta.test --self-signed --release "$new"
    wait_for 60 up beta.test
    run info beta.test
    expect_in "$new"
    up alpha.test || fail "creating beta took alpha down"
    ;;

  tk-vhost)
    run curl -skI --max-time 5 --resolve alpha.test:443:127.0.0.1 https://alpha.test/
    expect_not_in "Strict-Transport-Security"
    case "$(printf '%s' "$out" | tr 'A-Z' 'a-z')" in *strict-transport-security*) fail "alpha sends HSTS" ;; esac
    ! grep -rqi strict-transport-security /srv/dcabsm/instances/alpha/nginx/ || fail "alpha's vhost sets HSTS"
    ;;

  upgrade)
    expect_ok dcabsm instance upgrade alpha --to "$new" --yes
    wait_for 60 up alpha.test
    run info alpha.test
    expect_in "$new"
    expect_ok dcabsm backup list alpha
    expect_in "pre-upgrade"
    up beta.test || fail "upgrading alpha took beta down"
    ;;

  rollback)
    expect_ok dcabsm instance rollback alpha --yes
    expect_in "keeping current data"
    wait_for 60 up alpha.test
    run info alpha.test
    expect_in "$old"
    [ ! -e /srv/dcabsm/instances/alpha/.changing-release ] || fail "the change marker was left behind"
    expect_ok dcabsm instance upgrade alpha --to "$new" --yes
    wait_for 60 up alpha.test
    run info alpha.test
    expect_in "$new"
    ;;

  backup)
    expect_ok dcabsm backup create alpha
    expect_ok dcabsm backup list alpha
    expect_in "manual"
    ;;

  restore)
    expect_ok dcabsm instance restore alpha --confirm alpha
    expect_in "Regrouped"
    wait_for 60 up alpha.test
    expect_ok dcabsm backup list alpha
    expect_in "pre-restore"
    [ ! -e /srv/dcabsm/instances/alpha/.changing-release ] || fail "the change marker was left behind"
    up beta.test || fail "restoring alpha took beta down"
    ;;

  clone)
    hosts delta.test
    expect_ok dcabsm instance clone alpha delta --hostname delta.test --self-signed --yes
    wait_for 60 up delta.test
    wait_for 30 up alpha.test
    expect_ok dcabsm backup list alpha
    expect_in "pre-clone"
    id dcabsm-delta > /dev/null 2>&1 || fail "clone did not create delta's account"
    ;;

  reboot) # run-journey.sh has rebooted the VM; everything must come back by itself
    wait_for 120 systemctl is-active --quiet nginx
    for h in alpha beta delta; do
      wait_for 120 up "$h.test"
    done
    ;;

  doctor)
    run dcabsm host doctor
    # Warnings (exit 1) are allowed, such as no scheduled Backup yet; a failure (exit 2) is not.
    [ "$status" -le 1 ] || fail "host doctor exited $status"
    case "$out" in *"✗"*) fail "host doctor reported a failure" ;; esac
    expect_not_in "UNSUPPORTED HOST"
    ;;

  tk-doctor) # put back a piece setup disabled: doctor warns, and --fix disables it again
    if [ "$(appliance)" = nodejs ] && [ -e /etc/nginx/sites-available/nodejs ]; then
      ln -sfn ../sites-available/nodejs /etc/nginx/sites-enabled/nodejs
      run dcabsm host doctor
      expect_in "TurnKey's nodejs Nginx site is enabled"
      expect_ok dcabsm host doctor --fix --yes
      [ ! -e /etc/nginx/sites-enabled/nodejs ] || fail "doctor --fix did not disable the nodejs site"
    elif [ -e /etc/cron.daily/confconsole-dehydrated ]; then
      chmod +x /etc/cron.daily/confconsole-dehydrated
      run dcabsm host doctor
      expect_in "confconsole's Let's Encrypt renewal job is executable"
      expect_ok dcabsm host doctor --fix --yes
      [ ! -x /etc/cron.daily/confconsole-dehydrated ] || fail "doctor --fix did not disable the renewal job"
    else
      echo "nothing to put back on this appliance (no nodejs site, no renewal job)"
    fi
    nginx -t || fail "nginx -t fails after doctor --fix"
    up alpha.test || fail "alpha is not served after doctor --fix"
    ;;

  self-update) # from the previous published version to the newest published one (spec 13.5 step 3)
    expect_ok dcabsm host check-updates
    expect_ok dcabsm self update --yes
    expect_ok dcabsm --version
    expect_not_in "DCABSM ${JOURNEY_PREV:?}"
    wait_for 60 up alpha.test
    expect_ok dcabsm instance list
    expect_in "alpha"
    ;;

  *) fail "unknown step" ;;
esac
echo "step $step_id: ok"
