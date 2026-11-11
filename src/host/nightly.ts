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

/** What one Instance's turn came to, and the note for the summary. */
interface Outcome {
  result: Result;
  detail: string;
}

/**
 * One Instance's turn (spec 8.1, 8.2), under the lock for that Instance alone. Returns the result and a
 * note for the summary. Retention runs only after the `scheduled` Backup succeeded, or for an Instance
 * with scheduled Backups off (spec 8.3).
 */
async function nightlyInstance(ctx: Context, name: string): Promise<Outcome> {
  let release: () => Promise<void>;
  try {
    release = await acquireLockWaiting(ctx, "dcabsm host nightly");
  } catch (err) {
    return {
      result: "failed",
      detail: `skipped after waiting 10 minutes for the lock: ${errorMessage(err)}`,
    };
  }
  try {
    const record = await readRecord(ctx, name);
    if (!record) return { result: "failed", detail: "has no readable instance.json" };
    if (await isChanging(ctx, name)) {
      return {
        result: "failed",
        detail: "has an unfinished Release change (.changing-release)",
      };
    }
    if (!record.scheduledBackups) {
      const pruned = await pruneInstance(ctx, name);
      return { result: "skipped", detail: `scheduled backups are off; pruned ${pruned.length}` };
    }
    if (!(await hasData(instanceDir(ctx, name)))) {
      return { result: "skipped", detail: "has never started, so there is nothing to back up" };
    }
    const file = await takeBackup(ctx, name, "scheduled");
    try {
      const pruned = await pruneInstance(ctx, name);
      return { result: "ok", detail: `${file}; pruned ${pruned.length}` };
    } catch (err) {
      // The Backup is safe, but the run still has to show that Retention did not finish.
      return { result: "failed", detail: `Backup ok, prune failed: ${errorMessage(err)}` };
    }
  } catch (err) {
    return { result: "failed", detail: errorMessage(err) };
  } finally {
    await release();
  }
}

/** `host nightly`: what `dcabsm-nightly.service` runs. It takes the lock per Instance, not for the run. */
export async function hostNightly({ ctx }: Invocation): Promise<number> {
  const names = await instanceNames(ctx);
  ctx.io.out(`Nightly run: ${names.length} Instance${names.length === 1 ? "" : "s"}`);
  const outcomes: Array<Outcome & { name: string }> = [];
  for (const name of names) {
    const outcome = await nightlyInstance(ctx, name);
    step(
      ctx,
      outcome.result === "failed" ? "failed" : outcome.result === "ok" ? "done" : "info",
      `${name}: ${outcome.detail}`,
    );
    outcomes.push({ name, ...outcome });
  }

  ctx.io.out("");
  ctx.io.out("Summary");
  const rows = [
    ["INSTANCE", "RESULT", "DETAIL"],
    ...outcomes.map((o) => [o.name, o.result, o.detail]),
  ];
  for (const line of formatColumns(rows)) ctx.io.out(line);
  const count = (result: Result) => outcomes.filter((o) => o.result === result).length;
  const failed = count("failed");
  step(
    ctx,
    failed > 0 ? "failed" : "info",
    `${count("ok")} backed up, ${count("skipped")} skipped (no data or schedule off), ${failed} failed`,
  );
  await logChange(ctx, "host nightly", failed > 0 ? "failed" : "ok");
  return failed > 0 ? 1 : 0;
}
