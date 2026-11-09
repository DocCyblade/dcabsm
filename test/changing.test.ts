import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { Cancelled, CliError } from "../src/errors.ts";
import { logChange } from "../src/log.ts";
import { acquireLock } from "../src/lock.ts";
import { findNoun, findVerb } from "../src/table.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const verb = () => findVerb(findNoun("backup")!, "create")!;
const original = verb().run;
afterEach(() => {
  verb().run = original;
});

describe("changing commands", () => {
  it("lock, run, log ok, and release", async () => {
    h = await harness();
    let heldDuring = false;
    verb().run = async ({ ctx }) => {
      heldDuring = await pathExists(ctx.paths.lock);
    };
    expect(await run(["backup", "create", "--all"], h.ctx)).toBe(0);
    expect(heldDuring).toBe(true);
    expect(h.calls).toEqual([{ command: "logger", args: ["-t", "dcabsm", "backup create: ok"] }]);
    expect(await pathExists(h.ctx.paths.lock)).toBe(false);
  });

  it("logs failed and prints the error", async () => {
    h = await harness();
    verb().run = async () => {
      throw new CliError("disk full", "Free space first");
    };
    expect(await run(["backup", "create", "--all"], h.ctx)).toBe(1);
    expect(h.err).toEqual(["error: disk full", "  Free space first"]);
    expect(h.calls[0]?.args[2]).toBe("backup create: failed");
  });

  it("logs cancelled and prints the plain line", async () => {
    h = await harness();
    verb().run = async () => {
      throw new Cancelled();
    };
    expect(await run(["backup", "create", "--all"], h.ctx)).toBe(1);
    expect(h.out).toEqual(["Cancelled. Nothing changed."]);
    expect(h.calls[0]?.args[2]).toBe("backup create: cancelled");
  });

  it("fails at once, naming the holder, when another command holds the lock", async () => {
    h = await harness();
    verb().run = async () => {};
    const release = await acquireLock(h.ctx, "dcabsm instance upgrade --all");
    expect(await run(["backup", "create", "--all"], h.ctx)).toBe(1);
    expect(h.err[0]).toContain("Another dcabsm command is running");
    await release();
  });

  it("read-only commands take no lock and log nothing", async () => {
    h = await harness();
    const list = findVerb(findNoun("backup")!, "list")!;
    list.run = async () => {};
    const release = await acquireLock(h.ctx, "dcabsm held");
    expect(await run(["backup", "list"], h.ctx)).toBe(0);
    expect(h.calls).toEqual([]);
    await release();
    delete list.run;
  });

  it("host doctor locks only with --fix", () => {
    const doctor = findVerb(findNoun("host")!, "doctor")!;
    const changes = doctor.changes as (a: string[]) => boolean;
    expect(changes([])).toBe(false);
    expect(changes(["--fix"])).toBe(true);
  });
});

describe("logChange", () => {
  it("never fails the command when logger fails", async () => {
    h = await harness({
      runner: () => {
        throw new Error("no logger");
      },
    });
    await expect(logChange(h.ctx, "host set", "ok")).resolves.toBeUndefined();
  });
});

async function pathExists(p: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  return access(p).then(
    () => true,
    () => false,
  );
}
