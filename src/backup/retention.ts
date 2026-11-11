import { rm } from "node:fs/promises";
import type { Context } from "../context.ts";
import { defaultHostConfig, readHostConfig } from "../host/config.ts";
import { listArchives, type ArchiveInfo } from "./archive.ts";

/** The kinds Retention counts (spec 8.3). `manual` and `final` have no count: they are never pruned. */
export const COUNTED_KINDS = ["scheduled", "pre-upgrade", "pre-restore", "pre-clone"] as const;
export type CountedKind = (typeof COUNTED_KINDS)[number];

/** A Retention count for each counted kind. */
type Counts = Record<CountedKind, number>;

/** The Retention count for each counted kind: the stored one, else the default. Never below 1. */
export async function keepCounts(ctx: Context): Promise<Counts> {
  return (await keepReport(ctx)).counts;
}

/** `keepCounts`, plus the kinds whose stored count is unusable and fell back to the default. */
export async function keepReport(
  ctx: Context,
): Promise<{ counts: Counts; invalid: CountedKind[] }> {
  const stored = (await readHostConfig(ctx))?.keep ?? {};
  const defaults = defaultHostConfig("").keep;
  const counts = {} as Counts;
  const invalid: CountedKind[] = [];
  for (const kind of COUNTED_KINDS) {
    const n = stored[kind];
    if (n === undefined) counts[kind] = defaults[kind]!;
    else if (Number.isInteger(n) && n >= 1) counts[kind] = n;
    else {
      counts[kind] = defaults[kind]!;
      invalid.push(kind);
    }
  }
  return { counts, invalid };
}

/** "14 scheduled, 5 pre-upgrade, ..." */
export const describeCounts = (counts: Counts): string =>
  COUNTED_KINDS.map((k) => `${counts[k]} ${k}`).join(", ");

/**
 * The archives Retention would delete for one Instance: per kind, everything older than the
 * newest `keep` (spec 8.3). The newest of a kind always stays, so the newest `pre-upgrade` is
 * safe whatever the setting. Nothing of another kind is ever listed.
 */
export async function planPrune(
  ctx: Context,
  name: string,
  counts: Counts,
): Promise<ArchiveInfo[]> {
  const archives = await listArchives(ctx, name);
  const doomed: ArchiveInfo[] = [];
  for (const kind of COUNTED_KINDS) {
    const newestFirst = archives.filter((a) => a.kind === kind).reverse();
    doomed.push(...newestFirst.slice(Math.max(1, counts[kind])));
  }
  return doomed.sort((a, b) => a.stamp.localeCompare(b.stamp));
}

/** Applies Retention to one Instance and returns what it deleted. The caller holds the lock. */
export async function pruneInstance(ctx: Context, name: string): Promise<ArchiveInfo[]> {
  const doomed = await planPrune(ctx, name, await keepCounts(ctx));
  for (const a of doomed) await rm(a.path, { force: true });
  return doomed;
}
