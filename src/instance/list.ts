import { readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { refusal } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { readHostConfig } from "../host/config.ts";
import { updateFooter } from "../host/updates.ts";
import { releaseNodeMajor } from "../release/install.ts";
import { linkedPatch } from "../release/node.ts";
import type { Invocation } from "../table.ts";
import { VERSION } from "../version.ts";
import {
  accountOf,
  instanceDir,
  instanceNames,
  readRecord,
  requireInstance,
  type InstanceRecord,
} from "./record.ts";

export interface InstanceRow {
  name: string;
  state: string;
  release: string;
  record: InstanceRecord;
}

/** `CHANGING` while a Release change is unfinished, else the unit's state (`stopped` when inactive). */
async function stateOf(ctx: Context, name: string): Promise<string> {
  if (await exists(join(instanceDir(ctx, name), ".changing-release"))) return "CHANGING";
  const res = await ctx.runner.run("systemctl", ["is-active", `dcabsm@${name}`]);
  const state = res.stdout.trim();
  return state === "" || state === "inactive" ? "stopped" : state;
}

async function releaseOf(ctx: Context, name: string): Promise<string> {
  try {
    return basename(await readlink(join(instanceDir(ctx, name), "release")));
  } catch {
    return "?";
  }
}

async function rowFor(ctx: Context, name: string, record: InstanceRecord): Promise<InstanceRow> {
  return { name, state: await stateOf(ctx, name), release: await releaseOf(ctx, name), record };
}

/** The overview table, one line per Instance. Later tickets add columns and a footer. */
export function renderInstanceTable(rows: InstanceRow[]): string[] {
  const table = [
    ["INSTANCE", "STATE", "RELEASE", "HOSTNAME", "PORT"],
    ...rows.map((r) => [r.name, r.state, r.release, r.record.hostname, String(r.record.port)]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  return table.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]! + 2)))
      .join("")
      .trimEnd(),
  );
}

/** `instance list` */
export async function instanceList({ ctx }: Invocation): Promise<void> {
  const rows: InstanceRow[] = [];
  for (const name of await instanceNames(ctx)) {
    const record = await readRecord(ctx, name);
    if (record) rows.push(await rowFor(ctx, name, record));
  }
  if (rows.length === 0) {
    ctx.io.out("No Instances.");
    ctx.io.out("  Create one: sudo dcabsm instance create <name> --hostname <host> --self-signed");
    return;
  }
  for (const line of renderInstanceTable(rows)) ctx.io.out(line);
  const footer = await updateFooter(ctx);
  const nightly = (await readHostConfig(ctx))?.nightlyTime;
  const parts = [`DCABSM ${VERSION}`];
  if (nightly) parts.push(`Nightly run ${nightly}`);
  if (footer.lastCheck) parts.push(`last check ${footer.lastCheck}`);
  ctx.io.out("");
  ctx.io.out(parts.join(" · "));
  for (const line of footer.lines) ctx.io.out(line);
}

/** `instance show <name>` */
export async function instanceShow({ ctx, args }: Invocation): Promise<void> {
  const { positionals } = parseCommand(args, {});
  if (positionals.length !== 1) {
    throw refusal("Give one Instance name.", "Usage: dcabsm instance show <name>");
  }
  const name = positionals[0]!;
  const record = await requireInstance(ctx, name);
  const row = await rowFor(ctx, name, record);

  const major = await releaseNodeMajor(ctx, row.release);
  const patch = major === undefined ? undefined : await linkedPatch(ctx, major);
  const fields: Array<[string, string]> = [
    ["Hostname", `https://${record.hostname}`],
    ["Release", patch ? `${row.release} (Node ${patch})` : row.release],
    ["Port", `127.0.0.1:${record.port}`],
    ["Account", accountOf(name)],
    ["Scheduled backups", record.scheduledBackups ? "on" : "off"],
  ];
  ctx.io.out(`${name}  ${row.state}`);
  for (const [label, value] of fields) ctx.io.out(`  ${label.padEnd(17)}  ${value}`);
}
