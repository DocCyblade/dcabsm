import { chmod, lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { ensureDir, makeWritable, ownedByRoot, rootOwner } from "../fsutil.ts";
import { DEFAULT_BACKUP_DIR, readHostConfig } from "./config.ts";
import type { Check, CheckResult } from "./checks.ts";
import { installedReleases } from "../release/install.ts";

/** Checks of the `/etc/dcabsm` and `/srv/dcabsm` trees (spec 2.2, 10.6). */

const pass = (label: string): CheckResult[] => [{ kind: "pass", label }];

const names = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

const octal = (mode: number): string => (mode & 0o777).toString(8);

const logicalBackupDir = async (ctx: Context): Promise<string> =>
  (await readHostConfig(ctx))?.backupDir ?? DEFAULT_BACKUP_DIR;

interface Expect {
  path: string;
  /** The exact mode, or "read-only": no write bits and world-readable. */
  mode: number | "read-only";
  dir: boolean;
}

/** The Host rows of the ownership table (spec 2.2), plus everything under the backup directory. */
async function expected(ctx: Context): Promise<Expect[]> {
  const p = ctx.paths;
  const backups = ctx.paths.under(await logicalBackupDir(ctx));
  const rules: Expect[] = [
    { path: p.etc, mode: 0o700, dir: true },
    { path: p.hostConfig, mode: 0o600, dir: false },
    { path: p.srv, mode: 0o755, dir: true },
    { path: p.releases, mode: 0o755, dir: true },
    { path: p.instances, mode: 0o755, dir: true },
    { path: p.acme, mode: 0o755, dir: true },
    { path: backups, mode: 0o700, dir: true },
  ];
  for (const version of await installedReleases(ctx))
    rules.push({ path: join(p.releases, version), mode: "read-only", dir: true });
  const walk = async (dir: string): Promise<void> => {
    for (const name of await names(dir)) {
      const path = join(dir, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      rules.push({ path, mode: info.isDirectory() ? 0o700 : 0o600, dir: info.isDirectory() });
      if (info.isDirectory()) await walk(path);
    }
  };
  await walk(backups);
  return rules;
}

async function ownership(ctx: Context): Promise<CheckResult[]> {
  const root = rootOwner();
  const problems: CheckResult[] = [];
  for (const rule of await expected(ctx)) {
    const logical = rule.path.slice(ctx.paths.root.length) || "/";
    let info;
    try {
      info = await lstat(rule.path);
    } catch {
      if (!rule.dir || rule.mode === "read-only") continue;
      const mode = rule.mode;
      problems.push({
        kind: "problem",
        severity: "warn",
        message: `${logical} is missing`,
        fix: { apply: () => ensureDir(rule.path, mode) },
      });
      continue;
    }
    const found: string[] = [];
    if (info.uid !== root.uid || info.gid !== root.gid)
      found.push(`is owned by ${info.uid}:${info.gid}, not root:root`);
    const mode = info.mode & 0o777;
    if (rule.mode === "read-only") {
      if ((mode & 0o222) !== 0 || (mode & 0o005) !== 0o005)
        found.push(`has mode ${octal(mode)}, not read-only`);
    } else if (mode !== rule.mode) {
      found.push(`has mode ${octal(mode)}, not ${octal(rule.mode)}`);
    }
    if (found.length === 0) continue;
    const want = rule.mode === "read-only" ? 0o555 : rule.mode;
    problems.push({
      kind: "problem",
      severity: "warn",
      message: `${logical} ${found.join(" and ")}`,
      fix: {
        async apply() {
          await ownedByRoot(rule.path);
          await chmod(rule.path, want);
        },
      },
    });
  }
  return problems.length > 0 ? problems : pass("Ownership and modes");
}

async function leftovers(ctx: Context): Promise<CheckResult[]> {
  const found: CheckResult[] = [];
  for (const [dir, logical] of [
    [ctx.paths.releases, "/srv/dcabsm/releases"],
    [ctx.paths.node, "/srv/dcabsm/node"],
  ] as const) {
    for (const name of (await names(dir)).filter((n) => n.startsWith(".installing-")).sort()) {
      found.push({
        kind: "problem",
        severity: "warn",
        message: `Leftover ${name} folder in ${logical}`,
        fix: {
          async apply() {
            await makeWritable(join(dir, name));
            await rm(join(dir, name), { recursive: true, force: true });
          },
        },
      });
    }
  }
  return found.length > 0 ? found : pass("No leftover .installing-* folders");
}

async function orphanAccounts(ctx: Context): Promise<CheckResult[]> {
  let passwd = "";
  try {
    passwd = await readFile(ctx.paths.under("/etc/passwd"), "utf8");
  } catch {
    // No passwd file to read: nothing to find.
  }
  const instances = new Set(await names(ctx.paths.instances));
  const orphans = passwd
    .split("\n")
    .map((line) => line.split(":")[0]!)
    .filter((user) => user.startsWith("dcabsm-") && !instances.has(user.slice("dcabsm-".length)));
  if (orphans.length === 0) return pass("Every dcabsm-* account has an Instance");
  return orphans.map((user): CheckResult => ({
    kind: "problem",
    severity: "warn",
    message: `Account ${user} has no Instance`,
    fix: {
      async apply() {
        const res = await ctx.runner.run("userdel", [user]);
        if (res.code !== 0) throw new Error(res.stderr.trim() || `userdel exited ${res.code}`);
      },
    },
  }));
}

async function treeSize(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await names(path)) total += await treeSize(join(path, name));
  return total;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function removedBackups(ctx: Context): Promise<CheckResult[]> {
  const logical = await logicalBackupDir(ctx);
  const dir = ctx.paths.under(logical);
  const removed = (await names(dir)).filter((n) => n.includes(".removed-")).sort();
  if (removed.length === 0) return pass("No .removed- Backup folders");
  const found: CheckResult[] = [];
  for (const name of removed) {
    found.push({
      kind: "problem",
      severity: "note",
      message: `${logical}/${name} holds ${formatSize(await treeSize(join(dir, name)))}; deleting it is a Manual System Admin task`,
    });
  }
  return found;
}

/** The device `df` reports for a path, or undefined if it can't tell. */
async function deviceOf(ctx: Context, path: string): Promise<string | undefined> {
  const res = await ctx.runner.run("df", ["-P", path]);
  return res.code === 0 ? res.stdout.split("\n")[1]?.trim().split(/\s+/)[0] : undefined;
}

async function sharedDisk(ctx: Context): Promise<CheckResult[]> {
  const backups = await deviceOf(ctx, ctx.paths.under(await logicalBackupDir(ctx)));
  const data = await deviceOf(ctx, ctx.paths.instances);
  if (backups === undefined || data === undefined) return [];
  if (backups !== data) return pass("Backups are on their own disk");
  return [
    {
      kind: "problem",
      severity: "warn",
      message: `Backups share a disk with Instance data (${data})`,
      hint: "One failing disk would take both. Moving Backups is a Manual System Admin task.",
    },
  ];
}

export const treeChecks: Check[] = [
  { id: "ownership", run: ownership },
  { id: "installing-leftovers", run: leftovers },
  { id: "orphan-accounts", run: orphanAccounts },
  { id: "removed-backups", run: removedBackups },
  { id: "shared-disk", run: sharedDisk },
];
