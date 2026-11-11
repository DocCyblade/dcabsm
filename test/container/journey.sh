#!/bin/bash
# The container journey (spec 13.2). Runs as root inside the systemd container that run.sh boots,
# with the real dcabsm, real Nginx, real accounts, real npm installs and the real sandbox.
# JOURNEY_MODE is "pinned" (a local mirror stands in for npm, nodejs.org and GitHub) or "live".
set -euo pipefail

mode="${JOURNEY_MODE:?}"
version="${JOURNEY_VERSION:?}"
newer="${JOURNEY_NEWER:?}"
arch="${JOURNEY_ARCH:?}"

n=0
step() {
  n=$((n + 1))
  echo
  echo "== [$n] $*"
}
fail() {
  echo "JOURNEY FAILED: $*" >&2
  exit 1
}
# run <command...>: print the command, run it, keep what it printed in $out and its status in $status.
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
expect_refusal() { # expect_refusal <text> <command...>: fails, and says <text>
  local text="$1"
  shift
  run "$@"
  [ "$status" -ne 0 ] || fail "'$*' succeeded, and should have been refused"
  case "$out" in *"$text"*) ;; *) fail "'$*' did not say: $text" ;; esac
}
expect_in() { # expect_in <text>: the last output has it
  case "$out" in *"$1"*) ;; *) fail "expected '$1' in the output above" ;; esac
}
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
down() { ! up "$1"; }
info() { curl -skf --max-time 5 --resolve "$1:443:127.0.0.1" "https://$1/info"; }

echo "journey: $mode, dcabsm $version on $(. /etc/os-release && echo "$PRETTY_NAME") ($arch)"

# A DCABSM_ALLOW_* override left in the environment would hide the refusal below.
unset DCABSM_ALLOW_CONTAINER

step "Reach the network the way the mode needs"
if [ "$mode" = pinned ]; then
  cp /ci/ca.crt /usr/local/share/ca-certificates/dcabsm-test-ca.crt
  update-ca-certificates > /dev/null
  # The bundled Node and the npm it runs trust the test CA through this.
  export NODE_EXTRA_CA_CERTS=/ci/ca.crt
  # The pinned Releases are in an npm cache, so npm installs them without the registry.
  cp -a /pins/npm-cache /root/npm-cache
  export npm_config_cache=/root/npm-cache npm_config_offline=true
fi

step "Install the CI-built tarball"
if [ "$mode" = pinned ]; then
  expect_ok bash /ci/install.sh --yes --version "$version"
else
  # Nothing is signed in CI, so the live job unpacks the tarball where install.sh would.
  mkdir -p /opt/dcabsm/.stage /usr/local/bin /usr/share/bash-completion/completions
  tar -xzf "/ci/dcabsm-$version-linux-$arch.tar.gz" -C /opt/dcabsm/.stage --strip-components=1
  mv /opt/dcabsm/.stage "/opt/dcabsm/$version"
  mkdir -p "/opt/dcabsm/$version/share"
  : > "/opt/dcabsm/$version/share/dcabsm-signing-key.gpg"
  ln -sfn "/opt/dcabsm/$version/bin/dcabsm" /usr/local/bin/dcabsm
fi
expect_ok dcabsm --version
expect_in "DCABSM $version"

step "Setup refuses a container without the override"
expect_refusal "This Host is a container" dcabsm host setup --yes
[ ! -e /etc/dcabsm/dcabsm.json ] || fail "a refused setup left dcabsm.json behind"

# From here on, every run sets the override (spec 13.2).
export DCABSM_ALLOW_CONTAINER=1

step "Host setup"
if [ "$mode" = pinned ]; then
  expect_ok dcabsm host setup --release 26.10.0 --yes
else
  expect_ok dcabsm host setup --yes
fi
grep -q unsupportedHost /etc/dcabsm/dcabsm.json || fail "setup did not mark the Host as unsupported"
systemctl is-active --quiet nginx || fail "Nginx is not running after setup"

