import { readFile } from "node:fs/promises";
import type { Context } from "../context.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { LAYOUT } from "../version.ts";

export const DEFAULT_BACKUP_DIR = "/srv/dcabsm/backups";

export interface UnsupportedHostMark {
  /** The date of the first override, `YYYY-MM-DD`. */
  since: string;
  /** Every override ever used, such as `DCABSM_ALLOW_CONTAINER`. */
  overrides: string[];
}

/** `/etc/dcabsm/dcabsm.json` (spec 2.3). */
export interface HostConfig {
  layout: number;
  backupDir: string;
  nightlyTime: string;
  /** Retention count per Backup kind (spec 8.3). */
  keep: Record<string, number>;
  /** A hash of each owned file DCABSM last wrote (spec 10.5). */
  ownedFiles: Record<string, string>;
  unsupportedHost?: UnsupportedHostMark;
}

export function defaultHostConfig(backupDir: string): HostConfig {
  return {
    layout: LAYOUT,
    backupDir,
    nightlyTime: "03:30",
    keep: { scheduled: 14, "pre-upgrade": 5, "pre-restore": 5, "pre-clone": 5 },
    ownedFiles: {},
    unsupportedHost: undefined,
  };
}

/** Reads what is stored, or undefined when the file is missing or isn't JSON. */
export async function readHostConfig(ctx: Context): Promise<Partial<HostConfig> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ctx.paths.hostConfig, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Partial<HostConfig>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function writeHostConfig(ctx: Context, config: Partial<HostConfig>): Promise<void> {
  await writeFileAtomic(ctx.paths.hostConfig, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

/** Adds to the permanent mark (spec 10.4). It is never cleared. */
export function markUnsupported(
  config: Partial<HostConfig>,
  overrides: string[],
  today: string,
): Partial<HostConfig> {
  if (overrides.length === 0) return config;
  const before = config.unsupportedHost;
  const all = [...new Set([...(before?.overrides ?? []), ...overrides])];
  return { ...config, unsupportedHost: { since: before?.since ?? today, overrides: all } };
}

export function bannerLine(mark: UnsupportedHostMark): string {
  return `UNSUPPORTED HOST: a safety check was overridden on ${mark.since}. You are on your own.`;
}
