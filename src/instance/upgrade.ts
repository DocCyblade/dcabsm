import { parseCommand } from "../args.ts";
import { formatColumns } from "../columns.ts";
import type { Context } from "../context.ts";
import { CliError } from "../errors.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirmOrCancel } from "../prompt.ts";
import { installRelease } from "../release/install.ts";
import type { Invocation } from "../table.ts";
import { upgradeInstance, type Outcome } from "./upgrade-one.ts";
import {
  candidates,
  checkAllSpace,
  planIfMissing,
  resolveNames,
  resolveTarget,
  type Candidate,
} from "./upgrade-plan.ts";

const RELEASE_NOTES = "https://actualbudget.org/docs/releases";

function describe(c: Candidate, target: string): string {
  const note = c.fresh
    ? "  (never started; only changes Release)"
    : c.state === "stopped" || c.state === "failed"
      ? `  (${c.state}; returns to stopped)`
      : "";
  return `  ${c.name.padEnd(10)} ${c.from} → ${target}${note}`;
}

/** The result column of the summary. */
function resultOf(o: Outcome | undefined, from: string): string {
  if (!o) return "not started";
  switch (o.kind) {
    case "upgraded":
      return "upgraded";
    case "unchanged":
      return `failed, still on ${from}`;
    case "rolled-back":
      return `failed, back on ${from}`;
    case "stuck":
      return "failed, stopped";
  }
}

function failureError(name: string, o: Exclude<Outcome, { kind: "upgraded" }>): CliError {
  switch (o.kind) {
    case "unchanged":
      return new CliError(
        `Upgrade of ${name} failed before anything changed: ${o.why}`,
        `Nothing was changed. See: sudo dcabsm instance logs ${name} --since "15 min ago"`,
      );
    case "rolled-back":
      return new CliError(
        `Upgrade of ${name} failed and was rolled back. Its data is as it was before the upgrade.`,
        `Why: sudo dcabsm instance logs ${name} --since "15 min ago"`,
      );
    case "stuck":
      return new CliError(
        `Upgrade of ${name} failed, and so did the automatic rollback. ${name} stays stopped.`,
        `Its Pre-upgrade backup is kept: ${o.backup}\n  Then try: sudo dcabsm instance rollback ${name}`,
      );
  }
}

function summarize(ctx: Context, rows: string[][]): void {
  ctx.io.out("");
  ctx.io.out("Summary");
  for (const line of formatColumns([["INSTANCE", "RESULT"], ...rows])) ctx.io.out(line);
}

/** `instance upgrade <names>|--all [--to <v>] [--yes]` (spec 6.1). */
export async function instanceUpgrade({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    all: { type: "boolean" },
    to: { type: "string" },
    yes: { type: "boolean" },
  });
  const names = await resolveNames(ctx, positionals, values.all);
  const target = await resolveTarget(ctx, values.to);
  const { moving, skipped } = await candidates(ctx, names, target);
  if (moving.length === 0) {
    for (const s of skipped) ctx.io.out(`${s.name} is already on ${s.from}.`);
    return;
  }
  const plan = await planIfMissing(ctx, target);
  await checkAllSpace(ctx, moving);

  ctx.io.out(`Upgrade to Actual ${target}`);
  for (const c of moving) ctx.io.out(describe(c, target));
  for (const s of skipped) ctx.io.out(`  ${s.name.padEnd(10)} already on ${s.from}, skipped`);
  ctx.io.out(`  Release notes: ${RELEASE_NOTES}`);
  ctx.io.out("  Each Instance stops for its Pre-upgrade backup and the switch, one at a time.");
  await confirmOrCancel(ctx, "Continue?", { yes: values.yes });
  if (plan) await installRelease(ctx, plan);

  const results = new Map<string, Outcome>();
  let failure: CliError | undefined;
  for (const { name, record, from } of moving) {
    ctx.io.out("");
    ctx.io.out(name);
    const outcome = await upgradeInstance(ctx, { name, record, from, to: target });
    results.set(name, outcome);
    const tail = outcome.kind === "stuck" ? `, backup kept at ${outcome.backup}` : "";
    await logChange(
      ctx,
      "instance upgrade",
      `${name} ${from} -> ${target}: ${outcome.kind}${tail}`,
    );
    if (outcome.kind !== "upgraded") {
      failure = failureError(name, outcome);
      break;
    }
  }

  summarize(ctx, [
    ...moving.map((c) => [c.name, resultOf(results.get(c.name), c.from)]),
    ...skipped.map((s) => [s.name, `skipped, already on ${s.from}`]),
  ]);
  if ([...results.values()].some((o) => o.kind === "upgraded")) {
    ctx.io.out("");
    ctx.io.out("On every device");
    step(
      ctx,
      "info",
      'Open tabs show Actual\'s banner "A new version of Actual is available". Click Update now, or reload twice.',
    );
  }
  if (failure) throw failure;
}
