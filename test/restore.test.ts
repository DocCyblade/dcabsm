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
let markers: Array<{ unit: string; marker: string | undefined; gate: boolean }>;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const inst = (...parts: string[]) => join(h.ctx.paths.instances, "shop", ...parts);
const backups = (...parts: string[]) => join(h.ctx.paths.under("/srv/dcabsm/backups"), ...parts);
const restore = (...args: string[]) => run(["instance", "restore", ...args], h.ctx);
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

const messagesIn = (group: string): string[] => {
  const g = new DatabaseSync(inst("user-files", `group-${group}.sqlite`));
  const rows = g
    .prepare("SELECT timestamp FROM messages_binary ORDER BY timestamp")
    .all() as Array<{
    timestamp: string;
  }>;
  g.close();
  return rows.map((r) => r.timestamp);
};

interface Options {
  stopped?: boolean;
  answers?: string[];
  interactive?: boolean;
  settings?: Record<string, string>;
}

/**
 * A Host with Release 26.11.0 and Instance `shop` on it, with one real-schema Budget file in its data,
 * and a `manual` Backup of that state named as if taken a week ago. Then the data moves on.
 */
async function start(opts: Options = {}): Promise<string> {
  host = fakeHost();
  net = fakeNet({ serverVersion: "26.11.0" });
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
      if (command === "systemctl" && args[0] === "start") onStart(args.at(-1)!);
      return host.run(command, args);
    },
  });
  const p = h.ctx.paths;
  for (const d of [p.releases, p.node, p.instances, p.acme]) await mkdir(d, { recursive: true });
  expect(await run(["release", "install", "26.11.0"], h.ctx)).toBe(0);
  const create = ["instance", "create", "shop", "--hostname", "shop.example.org", "--self-signed"];
  expect(await run([...create, "--release", "26.11.0", "--yes"], h.ctx)).toBe(0);
  for (const [key, value] of Object.entries(opts.settings ?? {})) {
    expect(await run(["instance", "set", "shop", key, value, "--yes"], h.ctx)).toBe(0);
  }
  await mkdir(p.under("/srv/dcabsm/backups"), { recursive: true, mode: 0o700 });

  await writeFile(inst("data", "notes"), "v1");
  copyFileSync(fixture("26.11.0"), inst("server-files", "account.sqlite"));
  addBudget("group-one", ["m1", "m2"]);
  expect(await run(["backup", "create", "shop"], h.ctx)).toBe(0);
  const taken = (await readdir(backups("shop")))[0]!;
  const old = "20261102T030000Z-manual-26.11.0.tar.gz";
  await rename(backups("shop", taken), backups("shop", old));

  // The data moves on: more messages, a new file, another note.
  await writeFile(inst("data", "notes"), "v2");
  await writeFile(inst("data", "newer"), "later");
  const g = new DatabaseSync(inst("user-files", "group-group-one.sqlite"));
  g.prepare("INSERT INTO messages_binary VALUES ('m3', 0, 'm3')").run();
  g.close();
  if (opts.stopped) host.active.delete("dcabsm@shop");
  h.out.length = 0;
  h.calls.length = 0;
  return old;
}

/** The server reports the Release the `release` link points to, unless that Release is broken. */
function onStart(unit: string): void {
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
  markers.push({ unit, marker, gate });
  net.serverVersion = broken.has(version) ? "0.0.0" : version;
}

