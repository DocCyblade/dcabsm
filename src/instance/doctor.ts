import { chmod, lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backupRoot, listArchives, timeStamp } from "../backup/archive.ts";
import { freeBytes, RUNNING_STATES } from "../backup/create.ts";
import type { Context } from "../context.ts";
import { CliError } from "../errors.ts";
import { lineDiff } from "../diff.ts";
import { ensureDir, exists, readTextOr, rootOwner, writeFileAtomic } from "../fsutil.ts";
import { formatSize } from "../host/tree.ts";
import { parseListeners, type Check, type CheckResult } from "../host/checks.ts";
import { hostHasIpv6 } from "../host/owned.ts";
import { nginxIsActive, nginxTestFailure, runChecked, systemctl } from "../host/system.ts";
import { confirm } from "../prompt.ts";
import { createAccount, makeDirectories } from "./create.ts";
import {
  configJson,
  instanceDirSpecs,
  instanceFileSpecs,
  vhostConf,
  vhostPath,
  writeConfigJson,
  type PathSpec,
} from "./files.ts";
import { scheduleOf, unitStateOf } from "./list.ts";
import { unusedSettings } from "./setting-table.ts";
import {
  accountOf,
  instanceNames,
  isChanging,
  readRecord,
  runningRelease,
  unitName,
  type InstanceRecord,
} from "./record.ts";
import { getJson, startVerified } from "./verify.ts";

/** The per-Instance checks of spec 10.6. The certificate test is `certChecks`; the change marker is `changeChecks`. */

/** An Instance doctor can judge: it has a record. A folder without one is a leftover, not an Instance. */
interface Target {
  name: string;
  record: InstanceRecord;
  /** The Release its `release` link names; undefined when the link is missing. */
  release: string | undefined;
  /** An unfinished Release change owns the generated files until rollback finishes it. */
  changing: boolean;
}

async function targets(ctx: Context): Promise<Target[]> {
  const found: Target[] = [];
  for (const name of await instanceNames(ctx)) {
    const record = await readRecord(ctx, name);
    if (!record) continue;
    found.push({
      name,
      record,
      release: await runningRelease(ctx, name).catch(() => undefined),
      changing: await isChanging(ctx, name),
    });
  }
  return found;
}

/** Runs `check` for every Instance; one pass line when none has a problem. */
async function perInstance(
  ctx: Context,
  label: string,
  check: (ctx: Context, target: Target) => Promise<CheckResult[]>,
): Promise<CheckResult[]> {
  const problems: CheckResult[] = [];
  for (const target of await targets(ctx)) problems.push(...(await check(ctx, target)));
  return problems.length > 0 ? problems : [{ kind: "pass", label }];
}

const logical = (ctx: Context, path: string): string => path.slice(ctx.paths.root.length) || "/";

// config.json -------------------------------------------------------------------------------------