step "Doctor reports the Unsupported Host mark"
run dcabsm host doctor
expect_in "UNSUPPORTED HOST"
[ "$status" -ne 0 ] || fail "doctor exited 0 on an Unsupported Host"

echo "127.0.0.1 alpha.test beta.test" >> /etc/hosts

step "Create alpha with a self-signed certificate"
if [ "$mode" = pinned ]; then
  expect_ok dcabsm instance create alpha --hostname alpha.test --self-signed --release 26.10.0
else
  expect_ok dcabsm instance create alpha --hostname alpha.test --self-signed
fi
wait_for 30 up alpha.test
run curl -sI --max-time 5 --resolve alpha.test:80:127.0.0.1 http://alpha.test/
expect_in "301"
run info alpha.test
expect_in "version"

if [ "$mode" = live ]; then
  step "The newest Release is the one installed"
  expect_ok dcabsm release list
  expect_ok dcabsm instance list
  echo "journey: live journey passed"
  exit 0
fi

step "Release install, then prune the Release no Instance uses"
expect_ok dcabsm release install 26.11.0
expect_ok dcabsm release list
expect_in "26.11.0"
expect_ok dcabsm release prune --yes
expect_in "Removed Release 26.11.0"
expect_ok dcabsm release list
case "$out" in *26.11.0*) fail "26.11.0 is still listed after prune" ;; esac

step "Create beta with a certificate of its own on the newer Release"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=beta.test" \
  -addext "subjectAltName=DNS:beta.test" -keyout /root/beta.key -out /root/beta.crt 2> /dev/null
expect_ok dcabsm instance create beta --hostname beta.test --cert /root/beta.crt --key /root/beta.key --release 26.11.0
wait_for 30 up beta.test
run info beta.test
expect_in "26.11.0"
# The certificate beta serves is the one given, checked by a client that trusts only it.
curl -sf --max-time 5 --cacert /root/beta.crt --resolve beta.test:443:127.0.0.1 https://beta.test/health | grep -q UP ||
  fail "beta does not serve the certificate it was given"
run info alpha.test
expect_in "26.10.0"

step "Stop and start alpha; beta carries on"
expect_ok dcabsm instance stop alpha
wait_for 30 down alpha.test
up beta.test || fail "stopping alpha took beta down"
expect_ok dcabsm instance start alpha
wait_for 60 up alpha.test

step "Backup create and list"
expect_ok dcabsm backup create alpha
expect_ok dcabsm backup list alpha
expect_in "manual"

step "Instance settings reach the config and the vhost"
expect_ok dcabsm instance set alpha upload-limit-mb 60 --yes
expect_ok dcabsm instance settings alpha
expect_in "60"
grep -rqs "client_max_body_size 61m" /etc/nginx /etc/dcabsm /srv/dcabsm ||
  fail "the vhost does not carry the new upload limit"
wait_for 60 up alpha.test

step "Upgrade alpha to the newer Release, protected by a Pre-upgrade backup"
expect_ok dcabsm instance upgrade alpha --to 26.11.0 --yes
wait_for 60 up alpha.test
run info alpha.test
expect_in "26.11.0"
expect_ok dcabsm backup list alpha
expect_in "pre-upgrade"
up beta.test || fail "upgrading alpha took beta down"

step "Retention counts reach the Host settings, and prune applies them"
expect_ok dcabsm host set keep-pre-upgrade 2
expect_ok dcabsm host settings
expect_in "keep-pre-upgrade"
expect_ok dcabsm backup prune alpha --dry-run
expect_ok dcabsm backup prune alpha
expect_ok dcabsm backup list alpha
expect_in "manual"