describe("instance restore", () => {
  it("restores the newest archive, takes a pre-restore Backup, regroups and verifies", async () => {
    const old = await start();
    expect(await restore("shop", "--confirm", "shop")).toBe(0);

    // Data is the Backup's, and the later changes are gone.
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
    await expect(stat(inst("data", "newer"))).rejects.toThrow();
    expect(await linked()).toBe("26.11.0");

    // Regrouped: a new group id, the group file renamed, the messages of the Backup kept.
    const [group] = groupIds();
    expect(group).not.toBe("group-one");
    expect(await readdir(inst("user-files"))).toEqual([`group-${group}.sqlite`]);
    expect(messagesIn(group!)).toEqual(["m1", "m2"]);

    // A pre-restore Backup holds the state before: it is the only way back.
    const files = await readdir(backups("shop"));
    expect(files.sort()).toEqual([old, "20261109T120000Z-pre-restore-26.11.0.tar.gz"].sort());
    const taken = h.calls.filter((c) => c.command === "tar" && c.args[0] === "-czf");
    expect(taken).toHaveLength(1);

    // The marker was there for the start, with the gate open, and is gone.
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    const seen = JSON.parse(markers.at(-1)!.marker!);
    expect(seen).toEqual({
      operation: "restore",
      from: "26.11.0",
      to: "26.11.0",
      backup: backups("shop", "20261109T120000Z-pre-restore-26.11.0.tar.gz"),
      archive: backups("shop", old),
      restoringData: true,
    });
    expect(markers.at(-1)!.gate).toBe(true);
    await expect(stat(inst(".changing-release"))).rejects.toThrow();
    await expect(stat(gateDir(h.ctx, "shop"))).rejects.toThrow();

    // Ownership is set from the account name after Regroup touched the files.
    const chowns = h.calls.filter((c) => c.command === "chown" && c.args[0] === "-R");
    expect(chowns.at(-1)!.args).toEqual([
      "-R",
      "dcabsm-shop:dcabsm-shop",
      inst("data"),
      inst("server-files"),
      inst("user-files"),
    ]);

    expect(out()).toContain(`Restore shop from ${old}`);
    expect(out()).toContain("Backup taken 2026-11-09 12:00 UTC on Release 26.11.0");
    expect(out()).toContain(
      "Keeps hostname shop.example.org, port 15127 and the current certificate.",
    );
    expect(out()).toContain("Backup pre-restore: 20261109T120000Z-pre-restore-26.11.0.tar.gz");
    expect(out()).toContain("Regrouped 1 Budget file");
    expect(out()).toContain("Started and verified: /health UP, /info 26.11.0");
    expect(out()).toContain("On every device");
    expect(out()).toContain("Click Revert");
    expect(out()).toContain('Never click "upload this file to be the latest version"');
    expect(out()).toContain("Here be dragons");
    expect(out()).not.toContain("instance upgrade");
  });

  it("an archive path picks any archive", async () => {
    const old = await start();
    await rename(backups("shop", old), join(h.root, "elsewhere.tar.gz"));
    const path = join(h.root, "elsewhere.tar.gz");
    // A path outside the backup directory has no parsable name, so its Release comes from the manifest.
    expect(await restore("shop", path, "--confirm", "shop")).toBe(0);
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
    expect(out()).toContain("Restore shop from elsewhere.tar.gz");
  });

  it("starts a running Instance again when the pre-restore Backup fails", async () => {
    await start();
    net.tarCreateFails = true;
    expect(await restore("shop", "--confirm", "shop")).toBe(1);
    expect(err()).toContain("tar");
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    expect(host.active.has("dcabsm@shop")).toBe(true);
    // Nothing was touched: no marker, the data is as it was.
    await expect(stat(inst(".changing-release"))).rejects.toThrow();
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
  });

  it("leaves a stopped Instance stopped when the pre-restore Backup fails", async () => {
    await start({ stopped: true });
    net.tarCreateFails = true;
    expect(await restore("shop", "--confirm", "shop")).toBe(1);
    expect(sysctls()).toEqual(["stop dcabsm@shop"]);
  });

  it("refuses a path where the name belongs and points to --from", async () => {
    const old = await start();
    expect(await restore(backups("shop", old))).toBe(2);
    expect(err()).toContain("instance restore --from");
    expect(err()).toContain("(coming in a later release)");
    expect(await restore("shop.tar.gz")).toBe(2);
    expect(sysctls()).toEqual([]);
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
  });

  it("refuses an unknown Instance, a missing archive and an unfinished change", async () => {
    await start();
    expect(await restore("nosuch", "--confirm", "nosuch")).toBe(2);
    expect(err()).toContain("There is no Instance named nosuch");
    h.err.length = 0;
    expect(await restore("shop", join(h.root, "nope.tar.gz"), "--confirm", "shop")).toBe(2);
    expect(err()).toContain("nope.tar.gz");
    h.err.length = 0;
    await writeFile(inst(".changing-release"), "{}");
    expect(await restore("shop", "--confirm", "shop")).toBe(2);
    expect(err()).toContain("unfinished Release change");
    expect(sysctls()).toEqual([]);
  });

  it("refuses when the Instance has no Backup", async () => {
    const old = await start();
    await rm(backups("shop", old));
    expect(await restore("shop", "--confirm", "shop")).toBe(2);
    expect(err()).toContain("shop has no backups");
    expect(err()).toContain("dcabsm backup create shop");
  });

  it("types the name to confirm, and a wrong name changes nothing", async () => {
    await start({ interactive: true, answers: ["wrong"] });
    expect(await restore("shop")).toBe(1);
    expect(h.asked).toEqual(["Type the Instance name shop to confirm: "]);
    expect(out()).toContain("The name did not match. Nothing changed.");
    expect(out()).toContain("Open Actual on every device and let it sync");
    expect(sysctls()).toEqual([]);
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
  });

  it("proceeds when the right name is typed, and refuses without a terminal or --confirm", async () => {
    await start({ interactive: true, answers: ["shop"] });
    expect(await restore("shop")).toBe(0);
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
  });

  it("refuses without a terminal and without --confirm", async () => {
    await start();
    expect(await restore("shop")).toBe(2);
    expect(err()).toContain("--confirm shop");
    expect(sysctls()).toEqual([]);
  });

  it("keeps the current record, hostname, port, settings and certificate", async () => {
    await start();
    // Settings changed after the Backup: the restore must not bring the archive's record back.
    expect(await run(["instance", "set", "shop", "openid-enforce", "true", "--yes"], h.ctx)).toBe(
      0,
    );
    const cert = await readFile(inst("nginx", "cert.pem"), "utf8");
    const record = await readFile(inst("config", "instance.json"), "utf8");
    expect(record).toContain("openid-enforce");
    expect(await restore("shop", "--confirm", "shop")).toBe(0);
    expect(await readFile(inst("config", "instance.json"), "utf8")).toBe(record);
    expect(await readFile(inst("nginx", "cert.pem"), "utf8")).toBe(cert);
    const config = JSON.parse(await readFile(inst("config", "config.json"), "utf8"));
    expect(config.port).toBe(15127);
    expect(config.dataDir).toBe("/srv/dcabsm/instances/shop/data");
    expect(await readFile(inst("nginx", "vhost.conf"), "utf8")).toContain(
      "server_name shop.example.org;",
    );
  });

  it("regenerates config.json and vhost.conf from the record", async () => {
    await start();
    await writeFile(inst("config", "config.json"), "{}");
    await writeFile(inst("nginx", "vhost.conf"), "# edited by hand");
    expect(await restore("shop", "--confirm", "shop")).toBe(0);
    expect(JSON.parse(await readFile(inst("config", "config.json"), "utf8")).port).toBe(15127);
    expect(await readFile(inst("nginx", "vhost.conf"), "utf8")).toContain(
      "server_name shop.example.org;",
    );
  });

  it("a stopped Instance returns to stopped", async () => {
    await start({ stopped: true });
    expect(await restore("shop", "--confirm", "shop")).toBe(0);
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop", "stop dcabsm@shop"]);
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v1");
    expect(out()).toContain("shop was stopped before the restore, so it is stopped again");
  });
});

