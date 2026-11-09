/** The oldest Actual Release DCABSM supports (spec 1.5). Raise it here. */
export const RELEASE_FLOOR = "26.10.0";

/**
 * The newest Node major DCABSM will run a Release on (spec 3.1). A DCABSM
 * release raises it only after the container layer passes on that major.
 */
export const NODE_CEILING = 24;

export const ACTUAL_PACKAGE = "@actual-app/sync-server";

/** A stable version: three numbers, nothing else (spec 1.5). */
export const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/** The file, inside a Release directory, that records its Node major for good (spec 3.1). */
export const NODE_MAJOR_FILE = ".dcabsm-node-major";
