import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseCommand } from "../args.ts";
import { backupRoot, listArchives, readManifest, type Manifest } from "../backup/archive.ts";
import { checkSpace, RUNNING_STATES, takeBackup } from "../backup/create.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { hostHasIpv6 } from "../host/owned.ts";
import { systemctl } from "../host/system.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirmName } from "../prompt.ts";
import { installRelease } from "../release/install.ts";
import { compareText } from "../release/semver.ts";
import type { Invocation } from "../table.ts";
import { beforeRestoreAdvice, deviceAdvice } from "./device-advice.ts";
import { vhostConf } from "./files.ts";
import { unitStateOf } from "./list.ts";
import { regroup } from "./regroup.ts";
import {
  checkName,
  instanceDir,
  refuseIfChanging,
  removeMarker,
  requireInstance,
  runningRelease,
  unitName,
  writeMarker,
  type InstanceRecord,
} from "./record.ts";
import { chownData, restoreData } from "./restore-data.ts";
import { SETTINGS, usedBy } from "./setting-table.ts";
import { withStartGate } from "./start-gate.ts";
import { switchRelease } from "./switch.ts";
import { startVerified } from "./verify.ts";
import { planIfMissing } from "./upgrade-plan.ts";

const USAGE = "Usage: dcabsm instance restore <name> [<archive>] [--confirm <name>]";

/** `2026-11-07 03:30 UTC` from a manifest's `2026-11-07T03:30:00Z`. */
const formatTime = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The archive to restore: the one given, or the newest in the Instance's backup directory. */
async function pickArchive(ctx: Context, name: string, given: string | undefined) {
  if (given !== undefined) {
    const found = await stat(given).catch(() => undefined);
    if (!found?.isFile()) {
      throw refusal(`${given} is not an archive file.`, "Give the path of a .tar.gz archive.");
    }
    return given;
  }
  const newest = (await listArchives(ctx, name)).at(-1);
  if (!newest) {
    throw refusal(
      `${name} has no backups to restore.`,
      `Take one first: sudo dcabsm backup create ${name}`,
    );
  }
  return newest.path;
}

/** Names the settings the Release can't use (spec 4.11): the record keeps them for a later Upgrade. */
function reportUnusedSettings(ctx: Context, record: InstanceRecord, release: string): void {
  for (const def of SETTINGS) {
    if (record.settings?.[def.key] !== undefined && !usedBy(def, release)) {
      step(ctx, "info", `${def.key}: not used by ${release}`);
    }
  }
}

/** Regenerates `vhost.conf` from the record. It is the same text unless it was edited, so no reload. */
async function writeVhost(ctx: Context, name: string, record: InstanceRecord): Promise<void> {
  const path = join(instanceDir(ctx, name), "nginx", "vhost.conf");
  await writeFileAtomic(path, vhostConf(name, record, await hostHasIpv6(ctx)), 0o600);
}

interface Job {
  name: string;
  record: InstanceRecord;
  archive: string;
  manifest: Manifest;
  /** The Release the Instance runs now. */
  from: string;
  wasUp: boolean;
}

/** Starts and verifies `release` with the unit's marker rule lifted (spec 6.1 step 7). */
const startThroughGate = (ctx: Context, job: Job, release: string): Promise<void> =>
  withStartGate(ctx, job.name, () => startVerified(ctx, job.name, job.record.port, { release }));

/**
 * Puts the `pre-restore` Backup back, with no Regroup: the Instance was stopped from that Backup
 * until now, so no device synced anything it removes (ADR-0004). Throws if that fails.
 */
async function rollBack(ctx: Context, job: Job, backup: string): Promise<void> {
  const { name, from } = job;
  step(ctx, "warn", "Rolling back automatically");
  await systemctl(ctx, "stop", unitName(name));
  await restoreData(ctx, name, backup);
  step(ctx, "done", `Restored data from ${basename(backup)}`);
  await switchRelease(ctx, name, job.record, from);
  step(ctx, "done", `Switched back to ${from}`);
  await startThroughGate(ctx, job, from);
}

