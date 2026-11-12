# DCABSM roadmap

Work deliberately left out of V1, which might come later. Nothing here is promised or ordered. Capitalised terms are defined in [GLOSSARY.md](../GLOSSARY.md), and what V1 does is in the [V1 specification](spec/v1.md).

## Hosts

- **LXC on Proxmox as a Host.** V1 refuses every container (spec 10.3), because the Instance sandbox and the systemd design break in an unprivileged container. TurnKey's LXC templates come with this.
- **arm64 fully supported.** arm64 is built and CI-tested in V1. It becomes fully supported once an arm64 VM passes the OS gate (spec 13.6).
- **nginx.org's Nginx package.** V1 refuses it unless an override marks the Host as an Unsupported Host (spec 10.4). It would very likely work, since DCABSM only writes to `conf.d`, but supporting it means testing a second Nginx version on every OS.
- **Adopting an existing Actual install**, so a server already running Actual can move under DCABSM.

## Releases

- **Releases built from source, and nightly Releases.** V1 installs stable versions from npm only (spec 1.5).
- **Automatic upgrades.** In V1 every Upgrade is run by the System Admin.

## Backups

- **Off-Host backup targets.** In V1, Backups stay on the Host and copying them elsewhere is a Manual System Admin task.
- **Backup encryption**, with off-Host targets. It would use a public key, such as an age recipient, so scheduled Backups can be encrypted without any secret on the Host (spec 7.1).
- **Per-Instance schedules and Retention.** In V1 the Nightly run time and the Retention counts are Host-wide, and an Instance can only switch scheduled Backups off (spec 8.2).

## Certificates and Nginx

- **Let's Encrypt or other automatic certificate issuing.** In V1 the System Admin brings certificates, or DCABSM makes a self-signed one. Port 80 already serves `/.well-known/acme-challenge/` from a shared webroot, so certbot with `--webroot` and a deploy hook running `cert update` works by hand (spec 5.2, 5.6).
- **HTTP/2.** V1 serves HTTP/1.1 only, which avoids `http2` syntax that differs between the supported Nginx versions (spec 5.2).

## Instance settings

V1 exposes six Actual settings (spec 4.11). Candidates for later:

- **`token_expiration`.** Actual reads it as minutes for password login but as seconds for OpenID login, so V1 leaves tokens at Actual's default of never expiring.
- **`corsProxy.enabled` and `github.token`**, for Actual's experimental frontend plugins.
- **Header login.** V1 rules it out (spec 4.4, 5.2), because behind Nginx it would trust a header any client can send.
- **Secret settings.** V1 has none. Any future secret setting is passed through Actual's `*_FILE` variable from a root-owned file outside `config/`, never written into `config.json`.

## Watching the Host

- **A daily check and notifications**, including whether it offers to run `release update-node`. V1 relies on the Nightly run's failed unit, the 48-hour Backup warning, `host doctor` and `host check-updates`.

## DCABSM itself

- **zsh and fish Tab completion**, only if asked for. V1 ships bash completion (spec 9.1).
- **An uninstall command.** In V1, removing DCABSM is a Manual System Admin task described in the README (spec 11.5).
- **Reproducible builds**, so a compromised CI run can't produce a tarball that the author then signs ([ADR-0003](adr/0003-signed-tarball-with-its-own-node.md)).

## Review follow-ups

Small items from the Wave 8 security review that are not V1 behaviour:

- **Release gate (issue #43): check the `install.sh` fingerprint.** `install.sh` prints a fingerprint written into the script. The release process should fail the build when it differs from the fingerprint of the embedded keyring.
- **Whole-codebase review (issue #44): look closer at `release prune`, `instance remove` and `host/updates.ts`.** The Wave 8 review checked that their runner calls pass arguments without a shell and use validated names, and did not review their logic in depth.
- **The Instance unit keeps its current hardening.** `MemoryDenyWriteExecute` is incompatible with Node's JIT, and `IPAddressDeny` would break the proxying and sync. Revisit only if DCABSM gains an egress policy.
