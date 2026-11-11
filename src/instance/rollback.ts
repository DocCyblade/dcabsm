import { basename, join } from "node:path";
import { parseCommand } from "../args.ts";
import { backupRoot, listArchives, stampTime, type ArchiveInfo } from "../backup/archive.ts";
import { checkSpace, RUNNING_STATES, takeBackup } from "../backup/create.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { systemctl } from "../host/system.ts";
import { logChange } from "../log.ts";
import { formatTime, step } from "../output.ts";
import { confirmName, confirmOrCancel } from "../prompt.ts";
import { installRelease } from "../release/install.ts";
import type { Invocation } from "../table.ts";
import { beforeRestoreAdvice, deviceAdvice } from "./device-advice.ts";
import { unitStateOf } from "./list.ts";
import { regroup } from "./regroup.ts";
import {
  accountOf,
  checkName,
  instanceDir,
  isChanging,
  readMarker,
  removeMarker,
  requireInstance,
  runningRelease,
  unitName,
  writeMarker,
  type ChangeMarker,
  type InstanceRecord,
} from "./record.ts";
import { chownData, restoreData } from "./restore-data.ts";
import { SETTINGS, usedBy } from "./setting-table.ts";
import { withStartGate } from "./start-gate.ts";
import { switchRelease } from "./switch.ts";
import { planIfMissing } from "./upgrade-plan.ts";
import { startVerified } from "./verify.ts";

const USAGE = "Usage: dcabsm instance rollback <name> [--restore-data] [--yes] [--confirm <name>]";

interface Job {
  name: string;
  record: InstanceRecord;
  wasUp: boolean;
}

/** Starts and verifies `release` with the unit's marker rule lifted (spec 6.1 step 7). */
const startThroughGate = (ctx: Context, job: Job, release: string): Promise<void> =>
  withStartGate(ctx, job.name, () => startVerified(ctx, job.name, job.record.port, { release }));

/** Names the settings the Release can't use (spec 4.11): the record keeps them for a later Upgrade. */
function reportUnusedSettings(ctx: Context, record: InstanceRecord, release: string): void {
  for (const def of SETTINGS) {
    if (record.settings?.[def.key] !== undefined && !usedBy(def, release)) {
      step(ctx, "info", `${def.key}: not used by ${release}`);
    }
  }
}

function bannerAdvice(ctx: Context): void {
  ctx.io.out("");
  ctx.io.out("On every device");
  step(
    ctx,
    "info",
    'Open tabs show Actual\'s banner "A new version of Actual is available". Click Update now, or reload twice.',
  );
}

/** The change is done: drop the marker, and a stopped Instance returns to stopped. */
async function settle(ctx: Context, job: Job): Promise<void> {
  await removeMarker(ctx, job.name);
  if (!job.wasUp) {
    await systemctl(ctx, "stop", unitName(job.name));
    step(ctx, "info", `${job.name} was stopped before, so it is stopped again`);
  }
}

/** The time in an archive's file name, as shown to the System Admin. */
const takenAt = (archive: ArchiveInfo): string =>
  formatTime(stampTime(archive.stamp).toISOString());

/** Spec 6.5 default: keep current data, go to `to`; on failure return to `from` and verify it. */
async function rollBackKeepingData(
  ctx: Context,
  job: Job,
  archive: ArchiveInfo,
  from: string,
  to: string,
): Promise<void> {
  const { name } = job;
  const marker: ChangeMarker = {
    operation: "rollback",
    from,
    to,
    backup: archive.path,
    restoringData: false,
  };
  await systemctl(ctx, "stop", unitName(name));
  step(ctx, "done", `Stopped ${name}`);
  await writeMarker(ctx, name, marker);
  try {
    await switchRelease(ctx, name, job.record, to);
    step(ctx, "done", `Switched to ${to}, config.json regenerated`);
    await startThroughGate(ctx, job, to);
  } catch (err) {
    step(ctx, "failed", `${to} would not start on the current data: ${errorMessage(err)}`);
    try {
      await systemctl(ctx, "stop", unitName(name));
      // An interruption from here on returns to the newer Release, which is where this is heading.
      await writeMarker(ctx, name, { ...marker, from: to, to: from });
      await switchRelease(ctx, name, job.record, from);
      step(ctx, "done", `Returned to ${from}`);
      await startThroughGate(ctx, job, from);
    } catch (again) {
      await systemctl(ctx, "stop", unitName(name)).catch(() => undefined);
      step(ctx, "failed", `Returning to ${from} failed: ${errorMessage(again)}`);
      throw new CliError(
        `Rollback of ${name} failed, and so did the return to ${from}. ${name} stays stopped.`,
        `Finish the return: sudo dcabsm instance rollback ${name}`,
      );
    }
    await settle(ctx, job);
    throw new CliError(
      `${name} is still on ${from}, data unchanged.`,
      `To go back by restoring the Pre-upgrade backup from ${takenAt(archive)}: sudo dcabsm instance rollback ${name} --restore-data`,
    );
  }
  await settle(ctx, job);
}

