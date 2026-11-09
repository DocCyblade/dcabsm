import type { Context } from "./context.ts";

/**
 * Logs one line to journald through the command-runner seam:
 * `logger -t dcabsm "<command>: <outcome>"`. A logging failure never fails
 * the command.
 */
export async function logChange(ctx: Context, command: string, outcome: string): Promise<void> {
  try {
    await ctx.runner.run("logger", ["-t", "dcabsm", `${command}: ${outcome}`]);
  } catch {
    // Logging must not break a command.
  }
}
