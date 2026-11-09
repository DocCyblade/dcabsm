# OpenID belongs to Actual, not DCABSM

DCABSM never writes `openId.*` into an Instance's `config.json`, and the System Admin sets up OpenID in Actual's own web UI. Actual stores OpenID, client secret included, in `server-files/account.sqlite`, and login reads it from there. When config sets OpenID, Actual writes it over that row on every start, but removing it from config leaves the row, so config and the database would both claim to be in charge. Leaving OpenID to Actual means one place is in charge, and DCABSM never holds the client secret. This was read from the 26.10.0 and 26.11.0 source on 2026-11-09.

## Considered options

- Expose `openId.*` as Instance settings, with the secret in the Instance record. Rejected: the secret would sit in `config.json`, which the Instance account can read, and in every Backup's copy of the record. Turning OpenID off from DCABSM wouldn't remove it from the database either.
- Expose them with the secret in a root-owned file passed through `ACTUAL_OPENID_CLIENT_SECRET_FILE`. Rejected for V1: it solves the secret but not the two places in charge, and Actual's UI already does the job.

## Consequences

- `docs/cli.md` gives the UI steps and the redirect URL, `https://<hostname>`.
- `openid-enforce` and `openid-user-creation` are still Instance settings, because Actual reads them only from config.
- Backups and Clones carry OpenID, secret included, because they carry `server-files/`. The Backup warning says so.
- `instance reset-password` finds out whether an Instance is OpenID-only from Actual's database, not from the Instance record.
- If DCABSM ever manages OpenID itself, it must also clear the database row when OpenID is removed, and pass the secret through the `_FILE` variable.
