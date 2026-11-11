import { join } from "node:path";
import { parseFlags } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { startUnit } from "../host/system.ts";
import { fetchJson, installedNode, isNewer, NODE_INDEX, NODE_SCHEDULE } from "../host/updates.ts";
import { unitStateOf } from "../instance/list.ts";
import {
  instanceNames,
  isChanging,
  readRecord,
  runningRelease,
  unitName,
} from "../instance/record.ts";
import { verifyInstance } from "../instance/verify.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirmOrCancel } from "../prompt.ts";
import type { Invocation } from "../table.ts";
import { installedReleases, releaseLoads, releaseNodeMajor } from "./install.ts";
import { installPatch, pointMajorAt } from "./node.ts";
import { compareText, parseVersion } from "./semver.ts";

/** One installed major with a newer patch on offer. */
interface Update {
  major: number;
  from: string;
  to: string;
}

/** An Instance on the major, and what the update does to it. */
interface Affected {
  name: string;
  state: "running" | "stopped" | "changing";
}

/** The Instances whose Release runs on the Node major (spec 3.3). */
async function instancesOn(ctx: Context, major: number): Promise<Affected[]> {
  const majorOf = new Map<string, number | undefined>();
  const out: Affected[] = [];
  for (const name of await instanceNames(ctx)) {
    if (!(await readRecord(ctx, name))) continue;
    let release: string;
    try {
      release = await runningRelease(ctx, name);
    } catch {
      continue;
    }
    if (!majorOf.has(release)) majorOf.set(release, await releaseNodeMajor(ctx, release));
    if (majorOf.get(release) !== major) continue;
    if (await isChanging(ctx, name)) {
      out.push({ name, state: "changing" });
    } else {
      const unit = await unitStateOf(ctx, name);
      out.push({ name, state: unit === "active" ? "running" : "stopped" });
    }
  }
  return out;
}

function describeAffected(a: Affected): string {
  if (a.state === "stopped") return `${a.name} (stopped, stays stopped)`;
  if (a.state === "changing") return `${a.name} (unfinished Release change, skipped)`;
  return a.name;
}

/** Each installed major's newest patch on nodejs.org when it is newer than the linked one, and the majors that are over. */
async function findUpdates(
  ctx: Context,
  majors: Map<number, string>,
): Promise<{ updates: Update[]; eol: Array<[number, string]> }> {
  let index: Array<{ version: string }>;
  try {
    index = (await fetchJson(ctx, NODE_INDEX, "nodejs.org")) as typeof index;
  } catch (err) {
    throw new CliError(
      errorMessage(err),
      "Nothing was changed. Try again when nodejs.org answers.",
    );
  }
  const updates: Update[] = [];
  for (const [major, from] of [...majors].sort((a, b) => a[0] - b[0])) {
    const patches = index
      .map((e) => e.version.replace(/^v/, ""))
      .filter((v) => parseVersion(v)?.[0] === major)
      .sort(compareText);
    const to = patches[patches.length - 1];
    if (to !== undefined && isNewer(to, from)) updates.push({ major, from, to });
  }
  const eol: Array<[number, string]> = [];
  try {
    const schedule = (await fetchJson(ctx, NODE_SCHEDULE, "the Node release schedule")) as Record<
      string,
      { end?: string }
    >;
    const today = ctx.now().toISOString().slice(0, 10);
    for (const major of [...majors.keys()].sort((a, b) => a - b)) {
      const end = schedule[`v${major}`]?.end;
      if (end !== undefined && end <= today) eol.push([major, end]);
    }
  } catch (err) {
    step(ctx, "warn", errorMessage(err));
  }
  return { updates, eol };
}

/** Installs the patch as Release install does, checks every Release on the major still loads on it, then repoints the link. */
async function installAndRepoint(ctx: Context, u: Update): Promise<void> {
  const bin = join(ctx.paths.node, u.to, "bin", "node");
  if (!(await exists(bin))) await installPatch(ctx, u.to);
  step(ctx, "done", `Installed Node ${u.to}, checked with gpgv`);
  for (const version of await installedReleases(ctx)) {
    if ((await releaseNodeMajor(ctx, version)) !== u.major) continue;
    if (!(await releaseLoads(ctx, join(ctx.paths.releases, version), bin))) {
      throw new CliError(
        `Release ${version} does not load its native modules on Node ${u.to}.`,
        `node/${u.major} still points to ${u.from}. Remove the new runtime with: sudo dcabsm release prune`,
      );
    }
  }
  await pointMajorAt(ctx, u.major, u.to);
  step(ctx, "done", `node/${u.major} → ${u.to}`);
}

/** `release update-node [--yes]` (spec 3.4). */
export async function releaseUpdateNode({ ctx, args }: Invocation): Promise<void> {
  const flags = parseFlags(args, { yes: { type: "boolean" } });
  const majors = await installedNode(ctx);
  if (majors.size === 0) {
    ctx.io.out("No Node runtimes installed.");
    return;
  }
  const { updates, eol } = await findUpdates(ctx, majors);
  for (const [major, end] of eol) {
    step(
      ctx,
      "warn",
      `Node ${major} is end of life (since ${end}). Moving to a newer major needs a Release that runs on it: sudo dcabsm instance upgrade <names>|--all`,
    );
  }
  if (updates.length === 0) {
    ctx.io.out("Every installed Node major is on its newest patch.");
    return;
  }

  const affected = new Map<number, Affected[]>();
  for (const u of updates) {
    const list = await instancesOn(ctx, u.major);
    affected.set(u.major, list);
    ctx.io.out(`Node ${u.from} → ${u.to}`);
    if (list.length > 0) {
      ctx.io.out(`  Restarts, one at a time: ${list.map(describeAffected).join(", ")}`);
    } else {
      ctx.io.out("  No Instance runs on it.");
    }
  }
  await confirmOrCancel(ctx, "Continue?", flags);

  const failed: string[] = [];
  for (const u of updates) {
    await installAndRepoint(ctx, u);
    for (const { name, state } of affected.get(u.major)!) {
      if (state === "changing") {
        step(
          ctx,
          "warn",
          `Skipped ${name}: it has an unfinished Release change. After finishing it: sudo dcabsm instance restart ${name}`,
        );
        continue;
      }
      if (state === "stopped") continue;
      try {
        await startUnit(ctx, "restart", unitName(name));
        step(ctx, "done", `Restarted ${name}`);
        const record = (await readRecord(ctx, name))!;
        const release = await runningRelease(ctx, name);
        const seconds = await verifyInstance(ctx, name, record.port, release);
        step(ctx, "done", `Started and verified: /health UP, /info ${release} (${seconds}s)`);
      } catch (err) {
        failed.push(name);
        step(ctx, "failed", `${name}: ${errorMessage(err)}`);
      }
    }
    await logChange(ctx, "release update-node", `Node ${u.major}: ${u.from} → ${u.to}`);
  }
  if (failed.length > 0) {
    throw new CliError(
      `${failed.length} Instances did not come back: ${failed.join(", ")}.`,
      "See: sudo dcabsm instance logs <name>",
    );
  }
}
