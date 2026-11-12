import { readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { refusal } from "../errors.ts";
import { instanceListFooter } from "../host/updates.ts";
import { listArchives, stampTime } from "../backup/archive.ts";
import { certColumn } from "../certs/probe.ts";
import { formatColumns } from "../columns.ts";
import { step } from "../output.ts";
import { releaseNodeMajor } from "../release/install.ts";
import { linkedPatch } from "../release/node.ts";
import type { Invocation } from "../table.ts";
import { settingsSummary } from "./setting-table.ts";
import {
  accountOf,
  changeSummary,
  instanceDir,
  instanceNames,
  isChanging,
  readRecord,
  requireInstance,
  unitName,
  type InstanceRecord,
} from "./record.ts";

/** What `instance list` shows: `CHANGING`, `stopped`, or what `systemctl is-active` says. */
/** One labelled line of `instance show`. */
type Field = [label: string, value: string];

export type InstanceState =
  | "CHANGING"
  | "stopped"
  | "active"
  | "activating"
  | "deactivating"
  | "reloading"
  | "failed"
  | "unknown";

const UNIT_STATES: readonly string[] = [
  "active",
  "activating",
  "deactivating",
  "reloading",
  "failed",
];

export interface InstanceRow {
  name: string;
  state: InstanceState;
  release: string;
  record: InstanceRecord;
  /** Days left on the certificate file, such as `212d` or `300d self-signed`. */
  cert: string;
  /** `off`, `none`, or the newest scheduled Backup as `MM-DD HH:MM UTC`. */
  lastScheduled: string;
  /** Scheduled Backups are on and none is newer than 48 hours (spec 7.3). */
  overdue: boolean;
}

const OVERDUE_MS = 48 * 60 * 60 * 1000;

/** Younger than 48 hours by its recorded creation time: no Nightly run is due yet. Unknown age, or a creation time in the future, is not young. */
function isYoung(ctx: Context, record: InstanceRecord): boolean {
  const created = Date.parse(record.createdAt ?? "");
  const age = ctx.now().getTime() - created;
  return age >= 0 && age < OVERDUE_MS; // NaN (unparsable) and a future date are both false
}

/** The LAST SCHEDULED column (docs/cli.md) and whether the schedule looks broken. */
export async function scheduleOf(ctx: Context, name: string, record: InstanceRecord) {
  if (!record.scheduledBackups) return { lastScheduled: "off", overdue: false };
  const newest = (await listArchives(ctx, name)).filter((a) => a.kind === "scheduled").at(-1);
  if (!newest) return { lastScheduled: "none", overdue: !isYoung(ctx, record) };
  const s = newest.stamp;
  return {
    lastScheduled: `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(9, 11)}:${s.slice(11, 13)} UTC`,
    overdue: ctx.now().getTime() - stampTime(s).getTime() > OVERDUE_MS,
  };
}

/** `CHANGING` while a Release change is unfinished, else the unit's state (`stopped` when inactive). */
export async function stateOf(ctx: Context, name: string): Promise<InstanceState> {
  if (await isChanging(ctx, name)) return "CHANGING";
  return unitStateOf(ctx, name);
}

/** What `systemctl is-active` says about the unit (`stopped` when inactive). */
export async function unitStateOf(ctx: Context, name: string): Promise<InstanceState> {
  const res = await ctx.runner.run("systemctl", ["is-active", unitName(name)]);
  const state = res.stdout.trim();
  if (state === "" || state === "inactive") return "stopped";
  return UNIT_STATES.includes(state) ? (state as InstanceState) : "unknown";
}

/** When the Instance's unit last became active, or undefined if it is not running or systemd won't say. */
export async function startedAt(ctx: Context, name: string): Promise<Date | undefined> {
  const res = await ctx.runner.run("systemctl", [
    "show",
    "--timestamp=utc",
    "-p",
    "ActiveEnterTimestamp",
    "--value",
    unitName(name),
  ]);
  const m = /(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)/.exec(res.stdout);
  return m ? new Date(`${m[1]}T${m[2]}Z`) : undefined;
}

/** The unit's main process id, or undefined when it has none. */
export async function mainPid(ctx: Context, name: string): Promise<number | undefined> {
  const res = await ctx.runner.run("systemctl", [
    "show",
    "-p",
    "MainPID",
    "--value",
    unitName(name),
  ]);
  const pid = Number(res.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function releaseOf(ctx: Context, name: string): Promise<string> {
  try {
    return basename(await readlink(join(instanceDir(ctx, name), "release")));
  } catch {
    return "?";
  }
}

async function rowFor(ctx: Context, name: string, record: InstanceRecord): Promise<InstanceRow> {
  return {
    name,
    state: await stateOf(ctx, name),
    release: await releaseOf(ctx, name),
    record,
    cert: await certColumn(ctx, name, record.hostname),
    ...(await scheduleOf(ctx, name, record)),
  };
}

/** The overview table, one line per Instance. Later tickets add columns and a footer. */
export function renderInstanceTable(rows: InstanceRow[]): string[] {
  const table = [
    ["INSTANCE", "STATE", "RELEASE", "HOSTNAME", "PORT", "CERT", "LAST SCHEDULED"],
    ...rows.map((r) => [
      r.name,
      r.state,
      r.release,
      r.record.hostname,
      String(r.record.port),
      r.cert,
      r.lastScheduled,
    ]),
  ];
  return formatColumns(table);
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
  for (const row of rows) {
    const change = await changeSummary(ctx, row.name);
    if (change) {
      step(
        ctx,
        "warn",
        `${row.name}: ${change}. Only rollback can run: sudo dcabsm instance rollback ${row.name}`,
      );
    }
    if (row.overdue) step(ctx, "warn", `${row.name}: no scheduled Backup in the last 48 hours`);
  }
  for (const line of await instanceListFooter(ctx)) ctx.io.out(line);
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
  const fields: Field[] = [
    ["Hostname", `https://${record.hostname}`],
    ["Release", patch ? `${row.release} (Node ${patch})` : row.release],
    ["Port", `127.0.0.1:${record.port}`],
    ["Account", accountOf(name)],
    ["Scheduled backups", record.scheduledBackups ? "on" : "off"],
  ];
  const settings = settingsSummary(record.settings, row.release);
  if (settings) fields.push(["Settings", settings]);
  ctx.io.out(`${name}  ${row.state}`);
  for (const [label, value] of fields) ctx.io.out(`  ${label.padEnd(17)}  ${value}`);
  const change = await changeSummary(ctx, name);
  if (change) {
    step(ctx, "warn", `${change}. Only rollback can run: sudo dcabsm instance rollback ${name}`);
  }
}
