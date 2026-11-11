import { writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { acquireLock } from "../src/lock.ts";
import { fakeHost } from "./fakehost.ts";
import { fakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
/** Instances `systemctl is-active` calls stopped. */
let stopped: Set<string>;
/** Units whose `systemctl stop` fails, so their Backup fails. */
let failsToStop: Set<string>;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** A Host with the named Instances created, each given data unless listed in `empty`. */
async function start(names: string[], empty: string[] = []): Promise<void> {
  const host = fakeHost();
  stopped = new Set();
  failsToStop = new Set();
  h = await harness({
    net: fakeNet({ serverVersion: "26.11.1" }),
    runner: (command, args) => {
      if (command === "openssl") {
        writeFileSync(args[args.indexOf("-keyout") + 1]!, "KEY");
        writeFileSync(args[args.indexOf("-out") + 1]!, "CERT");
        return ok();
      }
      if (command === "nginx" && args[0] === "-T") return ok("");
      if (command === "systemctl" && args[0] === "is-active") {
        const unit = args.at(-1)!.replace(/^dcabsm@/, "");
        return stopped.has(unit) ? { code: 3, stdout: "inactive\n", stderr: "" } : ok("active\n");
      }
      if (command === "systemctl" && args[0] === "stop" && failsToStop.has(args.at(-1)!)) {
        return { code: 1, stdout: "", stderr: "Failed to stop: disk on fire\n" };
      }
      return host.run(command, args);
    },
  });
  const p = h.ctx.paths;
  for (const d of [p.releases, p.node, p.instances, p.acme]) await mkdir(d, { recursive: true });
  expect(await run(["release", "install", "26.11.1"], h.ctx)).toBe(0);
  for (const name of names) {
    const args = ["instance", "create", name, "--hostname", `${name}.example.org`, "--self-signed"];
    expect(await run(args, h.ctx)).toBe(0);
    if (!empty.includes(name)) {
      await writeFile(join(p.instances, name, "data", "account.sqlite"), `budget of ${name}`);
    }
  }
  await mkdir(p.under("/srv/dcabsm/backups"), { recursive: true, mode: 0o700 });
  h.out.length = 0;
  h.calls.length = 0;
}

const nightly = () => run(["host", "nightly"], h.ctx);
const backups = (...parts: string[]) => join(h.ctx.paths.under("/srv/dcabsm/backups"), ...parts);
const archives = async (name: string) =>
  (await readdir(backups(name)).catch(() => [] as string[])).filter((f) => !f.startsWith("."));
const recordOf = (name: string) => join(h.ctx.paths.instances, name, "config", "instance.json");
const journal = () => h.calls.filter((c) => c.command === "logger").map((c) => c.args[2] as string);
const stops = () =>
  h.calls
    .filter((c) => c.command === "systemctl" && ["stop", "start"].includes(c.args[0]!))
    .map((c) => `${c.args[0]} ${c.args.at(-1)}`);

describe("host nightly", () => {
  it("backs up each Instance in alphabetical order, one after another", async () => {
    await start(["zeta", "alpha"]);
    expect(await nightly()).toBe(0);
    expect(await archives("alpha")).toEqual([
      expect.stringMatching(/-scheduled-26\.11\.1\.tar\.gz$/),
    ]);
    expect(await archives("zeta")).toHaveLength(1);
    expect(stops()).toEqual([
      "stop dcabsm@alpha",
      "start dcabsm@alpha",
      "stop dcabsm@zeta",
      "start dcabsm@zeta",
    ]);
    expect(journal()).toEqual(["host nightly: ok"]);
  });

  it("backs up a stopped Instance without starting it", async () => {
    await start(["shop"]);
    stopped.add("shop");
    expect(await nightly()).toBe(0);
    expect(await archives("shop")).toHaveLength(1);
    expect(stops()).toEqual([]);
  });

  it("skips an Instance that never started, and that is not a failure", async () => {
    await start(["fresh", "shop"], ["fresh"]);
    expect(await nightly()).toBe(0);
    expect(await archives("fresh")).toEqual([]);
    expect(await archives("shop")).toHaveLength(1);
    expect(h.out.join("\n")).toMatch(/fresh\s+skipped/);
  });

  it("skips an Instance with a .changing-release marker as failed, and keeps its Backups", async () => {
    await start(["alpha", "beta"]);
    await writeFile(join(h.ctx.paths.instances, "alpha", ".changing-release"), "{}");
    await mkdir(backups("alpha"), { recursive: true });
    for (let i = 1; i <= 15; i++) {
      await writeFile(
        backups("alpha", `202610${String(i).padStart(2, "0")}T033000Z-scheduled-26.11.1.tar.gz`),
        "x",
      );
    }
    expect(await nightly()).toBe(1);
    expect(await archives("alpha")).toHaveLength(15);
    expect(await archives("beta")).toHaveLength(1);
    expect(h.out.join("\n")).toMatch(/alpha\s+failed/);
    expect(journal()).toEqual(["host nightly: failed"]);
  });

  it("carries on past a failed Backup, holds back its pruning, and exits non-zero", async () => {
    await start(["alpha", "beta"]);
    failsToStop.add("dcabsm@alpha");
    await mkdir(backups("alpha"), { recursive: true });
    for (let i = 1; i <= 15; i++) {
      await writeFile(
        backups("alpha", `202610${String(i).padStart(2, "0")}T033000Z-scheduled-26.11.1.tar.gz`),
        "x",
      );
    }
    expect(await nightly()).toBe(1);
    expect(await archives("alpha")).toHaveLength(15);
    expect(await archives("beta")).toHaveLength(1);
    const text = h.out.join("\n");
    expect(text).toMatch(/alpha\s+failed/);
    expect(text).toMatch(/beta\s+ok/);
    expect(text).toContain("1 backed up");
    expect(text).toContain("1 failed");
  });

  it("says the Backup was fine when only the pruning after it failed", async () => {
    await start(["shop"]);
    // A directory can't be removed as an archive, so pruning the oldest fails.
    for (let i = 1; i <= 15; i++) {
      await mkdir(
        backups("shop", `202610${String(i).padStart(2, "0")}T033000Z-scheduled-26.11.1.tar.gz`),
        { recursive: true },
      );
    }
    expect(await nightly()).toBe(1);
    expect(h.out.join("\n")).toMatch(/shop\s+failed\s+Backup ok, prune failed: /);
  });

  it("applies Retention after a successful Backup", async () => {
    await start(["shop"]);
    await mkdir(backups("shop"), { recursive: true });
    for (let i = 1; i <= 15; i++) {
      await writeFile(
        backups("shop", `202610${String(i).padStart(2, "0")}T033000Z-scheduled-26.11.1.tar.gz`),
        "x",
      );
    }
    await writeFile(backups("shop", "20260901T033000Z-manual-26.11.1.tar.gz"), "x");
    expect(await nightly()).toBe(0);
    const left = await archives("shop");
    // 14 scheduled kept (the new one plus 13 old), the manual one untouched.
    expect(left.filter((f) => f.includes("-scheduled-"))).toHaveLength(14);
    expect(left).not.toContain("20261001T033000Z-scheduled-26.11.1.tar.gz");
    expect(left).not.toContain("20261002T033000Z-scheduled-26.11.1.tar.gz");
    expect(left).toContain("20260901T033000Z-manual-26.11.1.tar.gz");
  });

  it("takes no Backup of an Instance with scheduled Backups off, but still prunes it", async () => {
    await start(["shop"]);
    const parsed = JSON.parse(await readFile(recordOf("shop"), "utf8")) as Record<string, unknown>;
    await writeFile(recordOf("shop"), JSON.stringify({ ...parsed, scheduledBackups: false }));
    await mkdir(backups("shop"), { recursive: true });
    for (let i = 1; i <= 16; i++) {
      await writeFile(
        backups("shop", `202610${String(i).padStart(2, "0")}T033000Z-scheduled-26.11.1.tar.gz`),
        "x",
      );
    }
    expect(await nightly()).toBe(0);
    const left = await archives("shop");
    expect(left).toHaveLength(14);
    expect(left.every((f) => f < "20261101")).toBe(true);
    expect(stops()).toEqual([]);
  });

  it("holds the lock only per Instance", async () => {
    await start(["alpha", "beta"]);
    expect(await nightly()).toBe(0);
    // Taken and released twice: free again at the end, and between the Instances.
    await (
      await acquireLock(h.ctx, "dcabsm check")
    )();
  });

  it("waits for the lock, then backs up once it is free", async () => {
    await start(["shop"]);
    const release = await acquireLock(h.ctx, "dcabsm instance upgrade --all");
    const sleeps: number[] = [];
    const sleep = h.ctx.sleep;
    h.ctx.sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) await release();
      await sleep(ms);
    };
    expect(await nightly()).toBe(0);
    expect(sleeps).toHaveLength(3);
    expect(await archives("shop")).toHaveLength(1);
  });

  it("skips an Instance as failed after waiting 10 minutes for the lock", async () => {
    await start(["shop"]);
    const release = await acquireLock(h.ctx, "dcabsm instance upgrade --all");
    const before = h.ctx.now().getTime();
    expect(await nightly()).toBe(1);
    const waited = h.ctx.now().getTime() - before;
    expect(waited).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(waited).toBeLessThan(11 * 60 * 1000);
    expect(await archives("shop")).toEqual([]);
    expect(h.out.join("\n")).toMatch(/shop\s+failed/);
    await release();
  });

  it("ends with a summary of every Instance", async () => {
    await start(["alpha", "fresh"], ["fresh"]);
    expect(await nightly()).toBe(0);
    expect(h.out).toContain("Summary");
    expect(h.out.join("\n")).toContain(
      "1 backed up, 1 skipped (no data or schedule off), 0 failed",
    );
  });

  it("is hidden from help and needs no Instances", async () => {
    await start([]);
    expect(await nightly()).toBe(0);
  });
});

