import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, withLock } from "../src/lock.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const exists = (p: string) =>
  readFile(p).then(
    () => true,
    () => false,
  );

describe("lock", () => {
  it("writes the holder and removes the file on release", async () => {
    h = await harness();
    const release = await acquireLock(h.ctx, "dcabsm backup create --all");
    expect(JSON.parse(await readFile(h.ctx.paths.lock, "utf8"))).toEqual({
      pid: process.pid,
      command: "dcabsm backup create --all",
    });
    await release();
    expect(await exists(h.ctx.paths.lock)).toBe(false);
  });

  it("fails at once, naming the holder, when a live process holds it", async () => {
    h = await harness();
    const release = await acquireLock(h.ctx, "dcabsm instance upgrade --all");
    await expect(acquireLock(h.ctx, "dcabsm backup create --all")).rejects.toMatchObject({
      message: `Another dcabsm command is running (pid ${process.pid}: dcabsm instance upgrade --all).`,
      hint: "Wait for it to finish, then run again: sudo dcabsm backup create --all",
      code: 1,
    });
    await release();
  });

  it("takes over a lock left by a dead process", async () => {
    h = await harness();
    await mkdir(dirname(h.ctx.paths.lock), { recursive: true });
    await writeFile(h.ctx.paths.lock, JSON.stringify({ pid: 2 ** 30, command: "old" }));
    const release = await acquireLock(h.ctx, "dcabsm new");
    expect(JSON.parse(await readFile(h.ctx.paths.lock, "utf8")).command).toBe("dcabsm new");
    await release();
  });

  it("takes over an unreadable lock file", async () => {
    h = await harness();
    await mkdir(dirname(h.ctx.paths.lock), { recursive: true });
    await writeFile(h.ctx.paths.lock, "garbage");
    await (
      await acquireLock(h.ctx, "dcabsm new")
    )();
  });

  it("withLock releases when the work throws", async () => {
    h = await harness();
    await expect(
      withLock(h.ctx, "dcabsm x", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await exists(h.ctx.paths.lock)).toBe(false);
  });

  it("lets exactly one of several racing commands take a stale lock, leaving no stale file", async () => {
    h = await harness();
    await mkdir(dirname(h.ctx.paths.lock), { recursive: true });
    await writeFile(h.ctx.paths.lock, JSON.stringify({ pid: 2 ** 30, command: "old" }));
    const results = await Promise.allSettled(
      [1, 2].map((n) => acquireLock(h.ctx, `dcabsm racer ${n}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const left = (await readdir(dirname(h.ctx.paths.lock))).filter((f) => f.includes("stale"));
    expect(left).toEqual([]);
    expect(JSON.parse(await readFile(h.ctx.paths.lock, "utf8")).command).toMatch(/^dcabsm racer/);
  });
});
