import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { backupPath } from "../backup/archive.ts";
import { takeBackup } from "../backup/create.ts";
import { CliError, errorMessage, firstLine } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import { regroup } from "./regroup.ts";
import { accountOf, instanceDir, unitName } from "./record.ts";

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

/**
 * Regroups the Budget files in `server-files/` (spec 7.5) and sets ownership. An Instance that never
 * started has no `account.sqlite` and nothing to regroup. Returns how many files were regrouped.
 */
export async function regroupData(ctx: Context, name: string): Promise<number> {
  const dir = instanceDir(ctx, name);
  const serverFiles = join(dir, "server-files");
  const count = (await exists(join(serverFiles, "account.sqlite")))
    ? await regroup(serverFiles, join(dir, "user-files"))
    : 0;
  await chownData(ctx, name);
  return count;
}

/** The restore core (spec 7.4): replaces the data from `archive`, then regroups. Returns the Regroup count. */
export async function restoreAndRegroup(
  ctx: Context,
  name: string,
  archive: string,
): Promise<number> {
  await restoreData(ctx, name, archive);
  return regroupData(ctx, name);
}

/** The "Regrouped N Budget files" line. */
export const regroupedLine = (count: number): string =>
  `Regrouped ${count} Budget file${count === 1 ? "" : "s"}`;

/**
 * Stops the Instance and takes its `pre-restore` Backup, returning the path. If that fails nothing
 * has changed yet, so an Instance that was running goes back up (a failed start is only a warning)
 * and the original error is rethrown.
 */
export async function stopAndBackUp(ctx: Context, name: string, wasUp: boolean): Promise<string> {
  const unit = unitName(name);
  await systemctl(ctx, "stop", unit);
  step(ctx, "done", `Stopped ${name}`);
  try {
    return await backupPath(ctx, name, await takeBackup(ctx, name, "pre-restore"));
  } catch (err) {
    if (wasUp) {
      try {
        await systemctl(ctx, "start", unit);
        step(ctx, "info", `${name} was running before, so it is started again`);
      } catch (again) {
        step(ctx, "warn", `Could not start ${name} again: ${errorMessage(again)}`);
      }
    }
    throw err;
  }
}
