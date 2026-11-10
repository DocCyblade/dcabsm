#!/bin/bash
# Runs the container journey for one OS on this machine's architecture (spec 13.2, 13.3). Linux with
# Docker and passwordless sudo (the mirror listens on port 443). See docs/development.md.
#
#   test/container/run.sh <debian-13|ubuntu-24.04|ubuntu-26.04> [--live]
#
# Needs the CI-built tarballs (`npm run build && npm run package`) in dist/release, or in $TARBALLS.
# Pinned mode (default): the pinned Releases and Node are served from a local HTTPS mirror, and
# install.sh and `self update` use a throwaway signing key. --live: nothing is mirrored; the
# newest Release and Node come from the real sources.
set -euo pipefail

os="${1:-}"
mode="pinned"
[ "${2:-}" = "--live" ] && mode="live"
case "$os" in
  debian-13) base="debian:13" ;;
  ubuntu-24.04) base="ubuntu:24.04" ;;
  ubuntu-26.04) base="ubuntu:26.04" ;;
  *) echo "Usage: $0 <debian-13|ubuntu-24.04|ubuntu-26.04> [--live]" >&2; exit 2 ;;
esac

repo=$(cd "$(dirname "$0")/../.." && pwd)
case "$(uname -m)" in
  x86_64) arch=amd64; node_arch=x64 ;;
  aarch64) arch=arm64; node_arch=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 2 ;;
esac
tarballs="${TARBALLS:-$repo/dist/release}"
tarball=$(ls "$tarballs"/dcabsm-*-linux-"$arch".tar.gz 2> /dev/null | head -n 1 || true)
[ -n "$tarball" ] || { echo "no dcabsm-*-linux-$arch.tar.gz in $tarballs" >&2; exit 2; }
version=$(basename "$tarball" | sed -E 's/^dcabsm-(.*)-linux-.*$/\1/')
newer="${version%.*}.$((${version##*.} + 1))"

work=$(mktemp -d)
name="dcabsm-journey-$os-$$"
mirror_pid=""
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::journal of the container (last 150 lines)"
    docker exec "$name" journalctl --no-pager -n 150 2> /dev/null || true
    echo "::endgroup::"
    if [ -f "$work/mirror.log" ]; then
      echo "::group::mirror log"
      cat "$work/mirror.log"
      echo "::endgroup::"
    fi
  fi
  docker rm -f "$name" > /dev/null 2>&1 || true
  [ -n "$mirror_pid" ] && sudo kill "$mirror_pid" 2> /dev/null || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

echo "== Building the $os image"
docker build --build-arg "BASE=$base" -t "dcabsm-test:$os" "$repo/test/container"

stage="$work/stage"
mkdir -p "$stage"
cp "$repo/test/container/journey.sh" "$stage/journey.sh"
cp "$tarball" "$stage/"
hosts=()