describe("backup schedule", () => {
  it("switches scheduledBackups off and on in the Instance record", async () => {
    await start(["shop"]);
    expect(await run(["backup", "schedule", "shop", "off"], h.ctx)).toBe(0);
    expect(
      (JSON.parse(await readFile(recordOf("shop"), "utf8")) as { scheduledBackups: boolean })
        .scheduledBackups,
    ).toBe(false);
    expect(h.out.at(-1)).toBe(
      "  ✓ Scheduled backups off for shop. Retention still prunes its old backups.",
    );
    expect(await run(["backup", "schedule", "shop", "on"], h.ctx)).toBe(0);
    expect(
      (JSON.parse(await readFile(recordOf("shop"), "utf8")) as { scheduledBackups: boolean })
        .scheduledBackups,
    ).toBe(true);
    expect(h.out.at(-1)).toBe("  ✓ Scheduled backups on for shop.");
    expect(journal()).toEqual(["backup schedule: ok", "backup schedule: ok"]);
  });

  it("keeps the rest of the record", async () => {
    await start(["shop"]);
    const before = JSON.parse(await readFile(recordOf("shop"), "utf8")) as Record<string, unknown>;
    await run(["backup", "schedule", "shop", "off"], h.ctx);
    const after = JSON.parse(await readFile(recordOf("shop"), "utf8")) as Record<string, unknown>;
    expect(after).toEqual({ ...before, scheduledBackups: false });
  });

  it("refuses a bad state, a missing name and an unknown Instance", async () => {
    await start(["shop"]);
    expect(await run(["backup", "schedule", "shop", "maybe"], h.ctx)).toBe(2);
    expect(await run(["backup", "schedule", "shop"], h.ctx)).toBe(2);
    expect(await run(["backup", "schedule", "nope", "on"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("Usage: dcabsm backup schedule <name> on|off");
  });
});
