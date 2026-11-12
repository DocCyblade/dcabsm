# Each Release carries its own Node

Status: Accepted

DCABSM installs Node itself from official nodejs.org tarballs into `/srv/dcabsm/node/<version>/`, verified against `SHASUMS256.txt` and its signature, with one `node/<major>` symlink per major pointing at its newest patch. When a Release is installed it is linked to the newest LTS major that satisfies Actual's `engines.node`, and that link never changes. An Instance runs the Node of its Release. We chose this over one Host-wide Node from NodeSource because a Host-wide Node forces every Instance onto a new major the moment one Release needs it, which defeats test Instances.

## Considered options

- One Host-wide Node from NodeSource. Rejected: only one major per Host, and switching it changes Node for every Instance and any other software on the Host.
- Distro `nodejs`. Rejected: too old on most supported OSes, and still one per Host.
- A version manager such as nvm or fnm. Rejected: an extra tool that only downloads the same tarballs.

## Consequences

- DCABSM never installs, changes or uses the system's Node, so it coexists with any Node already on the Host.
- Rollback returns to the old Node automatically, because it returns to the old Release.
- Moving to a new Node major happens through a normal Upgrade to a Release that needs it.
- Node security patches no longer come from apt. DCABSM reports new patches and applies them on command, restarting the affected Instances.
- DCABSM ships Node's release signing keys and needs a new version if they change.
- Unused Node runtimes are removed along with unused Releases.
- This supersedes "one Host-wide Node 24 from NodeSource" in the on-Host layout ticket.
