import { rm } from "node:fs/promises";
import { parseCommand } from "../args.ts";
import { refusal } from "../errors.ts";
import {
  checkName,
  instanceNames,
  isChanging,
  refuseIfChanging,
  requireInstance,
} from "../instance/record.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { describeCounts, keepCounts, planPrune } from "./retention.ts";

/** `backup prune [<names>|--all] [--dry-run]` */
export async function backupPrune({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    all: { type: "boolean" },
    "dry-run": { type: "boolean" },
  });
  if (values.all && positionals.length > 0) {
    throw refusal(
      "Use --all or names, not both.",
      "Usage: dcabsm backup prune [<names>|--all] [--dry-run]",
    );
  }
  for (const name of positionals) {
    checkName(name);
    await requireInstance(ctx, name);
    await refuseIfChanging(ctx, name);
  }
  // A marker names the Backup an interrupted change is undone from, so pruning leaves that Instance alone.
  const names: string[] = [];
  for (const name of positionals.length > 0
    ? [...new Set(positionals)]
    : await instanceNames(ctx)) {
    if (positionals.length === 0 && (await isChanging(ctx, name))) {
      step(ctx, "warn", `${name}: unfinished Release change, skipped`);
    } else {
      names.push(name);
    }
  }
  const counts = await keepCounts(ctx);
  const dry = values["dry-run"] === true;

  let any = false;
  for (const name of names) {
    for (const a of await planPrune(ctx, name, counts)) {
      any = true;
      if (!dry) await rm(a.path, { force: true });
      step(ctx, "info", `${dry ? "Would delete" : "Deleted"} ${name}/${a.file}`);
    }
  }
  if (!any) {
    ctx.io.out(
      `Nothing to prune. Keeping newest ${describeCounts(counts)}; manual backups are never pruned.`,
    );
  }
}
