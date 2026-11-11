# Fixtures

`actual-26.10.0/account.sqlite` and `actual-26.11.0/account.sqlite` are the empty account database that
the real `@actual-app/sync-server` Release creates. They were made by installing that Release from npm and
running its own `build/scripts/run-migrations.js up` against an empty directory, so the `files` table and
every other table are Actual's own. Regroup (ADR-0004) is tested against them.

Group files have no fixture: the test creates them with the schema from Actual's `src/sql/messages.sql`.
