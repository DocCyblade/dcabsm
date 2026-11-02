## Git workflow

- `main`: release branch, protected on GitHub. Updated only by a PR from `dev`.
- `dev`: integration branch. Cut feature branches from `dev` (`feat/...`, `fix/...`) and merge them back with a PR targeting `dev`: `gh pr create --base dev` (the GitHub default branch is `main`, so `--base dev` is required).
- Exception: docs-only changes may be committed directly on `dev`, but only when the user has approved that commit.
- Never commit code directly to `dev` or `main`, and never push to `main` directly.
- Push `dev` to both `origin` and the `Backup` remote.
- Delete feature branches after merge.