describe("a restore across Releases", () => {
  /** Upgrades `shop` to 26.11.1, so the 26.11.0 archive sits on an older Release than the Instance. */
  async function upgraded(): Promise<void> {
    expect(await run(["instance", "upgrade", "shop", "--yes"], h.ctx)).toBe(0);
    h.out.length = 0;
    h.calls.length = 0;
  }

  it("moves to the archive's Release and suggests an Upgrade to get the newer one back", async () => {
    await start();
    await upgraded();
    expect(await linked()).toBe("26.11.1");
    expect(await restore("shop", "--confirm", "shop")).toBe(0);
    expect(await linked()).toBe("26.11.0");
    expect(JSON.parse(await readFile(inst("config", "config.json"), "utf8")).port).toBe(15127);
    expect(out()).toContain("Started and verified: /health UP, /info 26.11.0");
    expect(out()).toContain("sudo dcabsm instance upgrade shop");
    // The pre-restore Backup is on the Release the Instance was on.
    expect(await readdir(backups("shop"))).toContain("20261109T120000Z-pre-restore-26.11.1.tar.gz");
  });

  it("installs the archive's Release when it is missing", async () => {
    await start();
    await upgraded();
    const dir = join(h.ctx.paths.releases, "26.11.0");
    await makeWritable(dir);
    await rm(dir, { recursive: true });
    expect(await restore("shop", "--confirm", "shop")).toBe(0);
    expect(out()).toContain("Installed Release 26.11.0");
    expect(await linked()).toBe("26.11.0");
  });

  it("names a setting the archive's Release doesn't know as not used", async () => {
    await start({ settings: { "simplefin-allowed-networks": "10.0.0.0/8" } });
    // Pretend the archive is from 26.10.0, which doesn't know the setting.
    const old = (await readdir(backups("shop")))[0]!;
    const older = old.replace("26.11.0", "26.10.0");
    await rename(backups("shop", old), backups("shop", older));
    const archive = JSON.parse(readFileSync(backups("shop", older), "utf8"));
    archive.manifest = archive.manifest.replace("26.11.0", "26.10.0");
    writeFileSync(backups("shop", older), JSON.stringify(archive));

    expect(await restore("shop", "--confirm", "shop")).toBe(0);
    expect(await linked()).toBe("26.10.0");
    expect(out()).toContain("simplefin-allowed-networks: not used by 26.10.0");
    const config = JSON.parse(await readFile(inst("config", "config.json"), "utf8"));
    expect(JSON.stringify(config)).not.toContain("10.0.0.0/8");
    const record = JSON.parse(await readFile(inst("config", "instance.json"), "utf8"));
    expect(record.settings["simplefin-allowed-networks"]).toBe("10.0.0.0/8");
  });
});

