# The filesystem is DCABSM's only record

DCABSM keeps no central registry or database. The Instance list is the contents of `/srv/dcabsm/instances/`, the Release list is the contents of `/srv/dcabsm/releases/`, and an Instance's Release is whatever its `release` symlink points to. A registry could disagree with what's on disk, and `doctor` would then have to work out which was right, so each fact lives in one place that can be checked with `ls`.

## Consequences

- Unfinished work uses dot-prefixed names such as `.installing-26.11.0`, which listings ignore.
- `/run/lock/dcabsm.lock` stops two DCABSM commands changing state at once, because no database provides transactions.
- "Unused Releases" means Releases no `release` symlink points to.
