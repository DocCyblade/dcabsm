import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../args.ts";
import { backupRoot, logicalBackupRoot, timeStamp } from "../backup/archive.ts";
import { hasData, takeBackup } from "../backup/create.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { exists, writeFileAtomic } from "../fsutil.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import { confirmName } from "../prompt.ts";
import type { Invocation } from "../table.ts";
import { stopInstance } from "./controls.ts";
import { accountOf, checkName, instanceDir, refuseIfChanging, requireInstance } from "./record.ts";

/**
 * Takes the vhost out, tests and reloads Nginx (spec 4.7 step 4). If `nginx -t` fails the vhost goes
 * back and nothing is reloaded.
 */
async function removeVhost(ctx: Context, name: string): Promise<void> {
  const path = join(instanceDir(ctx, name), "nginx", "vhost.conf");
  const old = await readFile(path, "utf8").catch(() => undefined);
  await rm(path, { force: true });
  try {
    const failure = await nginxTestFailure(ctx);
    if (failure) throw new CliError(`nginx -t failed: ${failure}`);
    await systemctl(ctx, "reload", "nginx");
  } catch (err) {
    if (old !== undefined) await writeFileAtomic(path, old, 0o600);
    throw err;
  }
  step(ctx, "done", "Nginx site removed, nginx -t passed, reloaded");
}

/** `instance remove <name> [--confirm <name>]` (spec 4.7) */
export async function instanceRemove({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, { confirm: { type: "string" } });
  if (positionals.length !== 1) {
    throw refusal(
      "Give one Instance name.",
      "Usage: dcabsm instance remove <name> [--confirm <name>]",
    );
  }
  const name = positionals[0]!;
  checkName(name);
  await requireInstance(ctx, name);
  await refuseIfChanging(ctx, name);

  const account = accountOf(name);
  const removed = `${name}.removed-${timeStamp(ctx.now())}`;
  const logicalRemoved = `${await logicalBackupRoot(ctx)}/${removed}`;
  ctx.io.out(`Remove ${name}`);
  ctx.io.out(
    `  · Takes a final backup, then deletes the Instance, its account ${account} and its Nginx site.`,
  );
  ctx.io.out(`  · Its backups stay in ${logicalRemoved}/ until you delete them by hand.`);
  await confirmName(ctx, name, values);

  await stopInstance(ctx, name);
  step(ctx, "done", `Stopped ${name}`);

  if (await hasData(instanceDir(ctx, name))) {
    try {
      await takeBackup(ctx, name, "final");
    } catch (err) {
      throw new CliError(
        `${name} was not removed: the final backup failed: ${errorMessage(err)}`,
        `${name} is stopped. Fix the problem and run the command again, or start it: sudo dcabsm instance start ${name}`,
      );
    }
  } else {
    step(ctx, "info", `${name} has never started, so it has no data: no final backup was taken.`);
  }

  const root = await backupRoot(ctx);
  const kept = join(root, name);
  const moved = await exists(kept);
  if (moved) await rename(kept, join(root, removed));

  try {
    await removeVhost(ctx, name);
  } catch (err) {
    if (moved) await rename(join(root, removed), kept);
    throw err instanceof CliError
      ? new CliError(
          err.message,
          `${name} is stopped and nothing was deleted. Fix Nginx, then run the command again.`,
        )
      : err;
  }

  await rm(instanceDir(ctx, name), { recursive: true, force: true });
  const res = await ctx.runner.run("userdel", [account]);
  if (res.code !== 0) {
    throw new CliError(
      `Deleted ${name} but could not delete the account ${account}: ${res.stderr.trim() || `exit ${res.code}`}`,
      `Run: sudo userdel ${account}`,
    );
  }
  step(ctx, "done", `Deleted Instance and account ${account}`);
  if (moved) step(ctx, "done", `Backups moved to ${logicalRemoved}/`);
}
