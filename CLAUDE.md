# DCABSM

DocCyblade's Actual Budget Server Manager: a CLI that installs and maintains several Actual Budget servers (Instances) on one Host. `README.md` covers what it does and who it's for.

## Where things are
- `docs/spec/v1.md`: the V1 specification. It's the source of truth for behaviour.
- `docs/cli.md`: every command, flag, prompt and message.
- `GLOSSARY.md`: the domain terms. Use them exactly as written, with their capitals, such as Release, Instance, Host and Regroup.
- `docs/adr/`: the reasons behind the larger choices. Read the relevant ADR before changing something it covers.
- `docs/roadmap.md`: what's out of V1. Don't build roadmap items unasked.
- `docs/git-workflow.md`: branches, PRs, merging, tags and remotes. Read it before any git work.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for DocCyblade/dcabsm, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default role labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: the root `GLOSSARY.md` plus `docs/adr/`. See `docs/agents/domain.md`.
