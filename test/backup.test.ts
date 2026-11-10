import { writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest } from "../src/backup/archive.ts";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { VERSION } from "../src/version.ts";
import { fakeHost } from "./fakehost.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
let net: FakeNet;
/** Instances `systemctl is-active` calls stopped. */
let stopped: Set<string>;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const DAY = "20261109T120000Z";
const FILE = `${DAY}-manual-26.11.1.tar.gz`;

/** A Host with the named Instances created, each given data unless listed in `empty`. */
async function start(names: string[], empty: string[] = []): Promise<void> {
  const host = fakeHost();
  net = fakeNet({ serverVersion: "26.11.1" });
  stopped = new Set();
  h = await harness({
    net,
    runner: (command, args) => {
      if (command === "openssl") {
        writeFileSync(args[args.indexOf("-keyout") + 1]!, "KEY");
        writeFileSync(args[args.indexOf("-out") + 1]!, "CERT");
        return ok();
      }
      if (command === "nginx" && args[0] === "-T") return ok("");
      if (command === "systemctl" && args[0] === "is-active") {
        const unit = args.at(-1)!.replace(/^dcabsm@/, "");
        return stopped.has(unit)
          ? { code: 3, stdout: "inactive\n", stderr: "" }
          : { code: 0, stdout: "active\n", stderr: "" };
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

const backup = (...args: string[]) => run(["backup", ...args], h.ctx);
const backups = (...parts: string[]) => join(h.ctx.paths.under("/srv/dcabsm/backups"), ...parts);
const systemctls = () =>
  h.calls.filter((c) => c.command === "systemctl" && c.args[0] !== "is-active").map((c) => c.args);
const tarMembers = async (path: string) =>
  (JSON.parse(await readFile(path, "utf8")) as { members: string[] }).members;

describe("backup create", () => {
  it("stops a running Instance, archives it and starts it again", async () => {
    await start(["shop"]);
    expect(await backup("create", "shop")).toBe(0);

    const archive = backups("shop", FILE);
    expect((await stat(archive)).mode & 0o777).toBe(0o600);
    expect((await stat(backups("shop"))).mode & 0o777).toBe(0o700);
    expect((await stat(backups())).mode & 0o777).toBe(0o700);

    // manifest.json first, and the release symlink is left out.
    expect(await tarMembers(archive)).toEqual([
      "manifest.json",
      "config",
      "data",
      "nginx",
      "server-files",
      "user-files",
    ]);
    expect(await readManifest(h.ctx, archive)).toEqual({
      format: 1,
      name: "shop",
      kind: "manual",
      time: "2026-11-09T12:00:00Z",
      release: "26.11.1",
      node: expect.any(String),
      dcabsm: VERSION,
      hostname: "shop.example.org",
    });

    const order = h.calls
      .filter(
        (c) =>
          (c.command === "tar" && c.args[0] !== "-xzOf") ||
          (c.command === "systemctl" && c.args[0] !== "is-active"),
      )
      .map((c) => `${c.command} ${c.args[0]}`);
    expect(order).toEqual(["systemctl stop", "tar -czf", "tar -tzf", "systemctl start"]);
    expect(await readdir(backups("shop"))).toEqual([FILE]);
    expect(h.out).toContain(
      "  · Each running Instance stops for a few seconds while it is archived, one at a time.",
    );
    expect(h.out).toContain(`shop      ok      ${FILE}`);
  });

  it("archives a stopped Instance without starting it", async () => {
    await start(["shop"]);
    stopped.add("shop");
    expect(await backup("create", "shop")).toBe(0);
    expect(systemctls()).toEqual([]);
    expect(await readdir(backups("shop"))).toEqual([FILE]);
  });

  it("reports an Instance that has never started and makes no archive", async () => {
    await start(["shop"], ["shop"]);
    expect(await backup("create", "shop")).toBe(0);
    expect(h.out.join("\n")).toContain("shop has no data yet");
    expect(h.out).toContain("shop      no data  -");
    expect(await readdir(backups())).toEqual([]);
    expect(systemctls()).toEqual([]);
  });

  it("fails before stopping when there is not enough space", async () => {
    await start(["shop"]);
    await writeFile(join(h.ctx.paths.instances, "shop", "data", "big"), "x".repeat(300_000));
    expect(await backup("create", "shop")).toBe(1);
    expect(systemctls()).toEqual([]);
    expect(h.out.join("\n")).toMatch(
      /✗ Not enough space in \/srv\/dcabsm\/backups for a backup of shop \(needs ~[\d.]+ KB, 99\.0 KB free\)\. shop was not stopped\./,
    );
    expect(await readdir(backups("shop"))).toEqual([]);
  });

  it("goes one at a time, carries on past a failure and summarises", async () => {
    await start(["alpha", "beta"]);
    let tars = 0;
    const inner = h.ctx.runner;
    h.ctx.runner = {
      run: (c, a) => {
        if (c === "tar" && a[0] === "-czf") net.tarCreateFails = ++tars === 1;
        return inner.run(c, a);
      },
    };
    expect(await backup("create", "alpha", "beta")).toBe(1);

    // alpha failed but was started again, and left nothing behind; beta was backed up.
    expect(systemctls()).toEqual([
      ["stop", "dcabsm@alpha"],
      ["start", "dcabsm@alpha"],
      ["stop", "dcabsm@beta"],
      ["start", "dcabsm@beta"],
    ]);
    expect(await readdir(backups("alpha"))).toEqual([]);
    expect(await readdir(backups("beta"))).toEqual([FILE]);
    expect(h.out).toContain("Summary");
    expect(h.out).toContain("alpha     failed  -");
    expect(h.out).toContain(`beta      ok      ${FILE}`);
    expect(h.out.join("\n")).toContain("tar failed: tar: No space left on device");
  });

  it("removes the temporary file when the finished archive fails its check", async () => {
    await start(["shop"]);
    const inner = h.ctx.runner;
    h.ctx.runner = {
      run: (c, a) =>
        c === "tar" && a[0] === "-tzf"
          ? Promise.resolve({ code: 2, stdout: "", stderr: "tar: unexpected end of file" })
          : inner.run(c, a),
    };
    expect(await backup("create", "shop")).toBe(1);
    expect(await readdir(backups("shop"))).toEqual([]);
    expect(systemctls().at(-1)).toEqual(["start", "dcabsm@shop"]);
    expect(h.out.join("\n")).toContain(
      "The new archive failed its check: tar: unexpected end of file",
    );
  });

  it("--all backs up every Instance", async () => {
    await start(["alpha", "beta"]);
    expect(await backup("create", "--all")).toBe(0);
    expect(await readdir(backups("alpha"))).toHaveLength(1);
    expect(await readdir(backups("beta"))).toHaveLength(1);
  });

  it("refuses an unknown Instance before touching anything", async () => {
    await start(["shop"]);
    expect(await backup("create", "shop", "nope")).toBe(2);
    expect(h.err.join("\n")).toContain("There is no Instance named nope.");
    expect(systemctls()).toEqual([]);
  });

  it("takes the lock", async () => {
    await start(["shop"]);
    await mkdir(join(h.ctx.paths.lock, ".."), { recursive: true });
    await writeFile(h.ctx.paths.lock, JSON.stringify({ pid: process.pid, command: "other" }));
    expect(await backup("create", "shop")).toBe(1);
    expect(h.err.join("\n")).toContain("Another dcabsm command is running");
    expect(systemctls()).toEqual([]);
  });
});

describe("archive reader", () => {
  const fake = (format: number) =>
    JSON.stringify({
      members: ["manifest.json"],
      manifest: JSON.stringify({ format, name: "shop" }),
    });

  it("refuses a newer format and points to self update", async () => {
    await start(["shop"]);
    const path = join(h.root, "future.tar.gz");
    await writeFile(path, fake(2));
    await expect(readManifest(h.ctx, path)).rejects.toMatchObject({
      message: expect.stringContaining("newer than this DCABSM reads"),
      hint: expect.stringContaining("sudo dcabsm self update"),
      code: 2,
    });
  });

  it("reads an older format", async () => {
    await start(["shop"]);
    const path = join(h.root, "old.tar.gz");
    await writeFile(path, fake(0));
    expect((await readManifest(h.ctx, path)).name).toBe("shop");
  });
});

describe("backup list", () => {
  it("lists archives by Instance, with a note for removed Instances", async () => {
    await start(["shop", "two"]);
    await mkdir(backups("shop"), { recursive: true });
    for (const f of [
      "20261020T101500Z-pre-upgrade-26.10.0.tar.gz",
      "20261107T033000Z-scheduled-26.11.0.tar.gz",
      ".20261109T000000Z-manual-26.11.0.tar.gz",
    ]) {
      await writeFile(backups("shop", f), "x".repeat(2048));
    }
    const removed = backups("old.removed-20261107T141500Z");
    await mkdir(removed, { recursive: true });
    await writeFile(join(removed, "20261107T141500Z-final-26.11.0.tar.gz"), "x");

    expect(await backup("list")).toBe(0);
    expect(h.out).toEqual([
      "shop",
      "ARCHIVE                                      KIND         RELEASE  SIZE",
      "20261020T101500Z-pre-upgrade-26.10.0.tar.gz  pre-upgrade  26.10.0  2.0 KB",
      "20261107T033000Z-scheduled-26.11.0.tar.gz    scheduled    26.11.0  2.0 KB",
      "two",
      "  No archives yet. Take one: sudo dcabsm backup create two",
      "old.removed-20261107T141500Z/  1 archive, kept until you delete them",
    ]);

    h.out.length = 0;
    expect(await backup("list", "two")).toBe(0);
    expect(h.out).toEqual(["two", "  No archives yet. Take one: sudo dcabsm backup create two"]);
  });

  it("refuses an unknown Instance", async () => {
    await start(["shop"]);
    expect(await backup("list", "nope")).toBe(2);
  });
});

describe("instance list", () => {
  it("shows the last scheduled Backup, or off", async () => {
    await start(["shop", "two"]);
    await mkdir(backups("shop"), { recursive: true });
    await writeFile(backups("shop", "20261107T033000Z-scheduled-26.11.1.tar.gz"), "x");
    const record = join(h.ctx.paths.instances, "two", "config", "instance.json");
    const parsed = JSON.parse(await readFile(record, "utf8")) as Record<string, unknown>;
    await writeFile(record, JSON.stringify({ ...parsed, scheduledBackups: false }));
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
    expect(h.out[0]).toMatch(/LAST SCHEDULED$/);
    expect(h.out[1]).toMatch(/shop .* 11-07 03:30 UTC$/);
    expect(h.out[2]).toMatch(/two .* off$/);
  });
});
