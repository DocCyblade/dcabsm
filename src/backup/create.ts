import { chmod, mkdir, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, firstLine, refusal } from "../errors.ts";
import { ensureDir, exists, ownedByRoot } from "../fsutil.ts";
import { systemctl } from "../host/system.ts";
import { formatSize, treeSize } from "../host/tree.ts";
import { checkName, instanceDir, instanceNames, requireInstance } from "../instance/record.ts";
import { step } from "../output.ts";
import { releaseNodeMajor } from "../release/install.ts";
import { linkedPatch } from "../release/node.ts";
import type { Invocation } from "../table.ts";
import { VERSION } from "../version.ts";
import {
  ARCHIVE_FORMAT,
  archiveName,
  backupRoot,
  logicalBackupRoot,
  type Kind,
  type Manifest,
} from "./archive.ts";

/** Where Actual keeps what has no copy elsewhere. An Instance that never started leaves them empty. */
const DATA_DIRS = ["data", "server-files", "user-files"];

async function hasData(dir: string): Promise<boolean> {
  for (const d of DATA_DIRS) {
    try {
      if ((await readdir(join(dir, d))).length > 0) return true;
    } catch {
      // A missing directory holds nothing.
    }
  }
  return false;
}

/** Free bytes where `path` lives, from `df -Pk`. */
async function freeBytes(ctx: Context, path: string): Promise<number> {
  const res = await ctx.runner.run("df", ["-Pk", path]);
  const kb = Number(res.stdout.split("\n")[1]?.trim().split(/\s+/)[3]);
  if (res.code !== 0 || !Number.isFinite(kb)) {
    throw new CliError(
      `Could not read the free space in ${path}.`,
      "Check the disk, then run again",
    );
  }
  return kb * 1024;
}

async function manifestFor(
  ctx: Context,
  name: string,
  kind: Kind,
  time: Date,
  hostname: string,
): Promise<Manifest> {
  const release = basename(await readlink(join(instanceDir(ctx, name), "release")));
  const major = await releaseNodeMajor(ctx, release);
  const node = (major === undefined ? undefined : await linkedPatch(ctx, major)) ?? "unknown";
  return {
    format: ARCHIVE_FORMAT,
    name,
    kind,
    time: time.toISOString().replace(/\.\d+Z$/, "Z"),
    release,
    node,
    dcabsm: VERSION,
    hostname,
  };
}

/** Marks that mean the Instance is down on purpose or mid-change. */
async function refuseIfChanging(ctx: Context, name: string): Promise<void> {
  if (await exists(join(instanceDir(ctx, name), ".changing-release"))) {
    throw new CliError(
      `${name} has an unfinished Release change.`,
      `Finish it first: sudo dcabsm instance rollback ${name}`,
    );
  }
}

/**
 * Takes one Backup of an Instance (spec 7.3). The caller holds the lock. A running Instance is stopped
 * for the archive and started again; a stopped one stays stopped. Returns the archive's file name.
 */
