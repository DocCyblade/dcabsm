import { copyFileSync, existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { makeWritable } from "../src/fsutil.ts";
import { gateDir } from "../src/instance/start-gate.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
let net: FakeNet;
let host: FakeHost;
/** Releases whose server never reports its own version, so Verification fails on them. */
let broken: Set<string>;
/** Marker contents seen at each start. */
let markers: Array<{ marker: string | undefined; gate: boolean; release: string }>;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const inst = (...parts: string[]) => join(h.ctx.paths.instances, "shop", ...parts);
const backups = (...parts: string[]) => join(h.ctx.paths.under("/srv/dcabsm/backups"), ...parts);
const rollback = (...args: string[]) => run(["instance", "rollback", ...args], h.ctx);
const err = () => h.err.join("\n");
const out = () => h.out.join("\n");
const linked = async () => basename(await readlink(inst("release")));
const sysctls = () =>
  h.calls
    .filter(
      (c) =>
        c.command === "systemctl" &&
        !["is-active", "show", "daemon-reload", "reset-failed"].includes(c.args[0]!),
    )
    .map((c) => c.args.join(" "));
const fixture = (release: string) =>
  join(import.meta.dirname, "fixtures", `actual-${release}`, "account.sqlite");
const PRE_UPGRADE = (from: string) => `20261109T120000Z-pre-upgrade-${from}.tar.gz`;

const GROUP_SCHEMA = `
CREATE TABLE messages_binary (timestamp TEXT PRIMARY KEY, is_encrypted BOOLEAN, content bytea);
CREATE TABLE messages_merkles (id INTEGER PRIMARY KEY, merkle TEXT);`;

/** A Budget file as Actual's server keeps it: a row in `account.sqlite` and a group file of messages. */
function addBudget(group: string, messages: string[]): void {
  const db = new DatabaseSync(inst("server-files", "account.sqlite"));
  db.prepare("INSERT INTO files (id, group_id, sync_version, name) VALUES (?, ?, 2, 'Budget')").run(
    `file-${group}`,
    group,
  );
  db.close();
  const g = new DatabaseSync(inst("user-files", `group-${group}.sqlite`));
  g.exec(GROUP_SCHEMA);
  for (const m of messages) g.prepare("INSERT INTO messages_binary VALUES (?, 0, ?)").run(m, m);
  g.close();
}

const groupIds = (): string[] => {
  const db = new DatabaseSync(inst("server-files", "account.sqlite"));
  const rows = db.prepare("SELECT group_id FROM files ORDER BY id").all() as Array<{
    group_id: string;
  }>;
  db.close();
  return rows.map((r) => r.group_id);
};

interface Options {
  /** The Release the Instance starts on; it upgrades to `next`. */
  base?: string;
  next?: string;
  stopped?: boolean;
  answers?: string[];
  interactive?: boolean;
  settings?: Record<string, string>;
}

/**
 * A Host with Instance `shop` on `base`, holding one real-schema Budget file and notes "v1". An Upgrade
 * to `next` takes the Pre-upgrade backup, then the data moves on ("v2"). Rolling back starts here.
 */
async function start(opts: Options = {}): Promise<{ base: string; next: string }> {
  const base = opts.base ?? "26.11.0";
  const next = opts.next ?? "26.11.1";
  host = fakeHost();
  net = fakeNet({ serverVersion: base });
  broken = new Set();
  markers = [];
  h = await harness({
    net,
    answers: opts.answers,
    interactive: opts.interactive,
    runner: (command, args) => {
      if (command === "openssl") {
        writeFileSync(args[args.indexOf("-keyout") + 1]!, "KEY");
        writeFileSync(args[args.indexOf("-out") + 1]!, "CERT");
        return ok();
      }
      if (command === "nginx" && args[0] === "-T") return ok("");
      if (command === "systemctl" && args[0] === "is-active") {
        const up = host.active.has(args.at(-1)!);
        return { code: up ? 0 : 3, stdout: up ? "active\n" : "inactive\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "start") onStart();
      return host.run(command, args);
    },
  });
  const p = h.ctx.paths;
  for (const d of [p.releases, p.node, p.instances, p.acme]) await mkdir(d, { recursive: true });
  expect(await run(["release", "install", base], h.ctx)).toBe(0);
  const create = ["instance", "create", "shop", "--hostname", "shop.example.org", "--self-signed"];
  expect(await run([...create, "--release", base, "--yes"], h.ctx)).toBe(0);
  for (const [key, value] of Object.entries(opts.settings ?? {})) {
    expect(await run(["instance", "set", "shop", key, value, "--yes"], h.ctx)).toBe(0);
  }
  await mkdir(p.under("/srv/dcabsm/backups"), { recursive: true, mode: 0o700 });
  await writeFile(inst("data", "notes"), "v1");
  copyFileSync(fixture(base), inst("server-files", "account.sqlite"));
  addBudget("group-one", ["m1", "m2"]);

  expect(await run(["instance", "upgrade", "shop", "--to", next, "--yes"], h.ctx)).toBe(0);
  await writeFile(inst("data", "notes"), "v2");
  await writeFile(inst("data", "newer"), "later");
  if (opts.stopped) host.active.delete("dcabsm@shop");
  h.out.length = 0;
  h.calls.length = 0;
  markers.length = 0;
  return { base, next };
}

/** The server reports the Release the `release` link points to, unless that Release is broken. */
function onStart(): void {
  let version: string;
  try {
    version = basename(readlinkSync(inst("release")));
  } catch {
    return;
  }
  let marker: string | undefined;
  try {
    marker = readFileSync(inst(".changing-release"), "utf8");
  } catch {
    marker = undefined;
  }
  const gate = existsSync(`${gateDir(h.ctx, "shop")}/10-start-gate.conf`);
  markers.push({ marker, gate, release: version });
  net.serverVersion = broken.has(version) ? "0.0.0" : version;
}

const noMarker = async () => {
  await expect(stat(inst(".changing-release"))).rejects.toThrow();
  await expect(stat(gateDir(h.ctx, "shop"))).rejects.toThrow();
};

/** Leaves the Instance as an interruption would: the marker in place, the link and data as given. */
async function interrupt(marker: Record<string, unknown>): Promise<void> {
  await writeFile(inst(".changing-release"), JSON.stringify(marker));
}

describe("instance rollback keeping data", () => {
  it("stops, writes the marker, repoints, regenerates config.json, starts and verifies", async () => {
    await start();
    expect(await rollback("shop", "--yes")).toBe(0);

    expect(await linked()).toBe("26.11.0");
    // The data is the current data.
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
    expect(await readFile(inst("data", "newer"), "utf8")).toBe("later");
    expect(groupIds()).toEqual(["group-one"]);
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    expect(h.calls.filter((c) => c.command === "tar" && c.args[0] === "-czf")).toEqual([]);
    const config = JSON.parse(await readFile(inst("config", "config.json"), "utf8"));
    expect(config.port).toBe(15127);

    // The marker named the change during the start, with the gate open.
    expect(JSON.parse(markers.at(-1)!.marker!)).toEqual({
      operation: "rollback",
      from: "26.11.1",
      to: "26.11.0",
      backup: backups("shop", PRE_UPGRADE("26.11.0")),
      restoringData: false,
    });
    expect(markers.at(-1)!.gate).toBe(true);
    await noMarker();

    expect(out()).toContain("Roll back shop: 26.11.1 → 26.11.0, keeping current data");
    expect(out()).toContain("Started and verified: /health UP, /info 26.11.0");
    expect(out()).toContain("On every device");
    expect(out()).toContain("Click Update now, or reload twice");
    expect(out()).not.toContain("Click Revert");
  });

  it("asks first, and a no changes nothing", async () => {
    await start({ interactive: true, answers: ["n"] });
    expect(await rollback("shop")).toBe(1);
    expect(h.asked).toEqual(["Continue? [y/N] "]);
    expect(out()).toContain("Cancelled. Nothing changed.");
    expect(await linked()).toBe("26.11.1");
    expect(sysctls()).toEqual([]);
  });

  it("returns a stopped Instance to stopped", async () => {
    await start({ stopped: true });
    expect(await rollback("shop", "--yes")).toBe(0);
    expect(await linked()).toBe("26.11.0");
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop", "stop dcabsm@shop"]);
    await noMarker();
  });

  it("returns to the newer Release when the older one will not start, and points to --restore-data", async () => {
    await start();
    broken.add("26.11.0");
    expect(await rollback("shop", "--yes")).toBe(1);

    expect(await linked()).toBe("26.11.1");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
    expect(sysctls()).toEqual([
      "stop dcabsm@shop",
      "start dcabsm@shop",
      "stop dcabsm@shop",
      "start dcabsm@shop",
    ]);
    expect(markers.map((m) => [m.release, m.gate])).toEqual([
      ["26.11.0", true],
      ["26.11.1", true],
    ]);
    await noMarker();
    expect(out()).toContain("26.11.0 would not start on the current data");
    expect(out()).toContain("Returned to 26.11.1");
    expect(err()).toContain("shop is still on 26.11.1, data unchanged.");
    expect(err()).toContain("Pre-upgrade backup from 2026-11-09 12:00 UTC");
    expect(err()).toContain("sudo dcabsm instance rollback shop --restore-data");
  });

  it("stays stopped with the marker when the return fails too, and a later rollback finishes it", async () => {
    await start();
    broken.add("26.11.0");
    broken.add("26.11.1");
    expect(await rollback("shop", "--yes")).toBe(1);
    expect(err()).toContain("and so did the return to 26.11.1");
    expect(sysctls().at(-1)).toBe("stop dcabsm@shop");
    expect((await stat(inst(".changing-release"))).isFile()).toBe(true);
    // The marker now says the way out is the newer Release.
    expect(JSON.parse(await readFile(inst(".changing-release"), "utf8"))).toMatchObject({
      operation: "rollback",
      to: "26.11.1",
      restoringData: false,
    });

    broken.clear();
    expect(await rollback("shop", "--yes")).toBe(0);
    expect(await linked()).toBe("26.11.1");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
    await noMarker();
  });

  it("says there is nothing to roll back when the newest Pre-upgrade backup matches the current Release", async () => {
    await start();
    expect(await rollback("shop", "--yes")).toBe(0);
    h.out.length = 0;
    h.calls.length = 0;
    expect(await rollback("shop", "--yes")).toBe(2);
    expect(err()).toContain("Nothing to roll back");
    expect(err()).toContain("sudo dcabsm instance restore shop");
    expect(sysctls()).toEqual([]);
  });

  it("refuses an Instance with no Pre-upgrade backup, an unknown one and a wrong argument count", async () => {
    await start();
    await rm(backups("shop", PRE_UPGRADE("26.11.0")));
    expect(await rollback("shop", "--yes")).toBe(2);
    expect(err()).toContain("no Pre-upgrade backup");
    expect(await rollback("nope", "--yes")).toBe(2);
    expect(err()).toContain("There is no Instance named nope.");
    expect(await rollback()).toBe(2);
    expect(sysctls()).toEqual([]);
  });

  it("reinstalls a target Release that was removed as unused", async () => {
    await start();
    const dir = join(h.ctx.paths.releases, "26.11.0");
    await makeWritable(dir);
    await rm(dir, { recursive: true });
    expect(await rollback("shop", "--yes")).toBe(0);
    expect(out()).toContain("Installed Release 26.11.0");
    expect(await linked()).toBe("26.11.0");
  });

  it("names a setting the older Release doesn't know as not used, and keeps it in the record", async () => {
    await start({ settings: { "simplefin-allowed-networks": "10.0.0.0/8" } });
    // Pretend the Pre-upgrade backup is from 26.10.0, which doesn't know the setting.
    const older = PRE_UPGRADE("26.10.0");
    await rename(backups("shop", PRE_UPGRADE("26.11.0")), backups("shop", older));
    const archive = JSON.parse(readFileSync(backups("shop", older), "utf8"));
    archive.manifest = archive.manifest.replace("26.11.0", "26.10.0");
    writeFileSync(backups("shop", older), JSON.stringify(archive));

    expect(await rollback("shop", "--yes")).toBe(0);
    expect(await linked()).toBe("26.10.0");
    expect(out()).toContain("simplefin-allowed-networks: not used by 26.10.0");
    const config = JSON.parse(await readFile(inst("config", "config.json"), "utf8"));
    expect(JSON.stringify(config)).not.toContain("10.0.0.0/8");
    const record = JSON.parse(await readFile(inst("config", "instance.json"), "utf8"));
    expect(record.settings["simplefin-allowed-networks"]).toBe("10.0.0.0/8");
  });
});

describe("instance rollback --restore-data", () => {
  it("takes a pre-restore Backup, shows the date, restores, regroups and gives device advice", async () => {
    await start();
    expect(await rollback("shop", "--restore-data", "--confirm", "shop")).toBe(0);

    expect(await linked()).toBe("26.11.0");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
    await expect(stat(inst("data", "newer"))).rejects.toThrow();
    const [group] = groupIds();
    expect(group).not.toBe("group-one");
    expect(await readdir(inst("user-files"))).toEqual([`group-${group}.sqlite`]);

    expect((await readdir(backups("shop"))).sort()).toEqual(
      [PRE_UPGRADE("26.11.0"), "20261109T120000Z-pre-restore-26.11.1.tar.gz"].sort(),
    );
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    expect(JSON.parse(markers.at(-1)!.marker!)).toEqual({
      operation: "rollback",
      from: "26.11.1",
      to: "26.11.0",
      backup: backups("shop", "20261109T120000Z-pre-restore-26.11.1.tar.gz"),
      archive: backups("shop", PRE_UPGRADE("26.11.0")),
      restoringData: true,
    });
    expect(markers.at(-1)!.gate).toBe(true);
    await noMarker();

    expect(out()).toContain("Roll back shop: 26.11.1 → 26.11.0, restoring data");
    expect(out()).toContain(
      "Replaces all data with the Pre-upgrade backup from 2026-11-09 12:00 UTC",
    );
    expect(out()).toContain("Regrouped 1 Budget file");
    expect(out()).toContain("Click Revert");
    expect(out()).toContain("Click Update now, or reload twice");
    const chowns = h.calls.filter((c) => c.command === "chown" && c.args[0] === "-R");
    expect(chowns.at(-1)!.args[1]).toBe("dcabsm-shop:dcabsm-shop");
  });

  it("asks for the name, and a wrong name changes nothing", async () => {
    await start({ interactive: true, answers: ["nope"] });
    expect(await rollback("shop", "--restore-data")).toBe(1);
    expect(h.asked).toEqual(["Type the Instance name shop to confirm: "]);
    expect(out()).toContain("The name did not match. Nothing changed.");
    expect(sysctls()).toEqual([]);
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
  });

  it("refuses without a terminal or --confirm", async () => {
    await start();
    expect(await rollback("shop", "--restore-data")).toBe(2);
    expect(err()).toContain("--confirm shop");
    expect(sysctls()).toEqual([]);
  });

  it("puts the pre-restore Backup back when Verification fails", async () => {
    await start();
    broken.add("26.11.0");
    expect(await rollback("shop", "--restore-data", "--confirm", "shop")).toBe(1);
    expect(await linked()).toBe("26.11.1");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
    expect(groupIds()).toEqual(["group-one"]);
    await noMarker();
    expect(err()).toContain("Rollback of shop failed and was undone");
  });

  it("starts a running Instance again when the pre-restore Backup fails", async () => {
    await start();
    net.tarCreateFails = true;
    expect(await rollback("shop", "--restore-data", "--confirm", "shop")).toBe(1);
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    await expect(stat(inst(".changing-release"))).rejects.toThrow();
    expect(await linked()).toBe("26.11.1");
  });
});

describe("an unfinished Release change", () => {
  const marker = (extra: Record<string, unknown> = {}) => ({
    operation: "upgrade",
    from: "26.11.0",
    to: "26.11.1",
    backup: "",
    restoringData: false,
    ...extra,
  });

  it("makes every changing command refuse and name rollback, and list and show report it", async () => {
    await start();
    await interrupt(marker({ backup: backups("shop", PRE_UPGRADE("26.11.0")) }));
    h.calls.length = 0;
    const commands = [
      ["instance", "start", "shop"],
      ["instance", "restart", "shop"],
      ["instance", "remove", "shop", "--confirm", "shop"],
      ["instance", "set-hostname", "shop", "new.example.org", "--self-signed"],
      ["instance", "reset-password", "shop"],
      ["instance", "set", "shop", "backup-retention", "1", "--yes"],
      ["instance", "unset", "shop", "backup-retention", "--yes"],
      ["instance", "upgrade", "shop", "--yes"],
      ["instance", "restore", "shop", "--confirm", "shop"],
      ["backup", "create", "shop"],
      ["backup", "schedule", "shop", "off"],
      ["backup", "prune", "shop"],
    ];
    for (const argv of commands) {
      h.err.length = 0;
      h.out.length = 0;
      const code = await run(argv, h.ctx);
      const text = `${err()}\n${out()}`;
      expect(text, argv.join(" ")).toContain(
        "shop has an unfinished Release change (upgrade, 26.11.0 → 26.11.1).",
      );
      expect(text, argv.join(" ")).toContain(
        "Only rollback can run now: sudo dcabsm instance rollback shop",
      );
      expect(code, argv.join(" ")).not.toBe(0);
    }
    expect(sysctls()).toEqual([]);
    expect(await linked()).toBe("26.11.1");

    h.out.length = 0;
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
    expect(out()).toMatch(/shop +CHANGING/);
    expect(out()).toContain(
      "shop: unfinished Release change (upgrade, 26.11.0 → 26.11.1). Only rollback can run: sudo dcabsm instance rollback shop",
    );
    h.out.length = 0;
    expect(await run(["instance", "show", "shop"], h.ctx)).toBe(0);
    expect(out()).toContain("shop  CHANGING");
    expect(out()).toContain("unfinished Release change (upgrade, 26.11.0 → 26.11.1)");
  });

  it("leaves a changing Instance's Backups alone when pruning all", async () => {
    await start();
    await interrupt(marker());
    h.out.length = 0;
    expect(await run(["backup", "prune", "--all"], h.ctx)).toBe(0);
    expect(out()).toContain("shop: unfinished Release change, skipped");
  });

  it("after an interrupted Upgrade restores from the Backup and returns to the from Release, with no Regroup", async () => {
    await start();
    await interrupt(
      marker({ backup: backups("shop", PRE_UPGRADE("26.11.0")), restoringData: true }),
    );
    expect(await rollback("shop", "--yes")).toBe(0);

    expect(await linked()).toBe("26.11.0");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
    await expect(stat(inst("data", "newer"))).rejects.toThrow();
    expect(groupIds()).toEqual(["group-one"]);
    expect(markers.at(-1)!.gate).toBe(true);
    await noMarker();
    expect(out()).toContain("Finish the unfinished upgrade of shop (26.11.0 → 26.11.1)");
    expect(out()).toContain("Click Update now, or reload twice");
    expect(out()).not.toContain("Click Revert");
  });

  it("after an interrupted restore repeats the restore, with a Regroup", async () => {
    await start();
    await interrupt(
      marker({
        operation: "restore",
        from: "26.11.1",
        to: "26.11.0",
        backup: backups("shop", "20261109T120000Z-pre-restore-26.11.1.tar.gz"),
        archive: backups("shop", PRE_UPGRADE("26.11.0")),
        restoringData: true,
      }),
    );
    expect(await rollback("shop", "--yes")).toBe(0);
    expect(await linked()).toBe("26.11.0");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
    expect(groupIds()[0]).not.toBe("group-one");
    await noMarker();
    expect(out()).toContain("Finish the unfinished restore of shop");
    expect(out()).toContain("Click Revert");
  });

  it("after an interrupted rollback that kept data returns to the to Release and keeps the data", async () => {
    await start();
    await interrupt(
      marker({
        operation: "rollback",
        from: "26.11.1",
        to: "26.11.0",
        backup: backups("shop", PRE_UPGRADE("26.11.0")),
      }),
    );
    expect(await rollback("shop", "--yes")).toBe(0);
    expect(await linked()).toBe("26.11.0");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
    expect(groupIds()).toEqual(["group-one"]);
    await noMarker();
  });

  it("stays stopped with the marker when finishing fails", async () => {
    await start();
    await interrupt(marker({ backup: backups("shop", PRE_UPGRADE("26.11.0")) }));
    broken.add("26.11.0");
    expect(await rollback("shop", "--yes")).toBe(1);
    expect(err()).toContain("Finishing the upgrade of shop failed");
    expect(sysctls().at(-1)).toBe("stop dcabsm@shop");
    expect((await stat(inst(".changing-release"))).isFile()).toBe(true);
  });

  it("reinstalls the Release it needs if it was removed", async () => {
    await start();
    await interrupt(marker({ backup: backups("shop", PRE_UPGRADE("26.11.0")) }));
    const dir = join(h.ctx.paths.releases, "26.11.0");
    await makeWritable(dir);
    await rm(dir, { recursive: true });
    expect(await rollback("shop", "--yes")).toBe(0);
    expect(out()).toContain("Installed Release 26.11.0");
    expect(await linked()).toBe("26.11.0");
  });
});
