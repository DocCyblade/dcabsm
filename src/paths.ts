import { join } from "node:path";

/** Every path DCABSM touches, hung off one configurable root (spec 13.1). */
export interface Paths {
  root: string;
  hostConfig: string;
  lock: string;
  instances: string;
  releases: string;
}

export function pathsUnder(root: string): Paths {
  return {
    root,
    hostConfig: join(root, "etc/dcabsm/dcabsm.json"),
    lock: join(root, "run/lock/dcabsm.lock"),
    instances: join(root, "srv/dcabsm/instances"),
    releases: join(root, "srv/dcabsm/releases"),
  };
}
