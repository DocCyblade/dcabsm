import type { Context } from "../context.ts";
import { CliError, EXIT_FAILURE, refusal } from "../errors.ts";
import { checkSpace, hasData } from "../backup/create.ts";
import {
  checkReleaseVersion,
  installedReleases,
  latestStable,
  planRelease,
  releaseIntact,
  type Plan,
} from "../release/install.ts";
import { compareText } from "../release/semver.ts";
import { resolveInstanceNames } from "./resolve-names.ts";
import { unitStateOf, type InstanceState } from "./list.ts";
import {
  instanceDir,
  refuseIfChanging,
  requireInstance,
  runningRelease,
  type InstanceRecord,
} from "./record.ts";

/** One Instance the upgrade will move. */
export interface Candidate {
  name: string;
  record: InstanceRecord;
  from: string;
  state: InstanceState;
  /** It has never started, so it has no data and only changes Release. */
  fresh: boolean;
}

/** Resolves `<names>|--all` to Instance names, refusing before anything runs. */
export async function resolveNames(
  ctx: Context,
  names: string[],
  all: boolean | undefined,
): Promise<string[]> {
  const usage = "Usage: dcabsm instance upgrade <names>|--all [--to <v>] [--yes]";
  return resolveInstanceNames(ctx, names, all, { usage });
}

/**
 * The target Release (spec 6.1): `--to`, or the latest stable on npm. If npm can't be reached, the
 * command fails and asks for `--to` with an installed Release.
 */
export async function resolveTarget(ctx: Context, to: string | undefined): Promise<string> {
  if (to !== undefined) {
    checkReleaseVersion(to);
    return to;
  }
  try {
    return await latestStable(ctx);
  } catch (err) {
    if (!(err instanceof CliError) || err.code !== EXIT_FAILURE) throw err;
    const installed = await installedReleases(ctx);
    throw new CliError(
      err.message,
      `Give an installed Release: dcabsm instance upgrade <names> --to <v> (installed: ${installed.join(", ") || "none"})`,
    );
  }
}

/** Looks at each Instance, refusing before anything changes: an unfinished change, or an older target. */
export async function candidates(
  ctx: Context,
  names: string[],
  target: string,
): Promise<{ moving: Candidate[]; skipped: Array<{ name: string; from: string }> }> {
  const moving: Candidate[] = [];
  const skipped: Array<{ name: string; from: string }> = [];
  for (const name of names) {
    const record = await requireInstance(ctx, name);
    await refuseIfChanging(ctx, name);
    const from = await runningRelease(ctx, name);
    const order = compareText(target, from);
    if (order < 0) {
      throw refusal(
        `${name} runs ${from}, which is newer than ${target}. Upgrade never goes backwards.`,
        `To go one step back: sudo dcabsm instance rollback ${name}`,
      );
    }
    if (order === 0) {
      skipped.push({ name, from });
      continue;
    }
    const state = await unitStateOf(ctx, name);
    moving.push({ name, record, from, state, fresh: !(await hasData(instanceDir(ctx, name))) });
  }
  return { moving, skipped };
}

/** Free space for every Backup, checked before anything stops (spec 6.1 step 2). */
export async function checkAllSpace(ctx: Context, moving: Candidate[]): Promise<void> {
  for (const c of moving) if (!c.fresh) await checkSpace(ctx, c.name, true);
}

/** A plan for the target if it isn't installed and intact yet; undefined when it is. */
export async function planIfMissing(ctx: Context, target: string): Promise<Plan | undefined> {
  return (await releaseIntact(ctx, target)) ? undefined : planRelease(ctx, target);
}