/**
 * Puts the `pre-restore` Backup back, with no Regroup (ADR-0004): the Instance was stopped from that
 * Backup until now. Throws if that fails.
 */
async function undoRestore(ctx: Context, job: Job, preRestore: string, from: string) {
  step(ctx, "warn", "Rolling back automatically");
  await systemctl(ctx, "stop", unitName(job.name));
  await restoreData(ctx, job.name, preRestore);
  step(ctx, "done", `Restored data from ${basename(preRestore)}`);
  await switchRelease(ctx, job.name, job.record, from);
  step(ctx, "done", `Switched back to ${from}`);
  await startThroughGate(ctx, job, from);
}

/** Replaces the data from `archive`, regroups, moves to `to` and starts (spec 7.4 steps 4 and 5). */
async function restoreAndStart(ctx: Context, job: Job, archive: string, to: string) {
  const { name } = job;
  await restoreData(ctx, name, archive);
  step(
    ctx,
    "done",
    `Restored data from ${basename(archive)}; ownership set for ${accountOf(name)}`,
  );
  const dir = instanceDir(ctx, name);
  const count = await regroup(join(dir, "server-files"), join(dir, "user-files"));
  await chownData(ctx, name);
  step(ctx, "done", `Regrouped ${count} Budget file${count === 1 ? "" : "s"}`);
  await switchRelease(ctx, name, job.record, to);
  step(ctx, "done", `On Release ${to}, config.json regenerated`);
  await startThroughGate(ctx, job, to);
}

/** Spec 6.5 with `--restore-data`: a `pre-restore` Backup first, then restore as in 7.4. */
async function rollBackRestoringData(
  ctx: Context,
  job: Job,
  archive: ArchiveInfo,
  from: string,
  to: string,
): Promise<void> {
  const { name } = job;
  const unit = unitName(name);
  await systemctl(ctx, "stop", unit);
  step(ctx, "done", `Stopped ${name}`);
  let preRestore: string;
  try {
    preRestore = join(await backupRoot(ctx), name, await takeBackup(ctx, name, "pre-restore"));
  } catch (err) {
    // Nothing has changed yet, so a running Instance goes back up as it was.
    if (job.wasUp) await systemctl(ctx, "start", unit).catch(() => undefined);
    throw err;
  }
  await writeMarker(ctx, name, {
    operation: "rollback",
    from,
    to,
    backup: preRestore,
    archive: archive.path,
    restoringData: true,
  });
  try {
    await restoreAndStart(ctx, job, archive.path, to);
  } catch (err) {
    step(ctx, "failed", errorMessage(err));
    try {
      await undoRestore(ctx, job, preRestore, from);
    } catch (again) {
      await systemctl(ctx, "stop", unit).catch(() => undefined);
      step(ctx, "failed", `Automatic rollback failed: ${errorMessage(again)}`);
      throw new CliError(
        `Rollback of ${name} failed, and so did the automatic return. ${name} stays stopped.`,
        `Its pre-restore backup is kept: ${preRestore}\n  Then try: sudo dcabsm instance rollback ${name}`,
      );
    }
    await settle(ctx, job);
    throw new CliError(
      `Rollback of ${name} failed and was undone. ${name} is on ${from} with its data as it was.`,
      `Why: sudo dcabsm instance logs ${name} --since "15 min ago"`,
    );
  }
  await settle(ctx, job);
}

/** Finishes an interrupted change (spec 6.6). Returns the Release the Instance ends on. */
async function recover(
  ctx: Context,
  job: Job,
  marker: ChangeMarker,
): Promise<{ release: string; restored: boolean }> {
  const { name } = job;
  await systemctl(ctx, "stop", unitName(name));
  try {
    if (marker.operation === "rollback" && !marker.restoringData) {
      // An interrupted data-keeping rollback: go to the marker's to Release and keep the data.
      await switchRelease(ctx, name, job.record, marker.to);
      step(ctx, "done", `Switched to ${marker.to}, config.json regenerated; data kept`);
      await startThroughGate(ctx, job, marker.to);
      return { release: marker.to, restored: false };
    }
    if (marker.operation === "upgrade") {
      // An interrupted Upgrade: restore from its Backup and return to the from Release (no Regroup, 6.3).
      await restoreData(ctx, name, marker.backup);
      step(ctx, "done", `Restored data from ${basename(marker.backup)}`);
      await switchRelease(ctx, name, job.record, marker.from);
      step(ctx, "done", `Switched back to ${marker.from}`);
      await startThroughGate(ctx, job, marker.from);
      return { release: marker.from, restored: false };
    }
    // An interrupted restore (or rollback --restore-data): repeat it.
    if (!marker.archive) {
      throw new CliError(
        "The marker does not name the archive to restore from.",
        `Restore one by hand: remove ${instanceDir(ctx, name)}/.changing-release, then run: sudo dcabsm instance restore ${name} <archive>`,
      );
    }
    await restoreAndStart(ctx, job, marker.archive, marker.to);
    return { release: marker.to, restored: true };
  } catch (err) {
    await systemctl(ctx, "stop", unitName(name)).catch(() => undefined);
    throw new CliError(
      `Finishing the ${marker.operation} of ${name} failed: ${errorMessage(err)}`,
      `${name} stays stopped and the marker stays. See: sudo dcabsm instance logs ${name} --since "15 min ago"`,
    );
  }
}

