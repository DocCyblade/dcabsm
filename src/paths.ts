import { join } from "node:path";

/** Every path DCABSM touches, hung off one configurable root (spec 13.1). */
export interface Paths {
  root: string;
  etc: string;
  hostConfig: string;
  lock: string;
  srv: string;
  node: string;
  acme: string;
  instances: string;
  releases: string;
  /** Node's release signing keys, shipped with DCABSM (spec 3.3). */
  nodeKeyring: string;
  osRelease: string;
  /** Where a logical absolute path, such as the stored `backupDir`, lives under the root. */
  under(logical: string): string;
}

export function pathsUnder(root: string): Paths {
  const under = (logical: string) => join(root, logical);
  const srv = under("srv/dcabsm");
  const etc = under("etc/dcabsm");
  return {
    root,
    etc,
    hostConfig: join(etc, "dcabsm.json"),
    lock: under("run/lock/dcabsm.lock"),
    srv,
    node: join(srv, "node"),
    acme: join(srv, "acme"),
    instances: join(srv, "instances"),
    releases: join(srv, "releases"),
    nodeKeyring: under("opt/dcabsm/share/node-release-keys.gpg"),
    osRelease: under("etc/os-release"),
    under,
  };
}
