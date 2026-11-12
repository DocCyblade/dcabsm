import { parseFlags } from "../args.ts";
import type { Context } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { lockHolder } from "../lock.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { noTerminal } from "../prompt.ts";
import { hostChecks, hostFacts, type CheckResult, type Refusal, type Severity } from "./checks.ts";

const MARK = { note: "info", warn: "warn", fail: "failed" } as const;
const RANK: Record<Severity, number> = { note: 0, warn: 1, fail: 2 };

async function runAll(ctx: Context): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const facts = hostFacts(ctx);
  for (const check of hostChecks) results.push(...(await check.run(ctx, facts)));
  return results;
}

function report(ctx: Context, results: CheckResult[]): void {
  for (const result of results) {
    if (result.kind === "pass") {
      step(ctx, "done", result.label);
      continue;
    }
    step(ctx, MARK[result.severity], result.message + (result.fix ? "  (host doctor --fix)" : ""));
    if (result.hint) ctx.io.out(`      ${result.hint}`);
  }
}

/** 0 for a pass or notes only, 1 for warnings, 2 for any failure. */
export function exitCode(results: CheckResult[]): number {
  let worst = -1;
  for (const r of results) if (r.kind === "problem") worst = Math.max(worst, RANK[r.severity]);
  return worst < 1 ? 0 : worst;
}

/** Asks fix or skip for each fixable problem, with an `all` answer for the rest. `--yes` fixes everything. */
async function fixProblems(ctx: Context, results: CheckResult[], yes?: boolean): Promise<void> {
  let all = yes === true;
  for (const result of results) {
    if (result.kind !== "problem" || !result.fix) continue;
    const { fix } = result;
    if (!all) {
      ctx.io.out(result.message);
      for (const line of fix.diff ?? []) ctx.io.out(`    ${line}`);
      const answer = (await ctx.io.ask("fix / skip / all? [f/s/a] ")).trim().toLowerCase();
      if (answer === "a" || answer === "all") all = true;
      else if (answer !== "f" && answer !== "fix") continue;
    }
    try {
      await fix.apply({ yes: yes === true });
      step(ctx, "done", `Fixed: ${result.message}`);
      await logChange(ctx, "host doctor --fix", `fixed: ${result.message}`);
    } catch (err) {
      step(ctx, "failed", `Could not fix: ${result.message}: ${errorMessage(err)}`);
    }
  }
}

/** `host doctor [--fix] [--yes]` (spec 10.6). Read-only unless `--fix`, which holds the lock (cli.ts). */
export async function hostDoctor({ ctx, args }: { ctx: Context; args: string[] }): Promise<number> {
  const flags = parseFlags(args, { fix: { type: "boolean" }, yes: { type: "boolean" } });
  if (flags.fix && !flags.yes && !ctx.io.interactive) throw noTerminal("--yes");

  if (!flags.fix) {
    ctx.io.out("Read-only. Takes no lock.");
    const holder = await lockHolder(ctx);
    if (holder) {
      step(
        ctx,
        "warn",
        `The lock is held by pid ${holder.pid} (${holder.command}); doctor does not wait for it, and what it finds may change.`,
      );
    }
  }

  let results = await runAll(ctx);
  if (flags.fix) {
    const fixable = results.filter((r): r is Refusal => r.kind === "problem" && !!r.fix);
    if (fixable.length === 0) ctx.io.out("Nothing for --fix to do.");
    await fixProblems(ctx, results, flags.yes);
    ctx.io.out("");
    results = await runAll(ctx);
  }
  report(ctx, results);
  return exitCode(results);
}