export async function takeBackup(ctx: Context, name: string, kind: Kind): Promise<string> {
  const record = await requireInstance(ctx, name);
  const dir = instanceDir(ctx, name);
  await refuseIfChanging(ctx, name);
  const root = await backupRoot(ctx);
  const target = join(root, name);
  await ensureDir(root, 0o700);
  await ensureDir(target, 0o700);

  const need = await treeSize(dir);
  const free = await freeBytes(ctx, root);
  if (free < need) {
    throw new CliError(
      `Not enough space in ${await logicalBackupRoot(ctx)} for a backup of ${name} (needs ~${formatSize(need)}, ${formatSize(free)} free). ${name} was not stopped.`,
    );
  }
  step(ctx, "done", `Free space: ${formatSize(free)}, backup needs ~${formatSize(need)}`);

  const time = ctx.now();
  const manifest = await manifestFor(ctx, name, kind, time, record.hostname);
  const file = archiveName(time, kind, manifest.release);
  const temp = join(target, `.${file}`);
  const stage = join(target, `.${file}.stage`);
  const unit = `dcabsm@${name}`;
  const running = (await ctx.runner.run("systemctl", ["is-active", "--quiet", unit])).code === 0;

  let failure: unknown;
  let stopped = false;
  try {
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    // Made private before tar writes into it, so the archive is never readable.
    await writeFile(temp, "", { mode: 0o600 });
    await chmod(temp, 0o600);
    await ownedByRoot(temp);
    if (running) {
      stopped = true;
      await systemctl(ctx, "stop", unit);
      step(ctx, "done", `Stopped ${name}`);
    }
    const entries = (await readdir(dir)).filter((e) => e !== "release").sort();
    const tar = await ctx.runner.run("tar", [
      "-czf",
      temp,
      "--format=gnu",
      "--numeric-owner",
      "-C",
      stage,
      "manifest.json",
      "-C",
      dir,
      ...entries,
    ]);
    if (tar.code !== 0) {
      throw new CliError(`tar failed: ${firstLine(tar.stderr, `exit ${tar.code}`)}`);
    }
    const listing = await ctx.runner.run("tar", ["-tzf", temp]);
    const first = listing.stdout.split("\n")[0]?.replace(/^\.\//, "");
    if (listing.code !== 0 || first !== "manifest.json") {
      throw new CliError(
        `The new archive failed its check: ${firstLine(listing.stderr, "manifest.json is not first")}`,
      );
    }
    await rename(temp, join(target, file));
  } catch (err) {
    failure = err;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(temp, { force: true });
  }

  let startFailure: unknown;
  if (stopped) {
    try {
      await systemctl(ctx, "start", unit);
      step(ctx, "done", `Started ${name}`);
    } catch (err) {
      startFailure = err;
    }
  }
  if (failure) {
    throw failure instanceof CliError
      ? failure
      : new CliError(`Could not back up ${name}: ${errorMessage(failure)}`);
  }
  if (startFailure) {
    throw new CliError(
      `${name} was backed up as ${file} but did not start again: ${errorMessage(startFailure)}`,
      `Run: sudo dcabsm instance logs ${name}`,
    );
  }
  const size = (await stat(join(target, file))).size;
  step(ctx, "done", `Backup ${kind}: ${file} (${formatSize(size)})`);
  return file;
}

/** `backup create <names>|--all` */
export async function backupCreate({ ctx, args }: Invocation): Promise<number> {
  const { values, positionals } = parseCommand(args, { all: { type: "boolean" } });
  const usage = "Usage: dcabsm backup create <names>|--all";
  if (values.all && positionals.length > 0) throw refusal("Use --all or names, not both.", usage);
  const names = values.all ? await instanceNames(ctx) : [...new Set(positionals)];
  if (names.length === 0) {
    throw refusal(
      values.all ? "There are no Instances to back up." : "Give Instance names or --all.",
      usage,
    );
  }
  for (const name of names) {
    checkName(name);
    await requireInstance(ctx, name);
  }

  ctx.io.out(`Back up ${names.join(", ")}`);
  ctx.io.out(
    "  · Each running Instance stops for a few seconds while it is archived, one at a time.",
  );
  const rows: string[][] = [["INSTANCE", "RESULT", "ARCHIVE"]];
  for (const name of names) {
    if (!(await hasData(instanceDir(ctx, name)))) {
      step(
        ctx,
        "warn",
        `${name} has no data yet: it has never started, so there is nothing to back up.`,
      );
      rows.push([name, "no data", "-"]);
      continue;
    }
    try {
      rows.push([name, "ok", await takeBackup(ctx, name, "manual")]);
    } catch (err) {
      step(ctx, "failed", errorMessage(err));
      if (err instanceof CliError && err.hint) ctx.io.out(`    ${err.hint}`);
      rows.push([name, "failed", "-"]);
    }
  }

  ctx.io.out("");
  ctx.io.out("Summary");
  const widths = [0, 1].map((i) => Math.max(...rows.map((r) => r[i]!.length)) + 2);
  for (const r of rows) {
    ctx.io.out(`${r[0]!.padEnd(widths[0]!)}${r[1]!.padEnd(widths[1]!)}${r[2]}`);
  }
  ctx.io.out(
    `  · Archives are unencrypted and as sensitive as root on this Host. They live in ${await logicalBackupRoot(ctx)}/<name>/.`,
  );
  return rows.slice(1).some((r) => r[1] === "failed") ? 1 : 0;
}