describe("a failed Verification", () => {
  it("restores the pre-restore Backup automatically, with the data and Release as before", async () => {
    await start();
    expect(await run(["instance", "upgrade", "shop", "--yes"], h.ctx)).toBe(0);
    await writeFile(inst("data", "notes"), "v3");
    h.out.length = 0;
    h.calls.length = 0;
    broken.add("26.11.0");

    expect(await restore("shop", "--confirm", "shop")).toBe(1);

    expect(await linked()).toBe("26.11.1");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v3");
    await expect(stat(inst(".changing-release"))).rejects.toThrow();
    // Rolled back without a Regroup: the group id is the one the data had before the restore.
    expect(groupIds()).toEqual(["group-one"]);
    expect(out()).toContain("Rolling back automatically");
    expect(out()).toContain("Restored data from 20261109T120000Z-pre-restore-26.11.1.tar.gz");
    expect(out()).toContain("Started and verified: /health UP, /info 26.11.1");
    expect(out()).not.toContain("On every device");
    expect(err()).toContain("Restore of shop failed and was rolled back");
    expect(markers.slice(-2).map((m) => m.gate)).toEqual([true, true]);
  });

  it("returns a stopped Instance to stopped", async () => {
    await start();
    expect(await run(["instance", "upgrade", "shop", "--yes"], h.ctx)).toBe(0);
    host.active.delete("dcabsm@shop");
    h.calls.length = 0;
    broken.add("26.11.0");
    expect(await restore("shop", "--confirm", "shop")).toBe(1);
    expect(await linked()).toBe("26.11.1");
    expect(sysctls().at(-1)).toBe("stop dcabsm@shop");
    expect(await readFile(inst("data", "notes"), "utf8")).toBe("v2");
    await expect(stat(inst(".changing-release"))).rejects.toThrow();
  });

  it("stays stopped with the marker and names the Backup when the rollback fails too", async () => {
    await start();
    broken.add("26.11.0");
    expect(await restore("shop", "--confirm", "shop")).toBe(1);
    // Both starts failed: the restore's and the rollback's.
    const file = backups("shop", "20261109T120000Z-pre-restore-26.11.0.tar.gz");
    expect(err()).toContain("and so did the automatic rollback");
    expect(err()).toContain(file);
    expect(sysctls().at(-1)).toBe("stop dcabsm@shop");
    expect((await stat(inst(".changing-release"))).isFile()).toBe(true);
    await expect(stat(file)).resolves.toBeTruthy();
  });
});