/** Restore steps 2 to 5 (spec 7.4). The caller holds the lock and has confirmed. */
async function restoreInstance(ctx: Context, job: Job): Promise<void> {
  const { name, record, manifest, from } = job;
  const to = manifest.release;
  const unit = unitName(name);

  await systemctl(ctx, "stop", unit);
  step(ctx, "done", `Stopped ${name}`);
  let file: string;
  try {
    file = await takeBackup(ctx, name, "pre-restore");
  } catch (err) {
    // Nothing has changed yet, so a running Instance goes back up as it was.
    if (job.wasUp) {
      try {
        await systemctl(ctx, "start", unit);
        step(ctx, "info", `${name} was running before the restore, so it is started again`);
      } catch (again) {
        step(ctx, "warn", `Could not start ${name} again: ${errorMessage(again)}`);
      }
    }
    throw err;
  }
  const backup = join(await backupRoot(ctx), name, file);
  await writeMarker(ctx, name, { operation: "restore", from, to, backup, restoringData: true });

  try {
    await restoreData(ctx, name, job.archive);
    step(
      ctx,
      "done",
      "Replaced data, server-files and user-files; ownership set for " + `dcabsm-${name}`,
    );
    const dir = instanceDir(ctx, name);
    const count = await regroup(join(dir, "server-files"), join(dir, "user-files"));
    await chownData(ctx, name);
    step(ctx, "done", `Regrouped ${count} Budget file${count === 1 ? "" : "s"}`);
    await switchRelease(ctx, name, record, to);
    await writeVhost(ctx, name, record);
    step(ctx, "done", `On Release ${to}, config.json and vhost.conf regenerated`);
    await startThroughGate(ctx, job, to);
  } catch (err) {
    step(ctx, "failed", errorMessage(err));
    try {
      await rollBack(ctx, job, backup);
    } catch (again) {
      await systemctl(ctx, "stop", unit).catch(() => undefined);
      step(ctx, "failed", `Automatic rollback failed: ${errorMessage(again)}`);
      throw new CliError(
        `Restore of ${name} failed, and so did the automatic rollback. ${name} stays stopped.`,
        `Its pre-restore backup is kept: ${backup}\n  Then try: sudo dcabsm instance rollback ${name}`,
      );
    }
    await removeMarker(ctx, name);
    if (!job.wasUp) await systemctl(ctx, "stop", unit);
    throw new CliError(
      `Restore of ${name} failed and was rolled back. Its data is as it was before the restore.`,
      `Why: sudo dcabsm instance logs ${name} --since "15 min ago"`,
    );
  }
  await removeMarker(ctx, name);
  // A stopped Instance has proved the restored data starts, and returns to stopped.
  if (!job.wasUp) {
    await systemctl(ctx, "stop", unit);
    step(ctx, "info", `${name} was stopped before the restore, so it is stopped again`);
  }
}

/** `instance restore <name> [<archive>] [--confirm <name>]` (spec 7.4) */
export async function instanceRestore({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    confirm: { type: "string" },
    from: { type: "string" },
  });
  if (values.from !== undefined) {
    throw refusal("instance restore --from is not available yet.", USAGE);
  }
  if (positionals.length < 1 || positionals.length > 2) {
    throw refusal("Give an Instance name and, if you like, an archive.", USAGE);
  }
  const name = positionals[0]!;
  if (name.includes("/") || name.endsWith(".tar.gz")) {
    throw refusal(
      `${name} looks like an archive, but a restore in place takes an Instance name first.`,
      `To rebuild an Instance from an archive: sudo dcabsm instance restore --from ${name}`,
    );
  }
  checkName(name);
  const record = await requireInstance(ctx, name);
  await refuseIfChanging(ctx, name);

  const archive = await pickArchive(ctx, name, positionals[1]);
  const manifest = await readManifest(ctx, archive);
  const from = await runningRelease(ctx, name);
  const plan = await planIfMissing(ctx, manifest.release);
  await checkSpace(ctx, name, true);

  const taken = formatTime(manifest.time);
  ctx.io.out(`Restore ${name} from ${basename(archive)}`);
  ctx.io.out(`  Backup taken ${taken} on Release ${manifest.release}`);
  ctx.io.out(
    `  Keeps hostname ${record.hostname}, port ${record.port} and the current certificate.`,
  );
  beforeRestoreAdvice(ctx, taken);
  await confirmName(ctx, name, values);

  if (plan) await installRelease(ctx, plan);
  const wasUp = RUNNING_STATES.includes(await unitStateOf(ctx, name));
  const job: Job = { name, record, archive, manifest, from, wasUp };
  try {
    await restoreInstance(ctx, job);
  } catch (err) {
    await logChange(ctx, "instance restore", `${name} from ${basename(archive)}: failed`);
    throw err;
  }
  await logChange(ctx, "instance restore", `${name} from ${basename(archive)}: restored`);

  reportUnusedSettings(ctx, record, manifest.release);
  deviceAdvice(ctx);
  if (compareText(manifest.release, from) < 0) {
    ctx.io.out("");
    step(
      ctx,
      "info",
      `${name} is on ${manifest.release}, older than the ${from} it ran. To get ${from} back: sudo dcabsm instance upgrade ${name} --to ${from}`,
    );
  }
}
