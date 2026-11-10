import type { Context } from "./context.ts";
import { CliError, errorMessage } from "./errors.ts";

/** Fetches a URL and returns the body, or throws a plain error for an unreachable host or a non-200 answer. */
export async function fetchOk(ctx: Context, url: string): Promise<Uint8Array> {
  let res;
  try {
    res = await ctx.fetcher.fetch(url);
  } catch (err) {
    throw new CliError(
      `Could not reach ${new URL(url).host}: ${errorMessage(err)}`,
      "Check the network, then run again.",
    );
  }
  if (res.status !== 200) throw new CliError(`${url} answered ${res.status}.`);
  return res.body;
}
