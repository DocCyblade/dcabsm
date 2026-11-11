import type { Context } from "../context.ts";
import { CliError, firstLine } from "../errors.ts";

/** What the Host's package manager and service manager say, shared by setup and doctor. */

export async function isInstalled(ctx: Context, pkg: string): Promise<boolean> {
  const res = await ctx.runner.run("dpkg-query", ["-W", "-f=${Status}", pkg]);
  return res.code === 0 && res.stdout.includes("install ok installed");
}

const systemctlOk = async (ctx: Context, ...args: string[]): Promise<boolean> =>
  (await ctx.runner.run("systemctl", args)).code === 0;

export const nginxIsActive = (ctx: Context): Promise<boolean> =>
  systemctlOk(ctx, "is-active", "--quiet", "nginx");

export const nginxIsEnabled = (ctx: Context): Promise<boolean> =>
  systemctlOk(ctx, "is-enabled", "--quiet", "nginx");

export const timerIsEnabled = (ctx: Context): Promise<boolean> =>
  systemctlOk(ctx, "is-enabled", "--quiet", "dcabsm-nightly.timer");

/** Whether Nginx is both running and enabled at boot. */
export async function nginxUp(ctx: Context): Promise<boolean> {
  return (await nginxIsActive(ctx)) && (await nginxIsEnabled(ctx));
}

/** The reason `nginx -t` fails, or undefined when it passes. */
export async function nginxTestFailure(ctx: Context): Promise<string | undefined> {
  const test = await ctx.runner.run("nginx", ["-t"]);
  return test.code === 0 ? undefined : firstLine(test.stderr, "no reason given");
}

/** Runs `systemctl`, failing the command if it fails. */
export async function systemctl(ctx: Context, ...args: string[]): Promise<void> {
  const res = await ctx.runner.run("systemctl", args);
  if (res.code !== 0) {
    throw new CliError(
      `systemctl ${args.join(" ")} failed: ${firstLine(res.stderr, `exit ${res.code}`)}`,
      "Fix the problem, then run the command again",
    );
  }
}

/**
 * Starts an Instance unit the Manager means to start. The unit's start limit (3 in 300s) guards a
 * crash loop, so a deliberate start clears the count first: stops, restarts and upgrades in a row
 * must not trip it.
 */
export async function startUnit(
  ctx: Context,
  verb: "start" | "restart",
  unit: string,
): Promise<void> {
  await ctx.runner.run("systemctl", ["reset-failed", unit]);
  await systemctl(ctx, verb, unit);
}

/** Runs a command and throws a CliError with its first stderr line if it fails. */
export async function runChecked(ctx: Context, command: string, args: string[]) {
  const res = await ctx.runner.run(command, args);
  if (res.code !== 0) {
    throw new CliError(
      `${[command, ...args.slice(0, 1)].join(" ")} failed: ${firstLine(res.stderr, `exit ${res.code}`)}`,
    );
  }
  return res;
}