async function pickPreUpgrade(ctx: Context, name: string): Promise<ArchiveInfo> {
  const newest = (await listArchives(ctx, name)).filter((a) => a.kind === "pre-upgrade").at(-1);
  if (!newest) {
    throw refusal(
      `${name} has no Pre-upgrade backup to go back to.`,
      `See its backups: sudo dcabsm backup list ${name}`,
    );
  }
  return newest;
}

/** Recovers an Instance with a `.changing-release` marker (spec 6.6). */
async function finishInterrupted(ctx: Context, job: Job, yes: boolean): Promise<void> {
  const { name } = job;
  const marker = await readMarker(ctx, name);
  if (!marker) {
    throw new CliError(
      `${name} has an unreadable .changing-release marker.`,
      "Run: sudo dcabsm host doctor",
    );
  }
  ctx.io.out(
    `Finish the unfinished ${marker.operation} of ${name} (${marker.from} → ${marker.to})`,
  );
  await confirmOrCancel(ctx, "Continue?", { yes });
  const needed = marker.operation === "upgrade" ? marker.from : marker.to;
  const plan = await planIfMissing(ctx, needed);
  if (plan) await installRelease(ctx, plan);
  let done;
  try {
    done = await recover(ctx, job, marker);
  } catch (err) {
    await logChange(ctx, "instance rollback", `${name} finishing ${marker.operation}: failed`);
    throw err;
  }
  await removeMarker(ctx, name);
  await logChange(ctx, "instance rollback", `${name} finishing ${marker.operation}: done`);
  reportUnusedSettings(ctx, job.record, done.release);
  bannerAdvice(ctx);
  if (done.restored) deviceAdvice(ctx);
}

/** `instance rollback <name> [--restore-data] [--yes] [--confirm <name>]` (spec 6.5, 6.6) */
export async function instanceRollback({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    "restore-data": { type: "boolean" },
    confirm: { type: "string" },
    yes: { type: "boolean" },
  });
  if (positionals.length !== 1) throw refusal("Give one Instance name.", USAGE);
  const name = positionals[0]!;
  checkName(name);
  const record = await requireInstance(ctx, name);
  const wasUp = RUNNING_STATES.includes(await unitStateOf(ctx, name));
  const job: Job = { name, record, wasUp };
  // `--confirm <name>` answers the Continue prompt too, so a script needs one flag.
  const yes = values.yes === true || values.confirm === name;

  if (await isChanging(ctx, name)) return finishInterrupted(ctx, job, yes);

  const from = await runningRelease(ctx, name);
  const archive = await pickPreUpgrade(ctx, name);
  const to = archive.release;
  if (to === from) {
    throw refusal(
      `Nothing to roll back: the newest Pre-upgrade backup is already on ${from}.`,
      `To restore a Backup: sudo dcabsm instance restore ${name}`,
    );
  }
  const restoring = values["restore-data"] === true;
  const plan = await planIfMissing(ctx, to);
  if (restoring) {
    await checkSpace(ctx, name, true);
    ctx.io.out(`Roll back ${name}: ${from} → ${to}, restoring data`);
    step(
      ctx,
      "warn",
      `Replaces all data with the Pre-upgrade backup from ${takenAt(archive)}. Changes since then are lost.`,
    );
    beforeRestoreAdvice(ctx, takenAt(archive));
    await confirmName(ctx, name, values);
  } else {
    ctx.io.out(`Roll back ${name}: ${from} → ${to}, keeping current data`);
    await confirmOrCancel(ctx, "Continue?", { yes });
  }
  if (plan) await installRelease(ctx, plan);

  const what = restoring ? "restoring data" : "keeping data";
  try {
    if (restoring) await rollBackRestoringData(ctx, job, archive, from, to);
    else await rollBackKeepingData(ctx, job, archive, from, to);
  } catch (err) {
    await logChange(ctx, "instance rollback", `${name} ${from} -> ${to} ${what}: failed`);
    throw err;
  }
  await logChange(ctx, "instance rollback", `${name} ${from} -> ${to} ${what}: done`);
  reportUnusedSettings(ctx, record, to);
  bannerAdvice(ctx);
  if (restoring) deviceAdvice(ctx);
}
