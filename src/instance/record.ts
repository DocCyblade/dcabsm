import { readdir, readFile, readlink, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { exists, readTextOr, writeFileAtomic } from "../fsutil.ts";
import { INSTANCES_LOGICAL } from "../paths.ts";

/** The first port an Instance can take (spec 4.3). */
export const FIRST_PORT = 15127;

/** An Instance name (spec 4.1). */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** `config/instance.json` (spec 4.4). Settings the System Admin set are added by later tickets. */
export interface InstanceRecord {
  port: number;
  hostname: string;
  scheduledBackups: boolean;
  /** Only what the System Admin set; nothing for a setting at its default (spec 4.11). */
  settings?: Record<string, number | boolean | string>;
}

/** The systemd unit of one Instance. */
export const unitName = (name: string): string => `dcabsm@${name}`;

export const accountOf = (name: string): string => `dcabsm-${name}`;

/** Where an Instance lives as the Host sees it, for text written into files. */
export const logicalDir = (name: string): string => `${INSTANCES_LOGICAL}/${name}`;

export const instanceDir = (ctx: Context, name: string): string => join(ctx.paths.instances, name);

export const recordPath = (ctx: Context, name: string): string =>
  join(instanceDir(ctx, name), "config", "instance.json");

export async function readRecord(ctx: Context, name: string): Promise<InstanceRecord | undefined> {
  try {
    return JSON.parse(await readFile(recordPath(ctx, name), "utf8")) as InstanceRecord;
  } catch {
    return undefined;
  }
}

/** Instance names, in order. Dot-prefixed work directories are ignored. */
/** Writes `config/instance.json` (spec 4.4). */
export async function writeRecord(
  ctx: Context,
  name: string,
  record: InstanceRecord,
): Promise<void> {
  await writeFileAtomic(recordPath(ctx, name), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export async function instanceNames(ctx: Context): Promise<string[]> {
  try {
    return (await readdir(ctx.paths.instances)).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}

export function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw refusal(
      `${JSON.stringify(name)} is not a valid Instance name.`,
      "Use a lowercase letter first, then lowercase letters, digits or hyphens, 24 characters at most.",
    );
  }
}

/** The Instance's record, or a refusal that points to `instance list`. */
export async function requireInstance(ctx: Context, name: string): Promise<InstanceRecord> {
  const record = (await exists(instanceDir(ctx, name))) ? await readRecord(ctx, name) : undefined;
  if (!record) {
    throw refusal(`There is no Instance named ${name}.`, "See the list: dcabsm instance list");
  }
  return record;
}

/** The marker an unfinished Release change leaves in the Instance directory. */
export const changingMarker = (ctx: Context, name: string): string =>
  join(instanceDir(ctx, name), ".changing-release");

export const isChanging = (ctx: Context, name: string): Promise<boolean> =>
  exists(changingMarker(ctx, name));

/** What `.changing-release` records (spec 6.6). */
export interface ChangeMarker {
  operation: "upgrade" | "rollback" | "restore";
  from: string;
  to: string;
  /** The Backup the change can be undone from, as a path on disk. */
  backup: string;
  /** True while data is being restored. */
  restoringData: boolean;
  /** The archive a restore reads. In a restore the `backup` is its `pre-restore` Backup, so this names the source. */
  archive?: string;
}

export async function writeMarker(ctx: Context, name: string, marker: ChangeMarker): Promise<void> {
  await writeFileAtomic(changingMarker(ctx, name), `${JSON.stringify(marker, null, 2)}\n`, 0o600);
}

/** The marker, or undefined when there is none or it is not readable JSON. */
export async function readMarker(ctx: Context, name: string): Promise<ChangeMarker | undefined> {
  try {
    return JSON.parse((await readTextOr(changingMarker(ctx, name))) ?? "") as ChangeMarker;
  } catch {
    return undefined;
  }
}

export const removeMarker = (ctx: Context, name: string): Promise<void> =>
  rm(changingMarker(ctx, name), { force: true });

/** " (upgrade, 26.10.0 → 26.11.1)" for the marker, or "" when it cannot be read. */
export async function changeDetail(ctx: Context, name: string): Promise<string> {
  const marker = await readMarker(ctx, name);
  return marker ? ` (${marker.operation}, ${marker.from} → ${marker.to})` : "";
}

/**
 * The one rule for an unfinished Release change (spec 6.6): every changing command for the Instance
 * calls this and refuses, except `instance rollback`, which is how the change is finished.
 */
export async function refuseIfChanging(ctx: Context, name: string): Promise<void> {
  if (!(await isChanging(ctx, name))) return;
  const detail = await changeDetail(ctx, name);
  throw refusal(
    `${name} has an unfinished Release change${detail}.`,
    `Only rollback can run now: sudo dcabsm instance rollback ${name}`,
  );
}

/** One line for list and show: what is unfinished, or undefined when nothing is. */
export async function changeSummary(ctx: Context, name: string): Promise<string | undefined> {
  if (!(await isChanging(ctx, name))) return undefined;
  return `unfinished Release change${await changeDetail(ctx, name)}`;
}

/** The Release the Instance's `release` link points to. */
export async function runningRelease(ctx: Context, name: string): Promise<string> {
  try {
    return basename(await readlink(join(instanceDir(ctx, name), "release")));
  } catch {
    throw new CliError(`${name} has no Release link.`, "Run: sudo dcabsm host doctor");
  }
}
