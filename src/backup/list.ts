import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../args.ts";
import { formatColumns } from "../columns.ts";
import { formatSize } from "../host/tree.ts";
import { checkName, instanceNames, requireInstance } from "../instance/record.ts";
import type { Invocation } from "../table.ts";
import { backupRoot, listArchives } from "./archive.ts";

/** `backup list [<names>]` */
export async function backupList({ ctx, args }: Invocation): Promise<void> {
  const { positionals } = parseCommand(args, {});
  for (const name of positionals) {
    checkName(name);
    await requireInstance(ctx, name);
  }
  const names = positionals.length > 0 ? [...new Set(positionals)] : await instanceNames(ctx);

  // A removed Instance's final Backup stays in `<name>.removed-<time>/` (docs/cli.md).
  const removed: string[] = [];
  if (positionals.length === 0) {
    try {
      removed.push(
        ...(await readdir(await backupRoot(ctx))).filter((n) => n.includes(".removed-")).sort(),
      );
    } catch {
      // No backup directory yet.
    }
  }
  if (names.length === 0 && removed.length === 0) {
    ctx.io.out("No Instances.");
    return;
  }

  for (const name of names) {
    ctx.io.out(name);
    const archives = await listArchives(ctx, name);
    if (archives.length === 0) {
      ctx.io.out("  No archives yet. Take one: sudo dcabsm backup create " + name);
      continue;
    }
    const table = [
      ["ARCHIVE", "KIND", "RELEASE", "SIZE"],
      ...archives.map((a) => [a.file, a.kind, a.release, formatSize(a.size)]),
    ];
    for (const line of formatColumns(table)) ctx.io.out(line);
  }
  for (const dir of removed) {
    const count = (await readdir(join(await backupRoot(ctx), dir))).filter((f) =>
      f.endsWith(".tar.gz"),
    ).length;
    ctx.io.out(`${dir}/  ${count} archive${count === 1 ? "" : "s"}, kept until you delete them`);
  }
}
