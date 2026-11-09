declare const __DCABSM_VERSION__: string | undefined;

export const VERSION: string =
  typeof __DCABSM_VERSION__ === "string" ? __DCABSM_VERSION__ : "0.0.0-dev";

/** The on-Host layout version (spec 11.4). */
export const LAYOUT = 1;

export function versionLine(): string {
  return `DCABSM ${VERSION} (layout ${LAYOUT})`;
}
