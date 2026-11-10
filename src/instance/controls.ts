import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import {
  instanceNames,
  refuseIfChanging,
  requireInstance,
  runningRelease,
  type InstanceRecord,
} from "./record.ts";
import { verifyInstance } from "./verify.ts";

type Control = "start" | "stop" | "restart";

/** One Instance a control command works on. */
interface Target {
  name: string;
  record: InstanceRecord;
}

/** Resolves `<names>|--all` to existing Instances, refusing before anything runs. */
async function targets(
  ctx: Context,
  verb: Control,
  names: string[],
  all: boolean | undefined,
): Promise<Target[]> {
  if (all && names.length > 0) {
    throw refusal(
      "Give Instance names or --all, not both.",
      `Usage: dcabsm instance ${verb} <names>|--all`,
    );
  }
  const list = all ? await instanceNames(ctx) : [...new Set(names)];
  if (list.length === 0) {
    throw refusal(
      all ? "There are no Instances." : "Give at least one Instance name, or --all.",
      all
        ? "Create one: dcabsm instance create <name> --hostname <host> --self-signed"
        : `Usage: dcabsm instance ${verb} <names>|--all`,
    );
  }
  const out: Target[] = [];
  for (const name of list) {
    const record = await requireInstance(ctx, name);
    // Stopping is always allowed: it is how the System Admin gets out of a half-done change.
    if (verb !== "stop") await refuseIfChanging(ctx, name);
    out.push({ name, record });
  }
  return out;
}

async function control(verb: Control, { ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, { all: { type: "boolean" } });
  const list = await targets(ctx, verb, positionals, values.all);
  let failed = 0;
  for (const { name, record } of list) {
    const unit = `dcabsm@${name}`;
    if (list.length > 1) ctx.io.out(name);
    try {
      if (verb === "stop") {
        await systemctl(ctx, "stop", unit);
        await systemctl(ctx, "disable", unit);
        step(
          ctx,
          "done",
          `Stopped ${name}. It stays stopped after a reboot, and its hostname shows Nginx's 502 until started.`,
        );
        continue;
      }
      await systemctl(ctx, verb, unit);
      const release = await runningRelease(ctx, name);
      const seconds = await verifyInstance(ctx, name, record.port, release);
      if (verb === "start") await systemctl(ctx, "enable", unit);
      step(ctx, "done", `Started and verified: /health UP, /info ${release} (${seconds}s)`);
    } catch (err) {
      failed++;
      step(ctx, "failed", `${name}: ${errorMessage(err)}`);
    }
  }
  if (failed > 0) {
    throw new CliError(
      `${failed} of ${list.length} Instances failed.`,
      "See: sudo dcabsm instance logs <name>",
    );
  }
}

export const instanceStart = (inv: Invocation): Promise<void> => control("start", inv);
export const instanceStop = (inv: Invocation): Promise<void> => control("stop", inv);
export const instanceRestart = (inv: Invocation): Promise<void> => control("restart", inv);

/** `instance logs <name> [-f] [--since <time>]` */
export async function instanceLogs({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(
    args.map((a) => (a === "-f" ? "--follow" : a)),
    { follow: { type: "boolean" }, since: { type: "string" } },
  );
  if (positionals.length !== 1) {
    throw refusal(
      "Give one Instance name.",
      "Usage: dcabsm instance logs <name> [-f] [--since <time>]",
    );
  }
  const name = positionals[0]!;
  await requireInstance(ctx, name);
  const journal = ["-u", `dcabsm@${name}`, "--no-pager"];
  if (values.since !== undefined) journal.push("--since", values.since);
  else journal.push("-n", "50");
  if (values.follow) journal.push("-f");

  if (values.follow && ctx.runner.inherit) {
    const code = await ctx.runner.inherit("journalctl", journal);
    if (code !== 0) throw new CliError(`journalctl exited with ${code}.`);
    return;
  }
  const res = await ctx.runner.run("journalctl", journal);
  if (res.code !== 0) {
    throw new CliError(`journalctl failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  for (const line of res.stdout.split("\n")) if (line !== "") ctx.io.out(line);
}
