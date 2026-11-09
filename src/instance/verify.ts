import type { Context } from "../context.ts";
import { CliError } from "../errors.ts";

/** How long a started Instance has to come up (spec 6.2). */
export const VERIFY_SECONDS = 120;
const POLL_MS = 1000;

const sleepFor = (ctx: Context, ms: number) =>
  ctx.sleep ? ctx.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms));

async function getJson(ctx: Context, url: string): Promise<Record<string, any> | undefined> {
  try {
    const res = await ctx.fetcher.fetch(url);
    if (res.status !== 200) return undefined;
    return JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    return undefined;
  }
}

/**
 * Verification (spec 6.2): within 120 s the unit is active, `/health` is UP and `/info` reports the
 * target version. A unit that restarted during the window fails. Returns the seconds it took.
 */
export async function verifyInstance(
  ctx: Context,
  name: string,
  port: number,
  version: string,
): Promise<number> {
  const unit = `dcabsm@${name}`;
  const began = ctx.now().getTime();
  const elapsed = () => Math.round((ctx.now().getTime() - began) / 1000);
  const fail = (why: string) =>
    new CliError(
      `${name} did not pass verification within ${VERIFY_SECONDS} s: ${why}`,
      `See: sudo dcabsm instance logs ${name}`,
    );

  let last = "it never answered on /health";
  while (ctx.now().getTime() - began <= VERIFY_SECONDS * 1000) {
    const restarts = await ctx.runner.run("systemctl", [
      "show",
      "-p",
      "NRestarts",
      "--value",
      unit,
    ]);
    if (Number(restarts.stdout.trim()) > 0) throw fail("the unit restarted during the window");

    const active = await ctx.runner.run("systemctl", ["is-active", unit]);
    const state = active.stdout.trim();
    if (state === "failed") throw fail("the unit failed");
    if (active.code === 0) {
      const health = await getJson(ctx, `http://127.0.0.1:${port}/health`);
      if (health?.status === "UP") {
        const info = await getJson(ctx, `http://127.0.0.1:${port}/info`);
        const reported = info?.build?.version;
        if (reported === version) return elapsed();
        if (reported !== undefined) throw fail(`/info reports ${reported}, not ${version}`);
        last = "/info did not answer";
      } else {
        last = "it never answered on /health";
      }
    } else {
      last = `the unit is ${state || "not active"}`;
    }
    await sleepFor(ctx, POLL_MS);
  }
  throw fail(last);
}