/** When the Instance's unit last became active, or undefined if it is not running or systemd won't say. */
async function startedAt(ctx: Context, name: string): Promise<Date | undefined> {
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

const running = async (ctx: Context, name: string): Promise<boolean> =>
  RUNNING_STATES.includes(await unitStateOf(ctx, name));

/** The fix: regenerate `config.json`, then ask separately whether to restart (spec 4.4). */
async function fixConfig(
  ctx: Context,
  { name, record, release }: Target & { release: string },
  yes: boolean,
): Promise<void> {
  await writeConfigJson(ctx, name, record, release);
  if (!(await running(ctx, name))) return;
  if (!(await confirm(ctx, `Restart ${name} now to load the new config.json?`, { yes }))) return;
  await startVerified(ctx, name, record.port, { verb: "restart", release });
}

async function configCheck(ctx: Context, target: Target): Promise<CheckResult[]> {
  const { name, record, release, changing } = target;
  if (changing) return [];
  if (release === undefined) {
    return [
      {
        kind: "problem",
        severity: "fail",
        message: `${name} has no Release link, so its config.json cannot be checked`,
        hint: `Restore it from a Backup: sudo dcabsm instance restore ${name}`,
      },
    ];
  }
  const path = join(ctx.paths.instances, name, "config", "config.json");
  const wanted = configJson(name, record, release);
  const found = await readTextOr(path);
  if (found !== wanted) {
    return [
      {
        kind: "problem",
        severity: "warn",
        message:
          found === undefined
            ? `${name}: config.json is missing`
            : `${name}: config.json differs from its record`,
        fix: {
          diff: found === undefined ? undefined : lineDiff(found, wanted),
          apply: ({ yes }) => fixConfig(ctx, { ...target, release }, yes),
        },
      },
    ];
  }
  // It matches now, but a running Instance only reads it at start.
  const started = (await running(ctx, name)) ? await startedAt(ctx, name) : undefined;
  if (started && (await stat(path)).mtime > started) {
    return [
      {
        kind: "problem",
        severity: "warn",
        message: `${name}: restart needed, config.json changed after it started`,
        hint: `Restart it: sudo dcabsm instance restart ${name}`,
      },
    ];
  }
  return [];
}

// vhost.conf --------------------------------------------------------------------------------------

/** The fix: keep the old copy, write the vhost, `nginx -t`, then reload (spec 10.5, 10.6). */
async function fixVhost(ctx: Context, name: string, wanted: string, old?: string): Promise<void> {
  const path = vhostPath(ctx, name);
  if (old !== undefined) {
    const saved = join(ctx.paths.etc, "replaced", timeStamp(ctx.now()), logical(ctx, path));
    await mkdir(dirname(saved), { recursive: true, mode: 0o700 });
    await writeFile(saved, old, { mode: 0o600 });
  }
  await writeFileAtomic(path, wanted, 0o600);
  const reason = await nginxTestFailure(ctx);
  if (reason !== undefined) {
    if (old === undefined) await rm(path, { force: true });
    else await writeFileAtomic(path, old, 0o600);
    throw new CliError(
      `nginx -t failed with the new vhost.conf: ${reason}`,
      "The previous file was put back and Nginx was not reloaded.",
    );
  }
  if (await nginxIsActive(ctx)) await systemctl(ctx, "reload", "nginx");
}

async function vhostCheck(
  ctx: Context,
  { name, record, changing }: Target,
): Promise<CheckResult[]> {
  if (changing) return [];
  const wanted = vhostConf(name, record, await hostHasIpv6(ctx));
  const found = await readTextOr(vhostPath(ctx, name));
  if (found === wanted) return [];
  return [
    {
      kind: "problem",
      severity: "warn",
      message:
        found === undefined
          ? `${name}: vhost.conf is missing`
          : `${name}: vhost.conf differs from what DCABSM generates`,
      fix: {
        diff: found === undefined ? undefined : lineDiff(found, wanted),
        apply: () => fixVhost(ctx, name, wanted, found),
      },
    },
  ];
}

// Settings the Release doesn't use ----------------------------------------------------------------

async function settingsCheck(
  _ctx: Context,
  { name, record, release }: Target,
): Promise<CheckResult[]> {
  if (release === undefined) return [];
  return unusedSettings(record, release).map((key): CheckResult => ({
    kind: "problem",
    severity: "note",
    message: `${name}: ${key} is set but not used by Release ${release}; the record keeps it for a later Upgrade`,
  }));
}

// Account and ownership ---------------------------------------------------------------------------

interface Account {
  uid: number;
  gid: number;
}

/** The Instance account from `/etc/passwd`, or undefined when it does not exist. */
async function accountOfInstance(ctx: Context, name: string): Promise<Account | undefined> {
  const passwd = await readTextOr(ctx.paths.under("/etc/passwd"));
  const wanted = accountOf(name);
  for (const line of (passwd ?? "").split("\n")) {
    const [user, , uid, gid] = line.split(":");
    if (user === wanted) return { uid: Number(uid), gid: Number(gid) };
  }
  return undefined;
}

/** The numeric owner `user:group` stands for. */
function idsOf(owner: string, account: Account): Account {
  const root = rootOwner();
  const [user, group] = owner.split(":") as [string, string];
  return {
    uid: user === "root" ? root.uid : account.uid,
    gid: group === "root" ? root.gid : account.gid,
  };
}

const octal = (mode: number): string => (mode & 0o777).toString(8);

/** Sets one path to its spec, the way creation does. */
async function repairPath(ctx: Context, spec: PathSpec, isDir: boolean): Promise<void> {
  if (isDir) await ensureDir(spec.path, spec.mode);
  else await chmod(spec.path, spec.mode);
  await runChecked(ctx, "chown", [spec.owner, spec.path]);
}

/** Directories first, as creation makes them, then the files. */
async function repairTree(ctx: Context, name: string): Promise<void> {
  await makeDirectories(ctx, name);
  for (const spec of instanceFileSpecs(ctx, name)) {
    if (await exists(spec.path)) await repairPath(ctx, spec, false);
  }
}

async function ownershipCheck(ctx: Context, { name }: Target): Promise<CheckResult[]> {
  const account = await accountOfInstance(ctx, name);
  if (!account) {
    return [
      {
        kind: "problem",
        severity: "fail",
        message: `${name}: the account ${accountOf(name)} is missing`,
        fix: {
          async apply() {
            await createAccount(ctx, name);
            await repairTree(ctx, name);
          },
        },
      },
    ];
  }
  const problems: CheckResult[] = [];
  const dirs = instanceDirSpecs(ctx, name).map((spec) => ({ spec, isDir: true }));
  const files = instanceFileSpecs(ctx, name).map((spec) => ({ spec, isDir: false }));
  for (const { spec, isDir } of [...dirs, ...files]) {
    let info;
    try {
      info = await lstat(spec.path);
    } catch {
      if (isDir) {
        problems.push({
          kind: "problem",
          severity: "warn",
          message: `${name}: ${logical(ctx, spec.path)} is missing`,
          fix: { apply: () => repairPath(ctx, spec, true) },
        });
      }
      continue;
    }
    const want = idsOf(spec.owner, account);
    const found: string[] = [];
    if (info.uid !== want.uid || info.gid !== want.gid)
      found.push(`is owned by ${info.uid}:${info.gid}, not ${spec.owner}`);
    if ((info.mode & 0o777) !== spec.mode)
      found.push(`has mode ${octal(info.mode)}, not ${octal(spec.mode)}`);
    if (found.length === 0) continue;
    problems.push({
      kind: "problem",
      severity: "warn",
      message: `${name}: ${logical(ctx, spec.path)} ${found.join(" and ")}`,
      fix: { apply: () => repairPath(ctx, spec, isDir) },
    });
  }
  return problems;
}

// Ports and /info ---------------------------------------------------------------------------------

async function mainPid(ctx: Context, name: string): Promise<number | undefined> {
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

async function portChecks(ctx: Context): Promise<CheckResult[]> {
  const all = await targets(ctx);
  const problems: CheckResult[] = [];
  const byPort = new Map<number, string[]>();
  for (const { name, record } of all)
    byPort.set(record.port, [...(byPort.get(record.port) ?? []), name]);
  for (const [port, names] of byPort) {
    if (names.length < 2) continue;
    for (const name of names) {
      problems.push({
        kind: "problem",
        severity: "fail",
        message: `${name}: port ${port} is also in the record of ${names.filter((n) => n !== name).join(", ")}`,
        hint: "Two Instances cannot listen on one port. Give one a free port in its config/instance.json, then restart it.",
      });
    }
  }
  const ss = await ctx.runner.run("ss", ["-H", "-ltnp"]);
  if (ss.code === 0) {
    for (const { name, record } of all) {
      const listeners = parseListeners(ss.stdout, [record.port]);
      if (listeners.length === 0) continue;
      const up = await running(ctx, name);
      const own = up ? await mainPid(ctx, name) : undefined;
      // A running Instance with no MainPID to compare is left alone: nothing says the listener is foreign.
      if (up && own === undefined) continue;
      const foreign = listeners.find((l) => l.pid === undefined || l.pid !== own);
      if (!foreign) continue;
      const who = foreign.process
        ? `${foreign.process}${foreign.pid === undefined ? "" : ` (pid ${foreign.pid})`}`
        : "another process";
      problems.push({
        kind: "problem",
        severity: "fail",
        message: `${name}: port ${record.port} is in use by ${who}`,
        hint: "Stop that process, or give the Instance another port in its config/instance.json and restart it.",
      });
    }
  }
  return problems.length > 0
    ? problems
    : [{ kind: "pass", label: "Every Instance's port is its own" }];
}

async function infoCheck(ctx: Context, { name, record, release }: Target): Promise<CheckResult[]> {
  if (release === undefined || (await unitStateOf(ctx, name)) !== "active") return [];
  const info = await getJson(ctx, `http://127.0.0.1:${record.port}/info`);
  const reported = info?.build?.version;
  if (typeof reported !== "string") {
    return [
      {
        kind: "problem",
        severity: "warn",
        message: `${name}: its unit is active but /info did not answer on port ${record.port}`,
        hint: `See: sudo dcabsm instance logs ${name}`,
      },
    ];
  }
  if (reported === release) return [];
  return [
    {
      kind: "problem",
      severity: "warn",
      message: `${name}: /info reports ${reported}, but its Release is ${release}`,
      hint: `Restart it to run its Release: sudo dcabsm instance restart ${name}`,
    },
  ];
}

// Backups -----------------------------------------------------------------------------------------

async function scheduleCheck(ctx: Context, { name, record }: Target): Promise<CheckResult[]> {
  if (!(await scheduleOf(ctx, name, record)).overdue) return [];
  return [
    {
      kind: "problem",
      severity: "warn",
      message: `${name}: no scheduled Backup in the last 48 hours`,
      hint: "Check the timer and the Nightly run: systemctl status dcabsm-nightly.timer",
    },
  ];
}

/** Spec 8.4: the next Nightly run needs about as much room as the newest Backup of each Instance with scheduled Backups on. */
async function nightlyRoom(ctx: Context): Promise<CheckResult[]> {
  let need = 0;
  for (const { name, record } of await targets(ctx)) {
    if (!record.scheduledBackups) continue;
    need += (await listArchives(ctx, name)).at(-1)?.size ?? 0;
  }
  let free: number;
  try {
    free = await freeBytes(ctx, await backupRoot(ctx));
  } catch {
    return []; // No backup directory to measure yet.
  }
  if (free >= need) {
    return [{ kind: "pass", label: `Room for the next Nightly run (${formatSize(free)} free)` }];
  }
  return [
    {
      kind: "problem",
      severity: "warn",
      message: `The backup filesystem has ${formatSize(free)} free, less than the newest Backup of each Instance (${formatSize(need)}): the next Nightly run would not fit`,
      hint: "Free space there, or move Backups to a bigger disk (a Manual System Admin task).",
    },
  ];
}

const each = (
  id: string,
  label: string,
  check: (ctx: Context, target: Target) => Promise<CheckResult[]>,
): Check => ({ id, run: (ctx) => perInstance(ctx, label, check) });

/** Every Instance check of spec 10.6, after the Host ones. */
export const instanceChecks: Check[] = [
  each("instance-config", "Every Instance's config.json matches its record", configCheck),
  each("instance-vhost", "Every Instance's vhost.conf matches", vhostCheck),
  each("instance-settings", "Every Instance setting is used by its Release", settingsCheck),
  each("instance-ownership", "Instance accounts, ownership and modes", ownershipCheck),
  { id: "instance-ports", run: portChecks },
  each("instance-info", "Every running Instance reports its Release on /info", infoCheck),
  each("instance-schedule", "Scheduled Backups are recent", scheduleCheck),
  { id: "instance-nightly-room", run: nightlyRoom },
];
