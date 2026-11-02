## Branching & releases

- `main` is the only long-lived branch. It is protected on GitHub: changes land only through a PR with passing CI.
- Cut every change from an up-to-date `main` as a short-lived branch (`feat/...`, `fix/...`, `docs/...`, `chore/...`) and open the PR against `main`: `gh pr create --base main`.
- One issue → one branch → one PR. Keep PRs to a single vertical slice.
- Merge PRs with **squash and merge** only (merge commits and rebase merging are disabled on GitHub). The PR title and body become the commit on `main`, so write them as the final commit message, in the `pr` skill's shape. Include any `Co-Authored-By` trailer in the PR body.
- Never commit or push directly to `main`, including docs-only changes.
- Every PR that changes user-facing behavior includes a changeset (`npx changeset`). Docs, tests, and chore-only PRs may skip it.
- Releases: run `npx changeset version` on a `chore/release` branch and merge it by PR. Then tag `v<version>` on `main`; the tag triggers npm publish.
- Pre-releases use changesets pre mode (`npx changeset pre enter next`) and publish to the `next` dist-tag. No extra branch is needed.
- After merging, push `main` to both `origin` and the `Backup` remote.
- Delete feature branches after merge. GitHub deletes the `origin` branch automatically; delete the local one with `git branch -D` (squash merges leave it looking unmerged).
