import type { Context } from "../context.ts";
import { refusal } from "../errors.ts";
import { readHostConfig } from "../host/config.ts";
import { LAYOUT, VERSION } from "../version.ts";

/** The layout version stored on the Host, or undefined when none is stored yet (spec 11.4). */
export async function storedLayout(ctx: Context): Promise<number | undefined> {
  try {
    const layout = (await readHostConfig(ctx))?.layout;
    return typeof layout === "number" ? layout : undefined;
  } catch {
    // A file that can't be read is the business of the command that needs it.
    return undefined;
  }
}

/**
 * The gate every command passes except Self-update's own steps (spec 11.4): a Host on a
 * different layout than this version expects is left alone.
 */
export async function checkLayout(ctx: Context): Promise<void> {
  const stored = await storedLayout(ctx);
  if (stored === undefined || stored === LAYOUT) return;
  if (stored > LAYOUT) {
    const since = (await readHostConfig(ctx))?.layoutSince;
    throw refusal(
      `This Host was last changed by a newer DCABSM (layout ${stored}). This is DCABSM ${VERSION} (layout ${LAYOUT}).`,
      `Install ${since ? `DCABSM ${since} or newer` : "a newer DCABSM"}: sudo dcabsm self update`,
    );
  }
  throw refusal(
    `This Host is on layout ${stored}, and DCABSM ${VERSION} expects layout ${LAYOUT}. Its stored state needs migrating first.`,
    "Run: sudo dcabsm self update",
  );
}
