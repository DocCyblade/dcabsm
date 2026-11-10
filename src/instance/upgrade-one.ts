import { join } from "node:path";
import { backupRoot } from "../backup/archive.ts";
import { hasData, RUNNING_STATES, takeBackup } from "../backup/create.ts";
import type { Context } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import { writeConfigJson } from "./files.ts";
import { unitStateOf } from "./list.ts";
import { instanceDir, removeMarker, writeMarker, type InstanceRecord } from "./record.ts";
import { restoreData } from "./restore-data.ts";
import { withStartGate } from "./start-gate.ts";
import { repointRelease, switchRelease } from "./switch.ts";
import { verifyInstance } from "./verify.ts";

/** How one Instance's upgrade ended (spec 6.1, 6.3). */
export type Outcome =
  /** On the new Release. */
  | { kind: "upgraded" }
  /** It failed before the symlink moved and is on its old Release, nothing changed. */
  | { kind: "unchanged"; why: string }
  /** Verification failed and the automatic rollback put it back. */
  | { kind: "rolled-back"; why: string }
  /** The rollback failed too: the Instance stays stopped and the Backup is kept. */
  | { kind: "stuck"; why: string; backup: string };

export interface UpgradeJob {
  name: string;
  record: InstanceRecord;
  from: string;
  to: string;
}

const unit = (name: string) => `dcabsm@${name}`;

/** Starts the unit and checks it runs `release` (spec 6.2). */
async function startAndVerify(ctx: Context, job: UpgradeJob, release: string): Promise<void> {
  await systemctl(ctx, "start", unit(job.name));
  const seconds = await verifyInstance(ctx, job.name, job.record.port, release);
  step(ctx, "done", `Started and verified: /health UP, /info ${release} (${seconds}s)`);
}

/** The same with the marker in place, so the unit's marker rule is lifted for this start (spec 6.1). */
const startAndVerifyChanging = (ctx: Context, job: UpgradeJob, release: string): Promise<void> =>
  withStartGate(ctx, job.name, () => startAndVerify(ctx, job, release));

/** The Instance never started, so it has no data: it only changes Release (spec 6.1). */
async function changeReleaseOnly(ctx: Context, job: UpgradeJob): Promise<Outcome> {
  try {
    await switchRelease(ctx, job.name, job.record, job.to);
  } catch (err) {
    await repointRelease(ctx, job.name, job.from).catch(() => undefined);
    return { kind: "unchanged", why: errorMessage(err) };
  }
  step(
    ctx,
    "done",
    `Switched to ${job.to}, config.json regenerated. It has never started, so it has no data to back up`,
  );
  return { kind: "upgraded" };
}

/** Before the symlink moved: nothing changed, so a running Instance just starts on its old Release. */
async function restartOld(
  ctx: Context,
  job: UpgradeJob,
  wasUp: boolean,
  err: unknown,
): Promise<Outcome> {
  await removeMarker(ctx, job.name);
  let why = errorMessage(err);
  if (wasUp) {
    step(ctx, "warn", `Restarting ${job.name} on ${job.from}; nothing was changed`);
    try {
      await startAndVerify(ctx, job, job.from);
    } catch (again) {
      why = `${why}. It also did not come back on ${job.from}: ${errorMessage(again)}`;
    }
  }
  return { kind: "unchanged", why };
}

/**
 * Automatic rollback (spec 6.3): restore data from the Pre-upgrade backup, repoint to the old Release
 * and verify, with no Regroup. A failure leaves the Instance stopped and the marker in place.
 */
async function rollBack(
  ctx: Context,
  job: UpgradeJob,
  backup: string,
  why: string,
  wasUp: boolean,
): Promise<Outcome> {
  const { name, from } = job;
  step(ctx, "warn", "Rolling back automatically");
  try {
    await systemctl(ctx, "stop", unit(name));
    await writeMarker(ctx, name, {
      operation: "upgrade",
      from,
      to: job.to,
      backup,
      restoringData: true,
    });
    await restoreData(ctx, name, backup);
    step(ctx, "done", `Restored data from ${backup.split("/").at(-1)}`);
    await switchRelease(ctx, name, job.record, from);
    step(ctx, "done", `Switched back to ${from}`);
    await startAndVerifyChanging(ctx, job, from);
  } catch (err) {
    await systemctl(ctx, "stop", unit(name)).catch(() => undefined);
    step(ctx, "failed", `Automatic rollback failed: ${errorMessage(err)}`);
    return { kind: "stuck", why, backup };
  }
  await removeMarker(ctx, name);
  if (!wasUp) await systemctl(ctx, "stop", unit(name));
  return { kind: "rolled-back", why };
}

/**
 * Upgrades one Instance (spec 6.1). The caller holds the lock and has installed the target Release.
 * Never throws for a failed upgrade: the outcome says what state the Instance is in.
 */
export async function upgradeInstance(ctx: Context, job: UpgradeJob): Promise<Outcome> {
  const { name, from, to } = job;
  if (!(await hasData(instanceDir(ctx, name)))) return changeReleaseOnly(ctx, job);

  const wasUp = RUNNING_STATES.includes(await unitStateOf(ctx, name));
  let backup: string;
  try {
    // Stopped first, so the Backup holds exactly what the old Release left (spec 6.1 steps 3 and 4).
    await systemctl(ctx, "stop", unit(name));
    step(ctx, "done", `Stopped ${name}`);
    backup = join(await backupRoot(ctx), name, await takeBackup(ctx, name, "pre-upgrade"));
    await writeMarker(ctx, name, { operation: "upgrade", from, to, backup, restoringData: false });
    await repointRelease(ctx, name, to);
  } catch (err) {
    return restartOld(ctx, job, wasUp, err);
  }

  try {
    await writeConfigJson(ctx, name, job.record, to);
    step(ctx, "done", `Switched to ${to}, config.json regenerated`);
    await startAndVerifyChanging(ctx, job, to);
  } catch (err) {
    step(ctx, "failed", errorMessage(err));
    return rollBack(ctx, job, backup, errorMessage(err), wasUp);
  }
  await removeMarker(ctx, name);
  // A stopped or failed Instance returns to stopped once it has proved the new Release starts.
  if (!wasUp) {
    await systemctl(ctx, "stop", unit(name));
    step(ctx, "info", `${name} was stopped before the upgrade, so it is stopped again`);
  }
  return { kind: "upgraded" };
}
