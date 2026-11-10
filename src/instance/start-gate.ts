import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { INSTANCES_LOGICAL } from "../paths.ts";
import { systemctl } from "../host/system.ts";

const GATE_FILE = "10-start-gate.conf";

/** Where systemd looks for runtime drop-ins of one Instance's unit. It is under `/run`, so a boot wipes it. */
export const gateDir = (ctx: Context, name: string): string =>
  ctx.paths.under(`/run/systemd/system/dcabsm@${name}.service.d`);

/**
 * The drop-in lifts the marker rule and nothing else. An empty `ConditionPathExists=` clears every
 * one of them, so the Release's Node check (spec 4.5) is put back.
 */
export function gateText(name: string): string {
  const dir = `${INSTANCES_LOGICAL}/${name}`;
  return `[Unit]\nConditionPathExists=\nConditionPathExists=${dir}/release/node/bin/node\n`;
}

/**
 * Runs `fn`, the start and its verification, with the unit's `.changing-release` rule lifted for this
 * Instance only (spec 6.1 step 7). The change marker is still there, so the rule would otherwise skip
 * the start without an error. The gate lives under `/run`: if DCABSM dies or the Host reboots before it
 * is closed, the boot wipes it and the rule guards the Instance again.
 */
export async function withStartGate<T>(
  ctx: Context,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = gateDir(ctx, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, GATE_FILE), gateText(name), { mode: 0o644 });
  try {
    await systemctl(ctx, "daemon-reload");
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await systemctl(ctx, "daemon-reload").catch(() => undefined);
  }
}
