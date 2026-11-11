import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { CliError, firstLine } from "../errors.ts";
import { accountOf, instanceDir } from "./record.ts";

/** What a restore replaces; everything else in the Instance directory stays (spec 7.4). */
export const DATA_DIRS = ["data", "server-files", "user-files"];

/**
 * Replaces `data/`, `server-files/` and `user-files/` with the ones in an archive, owned by the
 * Instance's account. It extracts to a work directory first, so a bad archive leaves the data as it
 * was. It does not Regroup (spec 7.5): after a failed Upgrade nothing was lost, so none is needed.
 */
export async function restoreData(ctx: Context, name: string, archive: string): Promise<void> {
  const dir = instanceDir(ctx, name);
  const stage = join(dir, ".restoring");
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    const res = await ctx.runner.run("tar", [
      "-xzf",
      archive,
      "--numeric-owner",
      "-p",
      "-C",
      stage,
      ...DATA_DIRS,
    ]);
    if (res.code !== 0) {
      throw new CliError(
        `tar could not read ${archive}: ${firstLine(res.stderr, `exit ${res.code}`)}`,
      );
    }
    const found = new Set(await readdir(stage));
    for (const d of DATA_DIRS) {
      if (!found.has(d)) throw new CliError(`${archive} holds no ${d}/, so it cannot be restored.`);
    }
    for (const d of DATA_DIRS) {
      await rm(join(dir, d), { recursive: true, force: true });
      await rename(join(stage, d), join(dir, d));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  await chownData(ctx, name);
}

/** Sets ownership of the restored directories from the account name (spec 7.4). */
export async function chownData(ctx: Context, name: string): Promise<void> {
  const dir = instanceDir(ctx, name);
  const account = accountOf(name);
  const chown = await ctx.runner.run("chown", [
    "-R",
    `${account}:${account}`,
    ...DATA_DIRS.map((d) => join(dir, d)),
  ]);
  if (chown.code !== 0) {
    throw new CliError(`chown failed: ${firstLine(chown.stderr, `exit ${chown.code}`)}`);
  }
}
