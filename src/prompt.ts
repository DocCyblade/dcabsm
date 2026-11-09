import type { Context } from "./context.ts";
import { Cancelled, refusal } from "./errors.ts";

export interface ConfirmFlags {
  /** `--yes`: answers an ordinary prompt. */
  yes?: boolean;
  /** `--confirm <name>`: answers a typed-name prompt. */
  confirm?: string;
}

function noTerminal(flag: string) {
  return refusal("No terminal to confirm on.", `Re-run with ${flag} to proceed without asking.`);
}

/** Destructive commands: the person types the Instance name, or a script passes `--confirm <name>`. */
export async function confirmName(
  ctx: Context,
  name: string,
  flags: ConfirmFlags = {},
): Promise<void> {
  let typed = flags.confirm;
  if (typed === undefined) {
    if (!ctx.io.interactive) throw noTerminal(`--confirm ${name}`);
    typed = (await ctx.io.ask(`Type the Instance name ${name} to confirm: `)).trim();
  }
  if (typed !== name) throw new Cancelled("The name did not match. Nothing changed.");
}

/** Other prompts: `[y/N]` (or `[Y/n]` with `defaultYes`). `--yes` answers yes. */
export async function confirm(
  ctx: Context,
  question: string,
  flags: ConfirmFlags & { defaultYes?: boolean } = {},
): Promise<boolean> {
  if (flags.yes) return true;
  if (!ctx.io.interactive) throw noTerminal("--yes");
  const defaultYes = flags.defaultYes === true;
  const answer = (await ctx.io.ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `))
    .trim()
    .toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Like `confirm`, but a "no" cancels the command: "Cancelled. Nothing changed.", exit 1. */
export async function confirmOrCancel(
  ctx: Context,
  question: string,
  flags: ConfirmFlags = {},
): Promise<void> {
  if (!(await confirm(ctx, question, flags))) throw new Cancelled();
}
