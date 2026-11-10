# Development

DCABSM is TypeScript on Node 24, bundled by esbuild into one JS file. It has no runtime dependencies. The exact Node patch is in `.node-version`, and CI and the bundle target use it.

| Command          | What it does                                  |
| ---------------- | --------------------------------------------- |
| `npm ci`         | Install the tools                             |
| `npm run check`  | Typecheck, lint, format check and unit tests  |
| `npm test`       | Unit tests only (Vitest)                      |
| `npm run build`  | Bundle to `dist/dcabsm.js`                    |
| `npm run format` | Format `src`, `test` and `scripts` with oxfmt |

## Layout

- `src/table.ts`: the one noun → verb table. It drives `help` and routing. To build a command, set its `run`.
- `src/cli.ts`: routing, the root and setup guards, and the lock-and-log wrapper for changing commands.
- `src/context.ts`: the `Context` every command gets. The command runner and the fetcher are the only two seams (spec 13.1); it also carries the architecture, environment and clock.
- `src/real.ts`: the production command runner, fetcher and terminal. `src/main.ts` wires them in.
- `src/errors.ts`, `src/help.ts`, `src/version.ts`: exit codes and error text, the `help` text, and the version and layout number.
- `src/completion.ts`: generates the bash completion script from the table. `scripts/build.mjs` writes it to `dist/share/bash-completion/completions/dcabsm`. The real-bash test needs bash 5 and `bash-completion`, and skips without them (macOS ships bash 3.2).
- `scripts/build.mjs`: the esbuild bundle; it injects the version from `package.json`.
- `scripts/package.ts`, `scripts/tarball.ts`: `npm run package` (after `npm run build`) builds `dist/release/dcabsm-<ver>-linux-{amd64,arm64}.tar.gz` and `SHA256SUMS`. It fetches the Node in `.node-version`, checks it with `gpgv` against `scripts/node-release-keys.asc` (Node's active release keys; the fingerprints are in `scripts/node-release-keys.list`), and ships those keys as `share/node-release-keys.gpg`. Nothing is signed there; CI never signs.
- `install.sh`: the first-install script (spec 11.3). Its top block holds the only release-time placeholders (GitHub owner, key fingerprint, key keyring). `test/install.test.ts` fills them in and runs it under bash on a temporary root, with `curl`, `gpgv`, `uname` and `id` stubbed.
- `src/host/`: Host-level code. `os.ts` holds the supported OS table (spec 1.4), `checks.ts` the refusals (10.3), `setup.ts` `host setup`, `config.ts` `dcabsm.json`, and `notices.ts` the banner and OS warning every other command prints. `checks.ts` holds the one list of Host checks (`hostChecks`) that setup and `host doctor` share: each has a test, a severity and an optional fix. `health.ts` and `tree.ts` hold the doctor-only checks, and `doctor.ts` runs the list, asks about fixes and sets the exit code.
- `src/host/system.ts`: what the package manager and service manager say (`isInstalled`, Nginx state, `nginxTestFailure`, `systemctl`), shared by setup, doctor and `instance create`.
- `src/host/updates.ts`: `host check-updates` (the one command that uses the network for updates), the stored result and the `instance list` footer built from it.
- `src/self/`: `update.ts` is `self update` (download, `gpgv` against the installed key, extract, migrate, switch, refresh, prune); `layout.ts` is the layout gate `cli.ts` runs before every command; `migrations.ts` holds the `MIGRATIONS` table (add the step for layout n there when `LAYOUT` rises) and the hidden `self migrate`; `refresh.ts` is the hidden `self refresh`. The old version downloads and verifies, but the new version's own binary runs `migrate` and `refresh`, so each uses the new code.
- `src/instance/`: the `instance` commands. `create.ts` makes one, `list.ts` lists and shows, `controls.ts` is start, stop, restart and logs, `settings.ts` is `settings`, `set` and `unset` with `setting-table.ts` as the one table of settings (spec 4.11), `record.ts` reads `instance.json`, names, the `.changing-release` check and `runningRelease`, `files.ts` renders and writes `config.json` and the vhost, and `verify.ts` is Verification (spec 6.2).
- `src/cert.ts`: reads and checks a bring-your-own certificate and key (spec 5.5).
- `src/backup/`: `archive.ts` holds archive names, the backup directory and manifest reading, `create.ts` is `backup create` and `takeBackup`, and `list.ts` is `backup list`.
- `src/columns.ts`: the one column formatter the list and summary tables share.
- `src/args.ts`, `src/fsutil.ts`, `src/output.ts`: flag parsing, file and directory helpers, and the step marks.
- `src/paths.ts`: every path hangs off one root. `DCABSM_ROOT` moves it; the default is `/`. In the shipped completion script it is a test seam only: it lets the real-bash tests run under a temporary root.
- `src/prompt.ts`, `src/lock.ts`, `src/log.ts`: the helpers every command shares.
- `test/helpers.ts`: a `Context` on a temporary root with a faked runner and fetcher. Tests assert on the files left behind.

## Before the first release

The `release guard` job fails a `v*` tag while any of this is undone:

1. Set the GitHub owner: `GITHUB_OWNER` in `install.sh`.
2. Generate the signing key.
3. Fill `KEY_FINGERPRINT` and `KEY_KEYRING_B64` in `install.sh` (`gpg --export <fpr> | base64 | tr -d '\n'`).
4. Replace the `XXXX` fingerprint in `README.md` and `docs/cli.md`.
