import { join } from "node:path";

/** Where the Instances live as the Host sees it, for text written into units and Nginx files (spec 4.5, 5.1). */
export const INSTANCES_LOGICAL = "/srv/dcabsm/instances";

/** Every path DCABSM touches, hung off one configurable root (spec 13.1). */
export interface Paths {
  root: string;
  etc: string;
  hostConfig: string;
  lock: string;
  srv: string;
  node: string;
  acme: string;
  /** The last `host check-updates` result (spec 3.5). */
  updateCheck: string;
  instances: string;
  releases: string;
  /** Node's release signing keys, shipped inside the running DCABSM version (spec 3.1). */
  nodeKeyring: string;
  osRelease: string;
  /** Where a logical absolute path, such as the stored `backupDir`, lives under the root. */
  under(logical: string): string;
}

/**
 * `installDir` is the running version's own directory, `/opt/dcabsm/<ver>`. It isn't under the root in
 * production, so main.ts derives it from where the bundle sits; tests pass a directory they own.
 */
export function pathsUnder(root: string, installDir: string): Paths {
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
    updateCheck: join(srv, "update-check.json"),
    instances: join(srv, "instances"),
    releases: join(srv, "releases"),
    nodeKeyring: join(installDir, "share/node-release-keys.gpg"),
    osRelease: under("etc/os-release"),
    under,
  };
}