step "Roll alpha back one step, keeping its data, then upgrade it again"
expect_ok dcabsm instance rollback alpha --yes
expect_in "keeping current data"
expect_in "Click Update now"
wait_for 60 up alpha.test
run info alpha.test
expect_in "26.10.0"
[ ! -e /srv/dcabsm/instances/alpha/.changing-release ] || fail "the change marker was left behind by rollback"
expect_refusal "Nothing to roll back" dcabsm instance rollback alpha --yes
up beta.test || fail "rolling alpha back took beta down"
expect_ok dcabsm instance upgrade alpha --to 26.11.0 --yes
wait_for 60 up alpha.test
run info alpha.test
expect_in "26.11.0"

step "Node patches: nothing newer is pinned, and the Instances stay up"
expect_ok dcabsm release update-node --yes
wait_for 30 up alpha.test
wait_for 30 up beta.test

step "Certificates: test, then update beta to a new one"
expect_ok dcabsm cert test alpha
expect_in "alpha.test"
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj "/CN=beta.test" \
  -addext "subjectAltName=DNS:beta.test" -keyout /root/beta2.key -out /root/beta2.crt 2> /dev/null
expect_ok dcabsm cert update beta --cert /root/beta2.crt --key /root/beta2.key
curl -sf --max-time 5 --cacert /root/beta2.crt --resolve beta.test:443:127.0.0.1 https://beta.test/health | grep -q UP ||
  fail "beta does not serve the updated certificate"
# A certificate for another hostname is refused, and the one in place keeps serving.
expect_refusal "" dcabsm cert update beta --cert /root/beta.crt --key /root/beta2.key
curl -sf --max-time 5 --cacert /root/beta2.crt --resolve beta.test:443:127.0.0.1 https://beta.test/health | grep -q UP ||
  fail "a refused update changed what beta serves"
expect_ok dcabsm instance list
expect_in "CERT"

step "Reset-password refuses without a terminal"
expect_refusal "needs a terminal" dcabsm instance reset-password alpha

step "Self update to the newer build"
expect_ok dcabsm host check-updates
expect_ok dcabsm self update --yes
expect_ok dcabsm --version
expect_in "DCABSM $newer"
case "$(readlink /usr/local/bin/dcabsm)" in *"/$newer/"*) ;; *) fail "the link was not moved to $newer" ;; esac
wait_for 30 up alpha.test
wait_for 30 up beta.test

step "Both Instances are listed"
expect_ok dcabsm instance list
expect_in "alpha"
expect_in "beta"

step "Restore alpha in place from its newest Backup"
expect_ok dcabsm backup create alpha
archive="$(ls -t /srv/dcabsm/backups/alpha/*.tar.gz | head -1)"
expect_refusal "--from" dcabsm instance restore "$archive" --confirm alpha
expect_ok dcabsm instance restore alpha --confirm alpha
expect_in "Regrouped"
wait_for 60 up alpha.test
run info alpha.test
expect_in "26.11.0"
expect_ok dcabsm backup list alpha
expect_in "pre-restore"
[ ! -e /srv/dcabsm/instances/alpha/.changing-release ] || fail "the change marker was left behind by restore"
up beta.test || fail "restoring alpha took beta down"

step "Move beta to a new hostname without restarting it"
echo "127.0.0.1 beta2.test" >> /etc/hosts
before="$(systemctl show -p InvocationID --value dcabsm@beta)"
expect_ok dcabsm instance set-hostname beta beta2.test --self-signed
expect_in "OpenID"
wait_for 30 up beta2.test
[ "$(systemctl show -p InvocationID --value dcabsm@beta)" = "$before" ] || fail "set-hostname restarted beta"
expect_ok dcabsm instance list
expect_in "beta2.test"

step "The Nightly run backs up every Instance and prunes"
expect_ok dcabsm backup schedule alpha on
expect_ok dcabsm host nightly
expect_ok dcabsm backup list alpha
expect_in "scheduled"
expect_ok dcabsm backup list beta
expect_in "scheduled"
wait_for 30 up alpha.test
wait_for 30 up beta2.test

