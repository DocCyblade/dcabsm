#!/bin/bash
# DCABSM installer (spec 11.3). Read it, then run:  sudo bash install.sh [--yes] [--version <ver>]
#
# It checks the OS and architecture, shows the signing key's fingerprint, downloads the tarball for
# this Host, checks SHA256SUMS.sig with gpgv and the tarball against SHA256SUMS, then installs to
# /opt/dcabsm/<ver>/, links /usr/local/bin/dcabsm and installs the bash completion script.
# It never runs setup and never touches apt.

# ---- Release-time placeholders: the only ones in the code. The author fills them in per release. ----
GITHUB_OWNER="OWNER_PLACEHOLDER"
KEY_FINGERPRINT="FINGERPRINT_PLACEHOLDER"
KEY_KEYRING_B64="KEYRING_PLACEHOLDER"
# GITHUB_OWNER: the account or organisation that owns the repo, as in github.com/<owner>/dcabsm.
# KEY_FINGERPRINT: the signing key's fingerprint, printed for the System Admin to compare.
# KEY_KEYRING_B64: that key as a binary keyring, base64 on one line: gpg --export <fpr> | base64 | tr -d '\n'
# ----------------------------------------------------------------------------------------------------

set -euo pipefail

REPO="dcabsm"
# DCABSM_ROOT moves every path, for tests. The default is the real root.
ROOT="${DCABSM_ROOT:-}"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

yes=0
version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --version) [ $# -ge 2 ] || die "--version needs a value"; version="$2"; shift 2 ;;
    *) die "unknown option $1. Usage: sudo bash install.sh [--yes] [--version <ver>]" ;;
  esac
done

case "$GITHUB_OWNER$KEY_FINGERPRINT$KEY_KEYRING_B64" in
  *PLACEHOLDER*) die "this copy still has its release-time placeholders. Download install.sh from a GitHub Release." ;;
esac

[ "$(id -u)" -eq 0 ] || die "run it as root: sudo bash install.sh"

# 1. OS and architecture (spec 1.4).
[ "$(uname -s)" = "Linux" ] || die "DCABSM supports Linux only."
os_id=""
os_version=""
if [ -r "$ROOT/etc/os-release" ]; then
  os_id=$(sed -n 's/^ID=//p' "$ROOT/etc/os-release" | tr -d '"')
  os_version=$(sed -n 's/^VERSION_ID=//p' "$ROOT/etc/os-release" | tr -d '"')
fi
case "$os_id $os_version" in
  "debian 13") os_name="Debian 13" ;;
  "ubuntu 24.04" | "ubuntu 26.04") os_name="Ubuntu $os_version" ;;
  *) die "unsupported OS (${os_id:-unknown} ${os_version}). DCABSM supports Debian 13 and Ubuntu 24.04 and 26.04." ;;
esac
case "$(uname -m)" in
  x86_64) arch="amd64" ;;
  aarch64) arch="arm64" ;;
  *) die "unsupported architecture $(uname -m). DCABSM supports amd64 and arm64." ;;
esac

# Already installed: point to Self-update and change nothing.
if [ -e "$ROOT/usr/local/bin/dcabsm" ] || [ -L "$ROOT/usr/local/bin/dcabsm" ] ||
  { [ -d "$ROOT/opt/dcabsm" ] && [ -n "$(ls -A "$ROOT/opt/dcabsm")" ]; }; then
  echo "DCABSM is already installed. To update it, run: sudo dcabsm self update"
  exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

download() { # download <url> <file>
  curl -fsSL -o "$2" "$1" || die "could not download $1"
}

releases="https://github.com/$GITHUB_OWNER/$REPO/releases"
if [ -z "$version" ]; then
  download "https://api.github.com/repos/$GITHUB_OWNER/$REPO/releases/latest" "$tmp/latest.json"
  version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' "$tmp/latest.json" | head -n 1)
  [ -n "$version" ] || die "could not find the latest release."
fi
case "$version" in
  *[!0-9A-Za-z.+-]* | "") die "invalid version $version" ;;
esac

# 2. The key fingerprint.
echo "DCABSM installer: $version for $os_name, $arch"
echo "Signing key fingerprint:"
echo "  $KEY_FINGERPRINT"
echo "Compare it with the README or https://keys.openpgp.org before going on."
if [ "$yes" -eq 0 ]; then
  printf 'Does it match? [y/N] '
  answer=""
  read -r answer || true
  case "$answer" in
    y | Y | yes | YES) ;;
    *) die "stopped: the fingerprint was not confirmed. Nothing was installed." ;;
  esac
fi

# 3. Download and check.
file="dcabsm-$version-linux-$arch.tar.gz"
base="$releases/download/v$version"
download "$base/$file" "$tmp/$file"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS"
download "$base/SHA256SUMS.sig" "$tmp/SHA256SUMS.sig"
echo "  ✓ Downloaded $file, SHA256SUMS, SHA256SUMS.sig"

printf '%s' "$KEY_KEYRING_B64" | base64 -d > "$tmp/key.gpg"
gpgv --keyring "$tmp/key.gpg" "$tmp/SHA256SUMS.sig" "$tmp/SHA256SUMS" > /dev/null 2>&1 ||
  die "the signature on SHA256SUMS does not verify against the signing key. Nothing was installed."
echo "  ✓ Signature good (gpgv)"

line=$(grep -F "  $file" "$tmp/SHA256SUMS" | head -n 1 || true)
[ -n "$line" ] || die "SHA256SUMS has no entry for $file. Nothing was installed."
if command -v sha256sum > /dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$file" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$file" | cut -d ' ' -f 1)
fi
[ "$actual" = "${line%% *}" ] || die "checksum mismatch for $file. Nothing was installed."
echo "  ✓ Checksum good"

# 4. Extract, link and install the completion script.
opt="$ROOT/opt/dcabsm"
mkdir -p "$opt"
stage="$opt/.install-$version"
rm -rf "$stage"
mkdir -p "$stage"
tar -xzf "$tmp/$file" -C "$stage" --strip-components=1 || {
  rm -rf "$stage"
  die "could not extract $file."
}
mv "$stage" "$opt/$version"
echo "  ✓ Extracted to /opt/dcabsm/$version/"

mkdir -p "$ROOT/usr/local/bin"
ln -sfn "/opt/dcabsm/$version/bin/dcabsm" "$ROOT/usr/local/bin/dcabsm"
echo "  ✓ /usr/local/bin/dcabsm → /opt/dcabsm/$version/bin/dcabsm"

completions="$ROOT/usr/share/bash-completion/completions"
mkdir -p "$completions"
install -m 644 "$opt/$version/share/bash-completion/completions/dcabsm" "$completions/dcabsm"
echo "  ✓ Installed the bash completion script"

# 5. The next step.
echo
echo "Next: sudo dcabsm host setup"
