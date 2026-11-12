import { basename } from "node:path";
import { parseCommand } from "../args.ts";
import {
  listArchives,
  readManifest,
  requireArchiveFile,
  type Manifest,
} from "../backup/archive.ts";
import { checkSpace, RUNNING_STATES } from "../backup/create.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { systemctl } from "../host/system.ts";
import { logChange } from "../log.ts";
import { formatTime, step } from "../output.ts";
import { confirmName } from "../prompt.ts";
import { installRelease } from "../release/install.ts";
import { compareText } from "../release/semver.ts";
import type { Invocation } from "../table.ts";
import { beforeRestoreAdvice, deviceAdvice } from "./device-advice.ts";
import { writeVhost } from "./files.ts";
import { unitStateOf } from "./list.ts";
import {
  accountOf,
  checkName,
  refuseIfChanging,
  removeMarker,
  requireInstance,
  runningRelease,
  unitName,
  writeMarker,
  type InstanceRecord,
} from "./record.ts";
import { regroupedLine, restoreAndRegroup, restoreData, stopAndBackUp } from "./restore-data.ts";
import { restoreFrom } from "./restore-from.ts";
import { reportUnusedSettings } from "./setting-table.ts";
import { startThroughGate } from "./start-gate.ts";
import { switchRelease } from "./switch.ts";
import { planIfMissing } from "./upgrade-plan.ts";

const USAGE =
  "Usage: dcabsm instance restore <name> [<archive>] [--confirm <name>] | restore --from <archive>";

/** The archive to restore: the one given, or the newest in the Instance's backup directory. */
async function pickArchive(ctx: Context, name: string, given: string | undefined) {
  if (given !== undefined) {
    return requireArchiveFile(given);
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

interface Job {
  name: string;
  record: InstanceRecord;
  archive: string;
  manifest: Manifest;
  /** The Release the Instance runs now. */
  from: string;
  wasUp: boolean;
}

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

  const backup = await stopAndBackUp(ctx, name, job.wasUp);
  await writeMarker(ctx, name, {
    operation: "restore",
    from,
    to,
    backup,
    archive: job.archive,
    restoringData: true,
  });

  try {
    const count = await restoreAndRegroup(ctx, name, job.archive);
    step(
      ctx,
      "done",
      `Replaced data, server-files and user-files; ownership set for ${accountOf(name)}`,
    );
    step(ctx, "done", regroupedLine(count));
    await switchRelease(ctx, name, record, to);
    // The same text as before unless someone edited it by hand, and the hostname and certificate
    // are unchanged, so Nginx needs no reload.
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
        `Its pre-restore Backup is kept: ${backup}\n  Then try: sudo dcabsm instance rollback ${name}`,
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
    if (positionals.length > 0) {
      throw refusal("instance restore --from takes an archive and no Instance name.", USAGE);
    }
    return restoreFrom(ctx, values.from);
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