step "A failed upgrade rolls back by itself, and the start gate is cleaned up"
echo "127.0.0.1 gamma.test" >> /etc/hosts
expect_ok dcabsm instance create gamma --hostname gamma.test --self-signed --release 26.10.0
wait_for 30 up gamma.test
# Break the newer Release's server so the upgraded Instance can never pass Verification.
entry="$(readlink -f /srv/dcabsm/instances/beta/release)/node_modules/.bin/actual-server"
real="$(readlink -f "$entry")"
cp -a "$real" /root/actual-server.orig
printf '#!/bin/sh\nexit 1\n' > "$real"
run dcabsm instance upgrade gamma --to 26.11.0 --yes
cat /root/actual-server.orig > "$real" # put the Release right again for beta
[ "$status" -ne 0 ] || fail "an upgrade onto a broken Release exited 0"
expect_in "Rolling back automatically"
wait_for 60 up gamma.test
run info gamma.test
expect_in "26.10.0"
[ ! -e /srv/dcabsm/instances/gamma/.changing-release ] || fail "the change marker was left behind"
expect_ok dcabsm backup list gamma
expect_in "pre-upgrade"
expect_ok dcabsm instance remove gamma --confirm gamma

step "Remove beta; its Backups stay under a .removed- folder"
expect_ok dcabsm instance remove beta --confirm beta
wait_for 30 down beta2.test
ls /srv/dcabsm/backups | grep -q '^beta\.removed-' || fail "beta's Backups were not kept under a .removed- folder"
[ ! -e /srv/dcabsm/instances/beta ] || fail "beta's directory is still there"
! id dcabsm-beta > /dev/null 2>&1 || fail "beta's account is still there"
expect_ok dcabsm instance list
case "$out" in *beta*) fail "beta is still listed after remove" ;; esac
up alpha.test || fail "removing beta took alpha down"

step "Restore --from rebuilds an Instance that was lost"
expect_ok dcabsm backup create alpha
lost="$(ls -t /srv/dcabsm/backups/alpha/*.tar.gz | head -1)"
cp "$lost" /root/alpha-lost.tar.gz
# While alpha exists, --from refuses and points to the two ways forward.
expect_refusal "already exists" dcabsm instance restore --from /root/alpha-lost.tar.gz
expect_in "instance clone --from"
expect_ok dcabsm instance remove alpha --confirm alpha
wait_for 30 down alpha.test
expect_ok dcabsm instance restore --from /root/alpha-lost.tar.gz
expect_in "Point DNS for alpha.test"
expect_in "Click Revert"
wait_for 60 up alpha.test
run info alpha.test
expect_in "26.11.0"
id dcabsm-alpha > /dev/null 2>&1 || fail "restore --from did not create alpha's account"
expect_ok dcabsm instance list
expect_in "alpha"

step "Clone alpha from the Instance, then from an archive"
echo "127.0.0.1 delta.test epsilon.test" >> /etc/hosts
# Alpha's certificate does not cover delta.test, so a clone without certificate options is refused.
expect_refusal "--self-signed" dcabsm instance clone alpha delta --hostname delta.test --yes
expect_ok dcabsm instance clone alpha delta --hostname delta.test --self-signed --yes
expect_in "Logins are copied"
expect_in "OpenID"
wait_for 60 up delta.test
wait_for 30 up alpha.test
expect_ok dcabsm backup list alpha
expect_in "pre-clone"
id dcabsm-delta > /dev/null 2>&1 || fail "clone did not create delta's account"
expect_ok dcabsm instance clone --from /root/alpha-lost.tar.gz epsilon --hostname epsilon.test --self-signed
wait_for 60 up epsilon.test
expect_ok dcabsm instance list
expect_in "delta"
expect_in "epsilon"
expect_ok dcabsm instance remove delta --confirm delta
expect_ok dcabsm instance remove epsilon --confirm epsilon

echo
echo "journey: pinned journey passed ($n steps)"
