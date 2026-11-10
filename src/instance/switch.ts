import { rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { instanceDir, type InstanceRecord } from "./record.ts";
import { writeConfigJson } from "./files.ts";

/** Points the Instance's `release` link at a Release in one step, so it never points nowhere. */
export async function repointRelease(ctx: Context, name: string, release: string): Promise<void> {
  const link = join(instanceDir(ctx, name), "release");
  const temp = `${link}.new`;
  await rm(temp, { force: true });
  await symlink(join(ctx.paths.releases, release), temp);
  await rename(temp, link);
}

/** Repoints `release` and regenerates `config.json` for it, which drops settings it doesn't know (spec 4.4). */
export async function switchRelease(
  ctx: Context,
  name: string,
  record: InstanceRecord,
  release: string,
): Promise<void> {
  await repointRelease(ctx, name, release);
  await writeConfigJson(ctx, name, record, release);
}
