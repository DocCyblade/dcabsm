# Every restore regroups

After restoring data into an Instance, DCABSM gives each Budget file a new group id in `account.sqlite` and renames its `group-<id>.sqlite` to match, keeping every message. Without this, the first device that opens the app re-sends every change made after the backup, and the restore is silently undone. With it, each device shows Actual's "Syncing has been reset on this cloud file" dialog, and **Revert** brings it exactly to the restored data. Both were tested in Chromium on 2026-11-07, in the browser test behind this decision. The server is the source of truth, so DCABSM enforces this itself rather than relying on the System Admin to remember it.

## Considered options

- Restore files only and tell the System Admin to reset sync. Rejected: a sync reset from a device uploads that device's copy, which undoes the restore.
- Regroup only when devices are likely to have synced since the backup. Rejected: DCABSM can't see devices, so it can't know.
- Skip the regroup for clones, which live on another hostname and so never share local copies with the source. Rejected: one rule is simpler, and it protects against a budget being carried between the two later.

## Consequences

- Every restore, `rollback --restore-data` and clone regroups. The only exception is the automatic rollback after a failed upgrade: the Instance was stopped from the backup until then, so no device synced anything the restore removes.
- Restore must tell the System Admin to click **Revert** on every device, never "upload this file to be the latest version", and that unsynced device changes are lost.
- A budget created after the backup comes back if a device registers it again.
- DCABSM depends on Actual's `account.sqlite` schema and group file naming, so a Release that changes them needs a matching DCABSM change.
- Regroup is untested with end-to-end encrypted budgets.
