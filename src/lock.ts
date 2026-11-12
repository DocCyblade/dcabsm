import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "./context.ts";
import { CliError } from "./errors.ts";

export interface Holder {
  pid: number;
  command: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readHolder(path: string): Promise<Holder | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const h = parsed as Partial<Holder>;
    if (typeof h.pid === "number" && typeof h.command === "string") {
      return { pid: h.pid, command: h.command };
    }
  } catch {
    // Missing or unreadable: no live holder.
  }
  return undefined;
}

/** The live command holding the lock, if any. Read-only: a stale lock is left for the next changing command. */
export async function lockHolder(ctx: Context): Promise<Holder | undefined> {
  const holder = await readHolder(ctx.paths.lock);
  return holder && alive(holder.pid) ? holder : undefined;
}

/**
 * Takes the Host-wide lock (spec 2). If another command holds it, this fails
 * at once, naming the holder. A lock left by a dead process is taken over.
 * Returns the release function.
 */
export async function acquireLock(ctx: Context, command: string): Promise<() => Promise<void>> {
  const path = ctx.paths.lock;
  await mkdir(dirname(path), { recursive: true });
  const mine: Holder = { pid: process.pid, command };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify(mine), { flag: "wx" });
      return () => rm(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = await readHolder(path);
    if (holder && alive(holder.pid)) {
      throw new CliError(
        `Another dcabsm command is running (pid ${holder.pid}: ${holder.command}).`,
        `Wait for it to finish, then run again: sudo ${command}`,
      );
    }
    // Take over by renaming the stale lock aside: of several commands that saw it stale, one rename wins.
    const aside = `${path}.stale-${process.pid}-${attempt}-${Math.random().toString(36).slice(2)}`;
    try {
      await rename(path, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const moved = await readHolder(aside);
    if (moved && alive(moved.pid)) {
      // Another command had already taken over, and we moved its live lock. Put it back.
      await link(aside, path).catch(() => undefined);
      await rm(aside, { force: true });
      throw new CliError(
        `Another dcabsm command is running (pid ${moved.pid}: ${moved.command}).`,
        `Wait for it to finish, then run again: sudo ${command}`,
      );
    }
    await rm(aside, { force: true });
  }
  throw new CliError("Could not take the dcabsm lock.", `Try again: sudo ${command}`);
}

export async function withLock<T>(ctx: Context, command: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(ctx, command);
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** How long the Nightly run waits for the lock before skipping an Instance (spec 8.2). */
export const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_POLL_MS = 5000;

/**
 * Like `acquireLock`, but waits for a live holder to finish, up to `waitMs`, then fails with the
 * last holder's error. Only the Nightly run waits (spec 8.2).
 */
export async function acquireLockWaiting(
  ctx: Context,
  command: string,
  waitMs = LOCK_WAIT_MS,
): Promise<() => Promise<void>> {
  const deadline = ctx.now().getTime() + waitMs;
  for (;;) {
    try {
      return await acquireLock(ctx, command);
    } catch (err) {
      if (!(err instanceof CliError) || ctx.now().getTime() >= deadline) throw err;
    }
    await ctx.sleep(LOCK_POLL_MS);
  }
}
