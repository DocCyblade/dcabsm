import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { refusal } from "../errors.ts";
import { exists } from "../fsutil.ts";
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
}

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
