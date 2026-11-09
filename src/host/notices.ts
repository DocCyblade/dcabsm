import type { Context } from "../context.ts";
import { logChange } from "../log.ts";
import { bannerLine, readHostConfig } from "./config.ts";
import { detectOs } from "./os.ts";

/**
 * What every command except `host setup` says before it starts (spec 10.3, 10.4):
 * the Unsupported Host banner, and a warning, logged, if the OS is no longer
 * a supported one. Only setup refuses. `host doctor` reports both as failures
 * itself, so it skips the banner.
 */
export async function hostNotices(ctx: Context, isDoctor: boolean): Promise<void> {
  const stored = await readHostConfig(ctx);
  if (stored?.unsupportedHost && !isDoctor) ctx.io.err(bannerLine(stored.unsupportedHost));
  if (stored === undefined) return;

  const os = await detectOs(ctx);
  if (!os.supported) {
    ctx.io.err(
      `! ${os.name} on ${os.arch} is not a supported Host. Backup and restore still work, but you are on your own.`,
    );
    await logChange(ctx, "host check", `unsupported OS ${os.name} on ${os.arch}`);
  }
}
