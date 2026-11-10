# DCABSM

DocCyblade's Actual Budget Server Manager. A command-line tool that installs and maintains several [Actual Budget](https://actualbudget.org) servers on one Host.

Each Actual server is an Instance, with its own data, account, port, hostname and certificate, behind Nginx on port 443. Instances share installed Releases of Actual, so you can test a new version on one Instance while another keeps running the old one, or give each person or household their own server.

DCABSM is not part of the Actual project, and Actual's maintainers don't support it.

## Here be dragons

Read this before you upgrade, roll back or restore an Instance. Your mileage may vary.

- **Restore is DCABSM's own approach.** Actual doesn't document or support restoring a server from its files. DCABSM's restore is built and tested by DCABSM, not by Actual.
- **The server is the source of truth.** After a restore, every device resyncs from the server through Actual's reset dialog, "Syncing has been reset on this cloud file". Click **Revert**. Never click "upload this file to be the latest version": it undoes the restore.
- **Unsynced changes on a device can be lost.** Before a planned upgrade, rollback or restore, open Actual on every device and let it sync.
- **Device behaviour was tested in Chromium.** Firefox and Safari on a Mac get one pass before V1 ships. Mobile browsers are untested.

DCABSM repeats these warnings when you run `instance upgrade`, `instance rollback` and `instance restore`.

## Who it's for

Technically comfortable self-hosters running one Host. You run every command as root, usually through `sudo`, and you're comfortable bringing your own TLS certificates and DNS names.

## What it does

- Sets up the Host, and checks and fixes it with `host doctor`.
- Installs Releases of Actual from npm, each with its own Node runtime, and removes the unused ones.
- Creates, removes, starts, stops and restarts Instances, and shows their state and logs.
- Upgrades Instances, with a Backup first and an automatic rollback if the new Release fails to start. Rolls back on request.
- Backs up, restores and clones whole Instances.
- Takes a Backup of every Instance each night, and keeps a set number of each kind.
- Tests and updates certificates.
- Resets a server password, changes an Instance's hostname, and sets a short list of Actual's server settings.
- Checks for new Releases, Node patches and DCABSM versions, and updates itself from signed releases.
- bash Tab completion.

There is no web UI, no Docker, and no management of other machines. DCABSM manages only the Host it runs on.

## Supported Hosts

DCABSM is designed for a **fresh, dedicated Host**. Installing it on a server that already runs other things, such as another web server on port 80 or 443, may hit deliberate refusals.

| OS | Architectures | Form |
|---|---|---|
| Debian 13 | amd64, arm64 | any install |
| Ubuntu 24.04 LTS | amd64, arm64 | any install |
| Ubuntu 26.04 LTS | amd64, arm64 | any install |
| TurnKey Core 19.x (Debian 13) | amd64 | from the ISO |
| TurnKey Node.js 19.x (Debian 13) | amd64 | from the ISO |

- **Tested on** amd64 virtual machines running each OS in the table.
- **arm64** is built and tested in CI, but hasn't been tested on a real Host yet.
- **Virtual machines and bare metal only.** Setup refuses containers (LXC, WSL, Docker, Podman) and the Proxmox VE host itself.
- **Nginx** must be the distro's own `nginx` package. Setup installs it if it's missing. nginx.org's package isn't supported.
- **Actual** Releases 26.10.0 and newer, stable versions from npm only.
- DCABSM brings its own Node and never touches the system's, so it doesn't matter whether Node is already installed.

### TurnKey Linux

TurnKey Core and TurnKey Node.js are supported when installed from the ISO in a VM or on bare metal. Finish TurnKey's first-boot setup before running `host setup`, which refuses until it is done. TurnKey's LXC templates are refused, like any container, and so is every other TurnKey appliance.

Three TurnKey pieces clash with DCABSM. Setup lists them in its plan, asks once, then disables them. Nothing is deleted.

- The Node.js appliance's `nodejs` Nginx site. It would be the default site on port 443, and its HSTS header stops a self-signed certificate from being clicked through.
- `pm2-node.service`, the sample app behind that site.
- confconsole's daily Let's Encrypt renewal job, which stops Nginx and so takes every Instance down. Don't use confconsole's Let's Encrypt with DCABSM.

Webmin, Postfix, TurnKey's firewall and the rest are left alone. Don't use Webmin to edit Nginx files. `host doctor` warns if a disabled piece comes back.

## Installing

DCABSM is published as a signed tarball per architecture on this repo's GitHub Releases, with its own Node inside. It isn't on npm.

### The signing key

Releases are signed with this OpenPGP key:

```
XXXX XXXX XXXX XXXX XXXX  XXXX XXXX XXXX XXXX XXXX
```

