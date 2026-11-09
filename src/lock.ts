import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "./context.ts";
import { CliError } from "./errors.ts";

interface Holder {
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
    await rm(path, { force: true });
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
