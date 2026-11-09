# DCABSM ships as a signed tarball with its own Node

DCABSM is distributed as one tarball per architecture from GitHub Releases, holding its bundled JS and a pinned official Node, installed to `/opt/dcabsm/<ver>/`. The tarballs are listed in `SHA256SUMS`, which the author signs with OpenPGP on their own machine, and DCABSM checks updates only against the key it already has. We chose this because setup must run before any managed Node runtime exists, DCABSM runs as root, and the `gpgv` check it needs for Node downloads can check its own downloads too.

## Considered options

- npm package on a managed Node runtime. Rejected: needs a bootstrap that installs Node first, and DCABSM's runtime would become a special case among the runtimes Releases own.
- A single executable built with Node's SEA feature. Rejected: still in active development and awkward with bundling.
- A `.deb` in an apt repo. Rejected: a signed repo to host and packaging per OS.
- Signing in CI, or Sigstore and GitHub attestations. Rejected: trust would rest on GitHub, so a compromised account could sign.

## Consequences

- DCABSM's own Node gets patches only through new DCABSM versions.
- The first install trusts HTTPS and GitHub unless the System Admin compares the key fingerprint with the README or `keys.openpgp.org`. Every later Self-update is protected even if GitHub is compromised.
- Rotating the key needs a Self-update signed by the old key; losing it needs a manual reinstall on every Host.
- A compromised CI could still build a tarball the author signs. Reproducible builds are on the roadmap.