if [ "$mode" = "pinned" ]; then
  pins="${PINS:-$repo/.cache/container-pins/$arch}"
  echo "== Pinned Releases and Node in $pins"
  node "$repo/test/container/pins.ts" "$pins" "$node_arch"

  # A throwaway CA and certificate for the names the mirror stands in for.
  names=(registry.npmjs.org nodejs.org raw.githubusercontent.com api.github.com github.com)
  san=$(printf 'DNS:%s,' "${names[@]}")
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=dcabsm test CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
    -keyout "$work/ca.key" -out "$work/ca.crt" 2> /dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=dcabsm test mirror" \
    -keyout "$work/leaf.key" -out "$work/leaf.csr" 2> /dev/null
  printf 'subjectAltName=%s\n' "${san%,}" > "$work/leaf.ext"
  openssl x509 -req -in "$work/leaf.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial \
    -days 2 -extfile "$work/leaf.ext" -out "$work/leaf.crt" 2> /dev/null
  cp "$work/ca.crt" "$stage/ca.crt"

  # The throwaway signing key, for install.sh and `self update`.
  export GNUPGHOME="$work/gnupg"
  mkdir -m 700 "$GNUPGHOME"
  gpg --batch --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "dcabsm CI <ci@invalid>" ed25519 sign never 2> /dev/null
  fpr=$(gpg --list-keys --with-colons | awk -F: '/^fpr/ {print $10; exit}')
  keyring=$(gpg --export "$fpr" | base64 | tr -d '\n')

  # install.sh with its release-time placeholders filled in, as install.test.ts does.
  sed -e 's|^GITHUB_OWNER=.*|GITHUB_OWNER="DocCyblade"|' \
    -e "s|^KEY_FINGERPRINT=.*|KEY_FINGERPRINT=\"$fpr\"|" \
    -e "s|^KEY_KEYRING_B64=.*|KEY_KEYRING_B64=\"$keyring\"|" \
    "$repo/install.sh" > "$stage/install.sh"

  # What github.com serves: this build as <version>, and a copy that calls itself <newer>.
  site="$work/site"
  mkdir -p "$site"
  cp -R "$pins/site/." "$site/"
  gh="$site/github.com/DocCyblade/dcabsm/releases/download"
  file="dcabsm-$version-linux-$arch.tar.gz"
  newfile="dcabsm-$newer-linux-$arch.tar.gz"
  mkdir -p "$gh/v$version" "$gh/v$newer" "$work/unpack"
  cp "$tarball" "$gh/v$version/$file"
  tar -xzf "$tarball" -C "$work/unpack"
  top=$(ls "$work/unpack")
  sed -i "s/\"$version\"/\"$newer\"/g" "$work/unpack/$top/bin/dcabsm.js"
  mv "$work/unpack/$top" "$work/unpack/dcabsm-$newer-linux-$arch"
  tar -czf "$gh/v$newer/$newfile" -C "$work/unpack" "dcabsm-$newer-linux-$arch"
  for v in "$version:$file" "$newer:$newfile"; do
    (
      cd "$gh/v${v%%:*}"
      sha256sum "${v#*:}" > SHA256SUMS
      gpg --batch --yes --detach-sign --output SHA256SUMS.sig SHA256SUMS
    )
  done
  mkdir -p "$site/api.github.com/repos/DocCyblade/dcabsm/releases"
  printf '{"tag_name":"v%s"}\n' "$newer" > "$site/api.github.com/repos/DocCyblade/dcabsm/releases/latest"

  echo "== Starting the mirror"
  sudo "$(command -v node)" "$repo/test/container/mirror.ts" "$site" \
    "$work/leaf.crt" "$work/leaf.key" 443 > "$work/mirror.log" 2>&1 &
  mirror_pid=$!
  for _ in $(seq 1 30); do grep -q 'mirror on' "$work/mirror.log" && break; sleep 0.5; done
  grep -q 'mirror on' "$work/mirror.log" || { cat "$work/mirror.log"; exit 1; }
  for n in "${names[@]}"; do hosts+=(--add-host "$n:host-gateway"); done
  mounts=(-v "$pins/npm-cache:/pins/npm-cache:ro")
else
  mounts=()
fi

echo "== Booting $os with systemd as PID 1"
docker run -d --name "$name" --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  "${hosts[@]}" "${mounts[@]}" -v "$stage:/ci:ro" "dcabsm-test:$os" > /dev/null
# `--wait` fails at once while systemd has not yet opened its bus, so poll until it answers.
for _ in $(seq 1 60); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) break ;; esac
  sleep 1
done
echo "systemd: ${state:-no answer}"

echo "== Running the $mode journey"
docker exec -e "JOURNEY_MODE=$mode" -e "JOURNEY_VERSION=$version" -e "JOURNEY_NEWER=$newer" \
  -e "JOURNEY_ARCH=$arch" "$name" bash /ci/journey.sh
echo "== $os ($arch) $mode journey passed"
