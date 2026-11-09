# Git workflow

DCABSM uses GitHub Flow: one long-lived branch, `main`, with short work branches that are squashed back into it. Releases are tags on `main`. There is no `develop` branch and there are no release branches. A Host keeps only the current and previous DCABSM version (spec 11.1), so old versions never get patched.

## main

- `main` is always releasable. Changes reach it only through a pull request with green CI (spec 13.3).
- No direct pushes, force-pushes or deletion. A GitHub ruleset enforces this, along with linear history.

## Work branches

- Branch off `main`, one ticket per branch and per pull request.
- Name it `<type>/<issue>-<slug>`, for example `feat/1-cli-skeleton` or `fix/42-lock-timeout`. The types are `feat`, `fix`, `docs`, `ci` and `chore`.
- Push work branches to `Backup` while working. Push to `origin` only when asked, which is usually when opening the pull request.

## Pull requests

- Write the body with the `/pr` template, and include `Closes #<n>` so merging closes the ticket.
- **Squash merge only.** The squash commit title is the pull request title, an imperative sentence such as "Add CLI walking skeleton (#33)". The commit body is the pull request body.
- After the merge, the branch is deleted on `origin` automatically. Delete it on `Backup` by hand.

## Releases

- A release is an annotated semver tag `vX.Y.Z` on a `main` commit. DCABSM's semver is kept apart from Actual's calendar versions (spec 11.1). Versions before V1 are `0.y.z`, and V1 is `v1.0.0`.
- The tag runs CI (spec 13.3). The author then runs the release gate (spec 13.5), signs `SHA256SUMS` on their own machine (spec 11.2) and publishes the GitHub Release.
- Push tags to both `origin` and `Backup`.

## Hotfixes

A hotfix is an ordinary `fix/` branch off `main`, squashed in, then tagged as a patch release.

## Remotes

- `origin`: GitHub, public.
- `Backup`: the private backup remote. Every branch and tag goes here.