The same fingerprint is on [keys.openpgp.org](https://keys.openpgp.org). It is published only in this README and there. Compare it before you install. After the first install, DCABSM checks every update against the key it already has, never one from the download.

### With the install script

Download `install.sh` from the latest release, read it, then run it:

```
sudo bash install.sh
```

It checks the OS and architecture, prints the key fingerprint and asks you to compare it with the one above, downloads the tarball, `SHA256SUMS` and `SHA256SUMS.sig`, checks them with `gpgv`, and installs to `/opt/dcabsm/<version>/`. It never runs setup and never touches apt. `--yes` skips the fingerprint question. If DCABSM is already installed, it points to `sudo dcabsm self update` and stops.

### By hand

The same steps, for amd64 (use `arm64` on an arm64 Host). Replace `<version>` with the release you're installing.

1. Download `dcabsm-<version>-linux-amd64.tar.gz`, `SHA256SUMS` and `SHA256SUMS.sig` from the release.
2. Get the key from keys.openpgp.org, check that its fingerprint matches the one above, and save it as a keyring:

   ```
   gpg --keyserver hkps://keys.openpgp.org --recv-keys <fingerprint>
   gpg --export <fingerprint> > dcabsm.gpg
   ```

3. Check the signature, then the checksum:

   ```
   gpgv --keyring ./dcabsm.gpg SHA256SUMS.sig SHA256SUMS
   sha256sum --check --ignore-missing SHA256SUMS
   ```

4. Extract and link it:

   ```
   sudo mkdir -p /opt/dcabsm/<version>
   sudo tar -xzf dcabsm-<version>-linux-amd64.tar.gz -C /opt/dcabsm/<version> --strip-components=1
   sudo install -D -m 644 dcabsm.gpg /opt/dcabsm/<version>/share/dcabsm-signing-key.gpg
   sudo ln -sfn /opt/dcabsm/<version>/bin/dcabsm /usr/local/bin/dcabsm
   sudo install -m 644 /opt/dcabsm/<version>/share/bash-completion/completions/dcabsm \
     /usr/share/bash-completion/completions/dcabsm
   ```

5. Next: `sudo dcabsm host setup`.

### If the signing key is lost or revoked

A notice goes at the top of this README, with the new key's fingerprint. Every Host then needs a manual reinstall with the new key, using the steps above, because DCABSM refuses updates that the installed key didn't sign. Instances, Releases and Backups are untouched by a reinstall.

## First steps

1. **Set up the Host.** This installs Nginx and `openssl`, writes DCABSM's systemd units and Nginx files, and installs the latest Release of Actual. It checks everything that could make it refuse before it changes anything, shows its plan, and asks once.

   ```
   sudo dcabsm host setup
   ```

   `--backup-dir <path>` puts Backups somewhere other than `/srv/dcabsm/backups`, ideally on another disk. It can only be set on the first run.

2. **Point a DNS name at the Host**, and get a certificate for it.

3. **Create an Instance.**

   ```
   sudo dcabsm instance create family --hostname budget.example.org --cert fullchain.pem --key privkey.pem
   ```

   With no certificate, `--self-signed` makes one. Browsers then warn on each device, and may warn again later, and Actual works after you proceed, but offline use and installing as an app need a certificate the device trusts. Bring one later with `cert update`.

4. **Open `https://budget.example.org` straight away** and set the server password in Actual. Until it is set, whoever opens the hostname first sets it, so either create the Instance before DNS points at the Host or set the password at once.

5. **Check on things.**

   ```
   sudo dcabsm instance list
   sudo dcabsm host doctor
   ```

Scheduled Backups are on for every new Instance. The Nightly run backs up each Instance at 03:30 Host time, one at a time, so each is down for a few seconds. The next steps are usually `host check-updates` and `instance upgrade`. Every command, prompt and message is in [docs/cli.md](docs/cli.md).

## Backups

Every Backup is a `.tar.gz` of the whole Instance, taken while it is stopped. Archives are **not encrypted**. They hold every budget, every login, the Instance's private key, and what Actual itself stores in plain text, such as the OpenID client secret and bank-sync credentials. Treat them as you would the Host's root account. Copying them off the Host is a Manual System Admin task in V1.

## Removing DCABSM

V1 has no uninstall command. Removing DCABSM is a Manual System Admin task:

```
sudo systemctl disable --now dcabsm-nightly.timer
sudo rm -rf /opt/dcabsm
sudo rm /usr/local/bin/dcabsm /usr/share/bash-completion/completions/dcabsm
```

The Nightly run needs `dcabsm`, so its timer is switched off first. Instances, Releases and Backups stay, under `/srv/dcabsm`, along with `/etc/dcabsm`, the systemd units and the Nginx files. Running Instances keep running. Reinstalling DCABSM picks them up again.

## Documentation

- [docs/cli.md](docs/cli.md): every command, its flags, prompts and messages.
- [docs/spec/v1.md](docs/spec/v1.md): the V1 specification, how everything works underneath.
- [GLOSSARY.md](GLOSSARY.md): the terms DCABSM uses, such as Release, Instance and Regroup.
- [docs/adr/](docs/adr/): the reasons behind the larger choices.
- [docs/roadmap.md](docs/roadmap.md): what isn't in V1 and might come later.
- [docs/git-workflow.md](docs/git-workflow.md): branches, pull requests, merging and release tags.

## Licence

MIT, matching Actual. See [LICENSE](LICENSE).
