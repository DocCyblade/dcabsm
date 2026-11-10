import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { lockHolder } from "../lock.ts";
import { readHostConfig, writeHostConfig } from "../host/config.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { LAYOUT, VERSION } from "../version.ts";

/** One step of stored-state change, run on the Host with `/etc/dcabsm` already copied aside. */
export type Migration = (ctx: Context) => Promise<void>;

/**
 * `MIGRATIONS[n]` moves layout n-1 to n. Migrations only go forward (spec 11.4). A DCABSM that raises
 * `LAYOUT` adds its step here in the same change.
 */
export const MIGRATIONS: Record<number, Migration> = {};

/** Runs the steps from `from` up to `to`, then stores the new layout. */
export async function migrateLayout(
  ctx: Context,
  from: number,
  to: number = LAYOUT,
  registry: Record<number, Migration> = MIGRATIONS,
): Promise<void> {
  for (let n = from + 1; n <= to; n++) {
    const migration = registry[n];
    if (!migration) throw new CliError(`DCABSM ${VERSION} has no migration to layout ${n}.`);
    await migration(ctx);
  }
  const config = (await readHostConfig(ctx)) ?? {};
  await writeHostConfig(ctx, { ...config, layout: to, layoutSince: VERSION });
}

/** Self-update runs its hidden steps under its lock; run alone they would race another command. */
export async function requireUpdateLock(ctx: Context, verb: string): Promise<void> {
  if (!(await lockHolder(ctx))) {
    throw refusal(`self ${verb} is a step of self update.`, "Run: sudo dcabsm self update");
  }
}

/** Hidden `self migrate`: Self-update runs it with the new version's own code, under its lock. */
export async function selfMigrate({ ctx }: Invocation): Promise<void> {
  await requireUpdateLock(ctx, "migrate");
  const stored = (await readHostConfig(ctx))?.layout;
  if (typeof stored !== "number" || stored === LAYOUT) return;
  if (stored > LAYOUT) {
    throw refusal(`This Host is on layout ${stored}; DCABSM ${VERSION} expects ${LAYOUT}.`);
  }
  await migrateLayout(ctx, stored);
  step(ctx, "done", `Migrated layout ${stored} → ${LAYOUT}`);
}
