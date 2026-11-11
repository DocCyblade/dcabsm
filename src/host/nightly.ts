import { hasData, takeBackup } from "../backup/create.ts";
import { pruneInstance } from "../backup/retention.ts";
import { formatColumns } from "../columns.ts";
import type { Context } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { isChanging, instanceNames, instanceDir, readRecord } from "../instance/record.ts";
import { acquireLockWaiting } from "../lock.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";

type Result = "ok" | "skipped" | "failed";

/**
 * One Instance's turn (spec 8.1, 8.2), under the lock for that Instance alone. Returns the result and a
 * note for the summary. Retention runs only after the `scheduled` Backup succeeded, or for an Instance
 * with scheduled Backups off (spec 8.3).
 */
async function nightlyInstance(ctx: Context, name: string): Promise<[Result, string]> {
  let release: () => Promise<void>;
  try {
    release = await acquireLockWaiting(ctx, "dcabsm host nightly");
  } catch (err) {
    return ["failed", `skipped after waiting 10 minutes for the lock: ${errorMessage(err)}`];
  }
  try {
    const record = await readRecord(ctx, name);
    if (!record) return ["failed", "has no readable instance.json"];
    if (await isChanging(ctx, name)) {
      return ["failed", "has an unfinished Release change (.changing-release)"];
    }
    if (!record.scheduledBackups) {
      const pruned = await pruneInstance(ctx, name);
      return ["skipped", `scheduled backups are off; pruned ${pruned.length}`];
    }
    if (!(await hasData(instanceDir(ctx, name)))) {
      return ["skipped", "has never started, so there is nothing to back up"];
    }
    const file = await takeBackup(ctx, name, "scheduled");
    const pruned = await pruneInstance(ctx, name);
    return ["ok", `${file}; pruned ${pruned.length}`];
  } catch (err) {
    return ["failed", errorMessage(err)];
  } finally {
    await release();
  }
}

/** `host nightly`: what `dcabsm-nightly.service` runs. It takes the lock per Instance, not for the run. */
export async function hostNightly({ ctx }: Invocation): Promise<number> {
  const names = await instanceNames(ctx);
  ctx.io.out(`Nightly run: ${names.length} Instance${names.length === 1 ? "" : "s"}`);
  const rows: string[][] = [["INSTANCE", "RESULT", "DETAIL"]];
  for (const name of names) {
    const [result, detail] = await nightlyInstance(ctx, name);
    step(
      ctx,
      result === "failed" ? "failed" : result === "ok" ? "done" : "info",
      `${name}: ${detail}`,
    );
    rows.push([name, result, detail]);
  }

  ctx.io.out("");
  ctx.io.out("Summary");
  for (const line of formatColumns(rows)) ctx.io.out(line);
  const count = (result: Result) => rows.slice(1).filter((r) => r[1] === result).length;
  const failed = count("failed");
  step(
    ctx,
    failed > 0 ? "failed" : "info",
    `${count("ok")} backed up, ${count("skipped")} skipped (no data or schedule off), ${failed} failed`,
  );
  await logChange(ctx, "host nightly", failed > 0 ? "failed" : "ok");
  return failed > 0 ? 1 : 0;
}
