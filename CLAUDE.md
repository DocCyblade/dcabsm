# DCABSM

DocCyblade's Actual Budget Server Manager: a CLI that installs and maintains several Actual Budget servers (Instances) on one Host. `README.md` covers what it does and who it's for.

## Where things are
- `docs/spec/v1.md`: the V1 specification. It's the source of truth for behaviour.
- `docs/cli.md`: every command, flag, prompt and message.
- `GLOSSARY.md`: the domain terms. Use them exactly as written, with their capitals, such as Release, Instance, Host and Regroup.
- `docs/adr/`: the reasons behind the larger choices. Read the relevant ADR before changing something it covers.
- `docs/roadmap.md`: what's out of V1. Don't build roadmap items unasked.

## Branches
- `main` is published and runs CI. Changes reach it only through a pull request (spec 13.3).
- Jump-start work happens on `docs/v1-jumpstart` until it is ready to merge.
- Remotes: `origin` (GitHub, public) and `Backup`. Push work branches to `Backup`. Push to `origin` only when asked.
