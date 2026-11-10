import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { gateDir } from "../src/instance/start-gate.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
let net: FakeNet;
let host: FakeHost;
/** Releases whose server never reports its own version, so Verification fails on them. */
let broken: Set<string>;
/** Units `is-active` calls failed. */
let failed: Set<string>;
/** What the "new Release" does to the data when it starts (a migration). */
let migrates = false;
/** Marker contents seen at each start. */
let markers: Array<{ unit: string; marker: string | undefined; gate: boolean }>;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const inst = (name: string, ...parts: string[]) => join(h.ctx.paths.instances, name, ...parts);
const backups = (...parts: string[]) => join(h.ctx.paths.under("/srv/dcabsm/backups"), ...parts);
const upgrade = (...args: string[]) => run(["instance", "upgrade", ...args], h.ctx);
const err = () => h.err.join("\n");
const out = () => h.out.join("\n");
const linked = async (name: string) => basename(await readlink(inst(name, "release")));
const sysctls = () =>
  h.calls
    .filter(
      (c) =>
        c.command === "systemctl" && !["is-active", "show", "daemon-reload"].includes(c.args[0]!),
    )
    .map((c) => c.args.join(" "));

interface Options {
  /** Instances to leave without data, as if they never started. */
  empty?: string[];
  /** Instances to stop after creating. */
  stopped?: string[];
  answers?: string[];
  interactive?: boolean;
}

/** A Host with Release 26.11.0 installed and each named Instance created on it. */
async function start(names: string[], opts: Options = {}): Promise<void> {
  host = fakeHost();
  net = fakeNet({ serverVersion: "26.11.0" });
  broken = new Set();
  failed = new Set();
  markers = [];
  migrates = false;
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
        const unit = args.at(-1)!.replace(/^dcabsm@/, "");
        if (failed.has(unit)) return { code: 3, stdout: "failed\n", stderr: "" };
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
  for (const name of names) {
    const args = ["instance", "create", name, "--hostname", `${name}.example.org`, "--self-signed"];
    expect(await run([...args, "--release", "26.11.0", "--yes"], h.ctx)).toBe(0);
    if (!opts.empty?.includes(name)) {
      await writeFile(inst(name, "data", "account.sqlite"), `budget of ${name}`);
    }
    if (opts.stopped?.includes(name)) host.active.delete(`dcabsm@${name}`);
  }
  await mkdir(p.under("/srv/dcabsm/backups"), { recursive: true, mode: 0o700 });
  h.out.length = 0;
  h.calls.length = 0;
}

/** The server reports the Release the `release` link points to, unless that Release is broken. */
function onStart(unit: string): void {
  const name = unit.replace(/^dcabsm@/, "");
  let version: string;
  try {
    version = basename(readlinkSync(inst(name, "release")));
  } catch {
    return;
  }
  let marker: string | undefined;
  try {
    marker = readFileSync(inst(name, ".changing-release"), "utf8");
  } catch {
    marker = undefined;
  }
  // The unit skips a start while the marker exists, unless the start gate lifts that rule (spec 6.1).
  const gate = existsSync(`${gateDir(h.ctx, name)}/10-start-gate.conf`);
  markers.push({ unit, marker, gate });
  failed.delete(name);
  net.serverVersion = broken.has(version) ? "0.0.0" : version;
  if (migrates && version === "26.11.1") {
    writeFileSync(inst(name, "data", "migrated"), "new schema");
  }
}

describe("instance upgrade", () => {
  it("backs up, switches, verifies and removes the marker", async () => {
    await start(["shop"]);
    expect(await upgrade("shop", "--yes")).toBe(0);

    expect(await linked("shop")).toBe("26.11.1");
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    // The Pre-upgrade backup holds the old Release's name.
    expect(await readdir(backups("shop"))).toEqual(["20261109T120000Z-pre-upgrade-26.11.0.tar.gz"]);
    // The marker was there during the start, with the gate open so systemd really starts the unit.
    expect(markers.at(-1)!.gate).toBe(true);
    await expect(stat(gateDir(h.ctx, "shop"))).rejects.toThrow();
    const seen = JSON.parse(markers.at(-1)!.marker!);
    expect(seen).toEqual({
      operation: "upgrade",
      from: "26.11.0",
      to: "26.11.1",
      backup: backups("shop", "20261109T120000Z-pre-upgrade-26.11.0.tar.gz"),
      restoringData: false,
    });
    await expect(stat(inst("shop", ".changing-release"))).rejects.toThrow();
    const config = JSON.parse(await readFile(inst("shop", "config", "config.json"), "utf8"));
    expect(config.port).toBe(15127);
    expect(out()).toContain("Upgrade to Actual 26.11.1");
    expect(out()).toContain("shop       26.11.0 → 26.11.1");
    expect(out()).toContain("Release notes: https://actualbudget.org/docs/releases");
    expect(out()).toContain("shop      upgraded");
    expect(out()).toContain("Click Update now, or reload twice");
  });

  it("installs the target Release when it is missing", async () => {
    await start(["shop"]);
    await expect(stat(join(h.ctx.paths.releases, "26.11.1"))).rejects.toThrow();
    expect(await upgrade("shop", "--yes")).toBe(0);
    expect((await stat(join(h.ctx.paths.releases, "26.11.1"))).isDirectory()).toBe(true);
    expect(out()).toContain("Installed Release 26.11.1");
  });

  it("asks first, and a no changes nothing", async () => {
    await start(["shop"], { interactive: true, answers: ["n"] });
    expect(await upgrade("shop")).toBe(1);
    expect(h.asked).toEqual(["Continue? [y/N] "]);
    expect(out()).toContain("Cancelled. Nothing changed.");
    expect(await linked("shop")).toBe("26.11.0");
    expect(sysctls()).toEqual([]);
    await expect(stat(join(h.ctx.paths.releases, "26.11.1"))).rejects.toThrow();
  });

  it("refuses without a terminal or --yes", async () => {
    await start(["shop"]);
    expect(await upgrade("shop")).toBe(2);
    expect(err()).toContain("No terminal to confirm on.");
    expect(sysctls()).toEqual([]);
  });

  it("refuses an older target and points to rollback", async () => {
    await start(["shop"]);
    expect(await upgrade("shop", "--to", "26.10.0", "--yes")).toBe(2);
    expect(err()).toContain("shop runs 26.11.0, which is newer than 26.10.0");
    expect(err()).toContain("sudo dcabsm instance rollback shop");
    expect(sysctls()).toEqual([]);
  });

  it("skips an Instance already on the target", async () => {
    await start(["shop", "home"]);
    expect(await upgrade("shop", "--to", "26.11.0", "--yes")).toBe(0);
    expect(out()).toContain("shop is already on 26.11.0.");
    expect(sysctls()).toEqual([]);

    expect(await upgrade("shop", "--yes")).toBe(0);
    h.out.length = 0;
    expect(await upgrade("shop", "home", "--to", "26.11.1", "--yes")).toBe(0);
    expect(out()).toContain("home       26.11.0 → 26.11.1");
    expect(out()).toContain("shop      skipped, already on 26.11.1");
    expect(await linked("home")).toBe("26.11.1");
  });

  it("fails when npm is unreachable and asks for --to with an installed Release", async () => {
    await start(["shop"]);
    net.down = ["registry.npmjs.org"];
    expect(await upgrade("shop", "--yes")).toBe(1);
    expect(err()).toContain("npm registry");
    expect(err()).toContain("--to <v> (installed: 26.11.0)");
    expect(sysctls()).toEqual([]);
  });

  it("upgrades to an installed Release without the network", async () => {
    await start(["shop"]);
    expect(await run(["release", "install", "26.11.1"], h.ctx)).toBe(0);
    h.calls.length = 0;
    net.down = ["registry.npmjs.org"];
    expect(await upgrade("shop", "--to", "26.11.1", "--yes")).toBe(0);
    expect(await linked("shop")).toBe("26.11.1");
  });

  it("refuses a target whose Node the DCABSM cannot run, before stopping anything", async () => {
    await start(["shop"]);
    net.actual["26.12.0"] = ">=30";
    expect(await upgrade("shop", "--to", "26.12.0", "--yes")).toBe(1);
    expect(err()).toContain("needs Node >=30");
    expect(sysctls()).toEqual([]);
    expect(await linked("shop")).toBe("26.11.0");
  });

  it("refuses an unknown Release and an unfinished change", async () => {
    await start(["shop"]);
    expect(await upgrade("shop", "--to", "26.11.9", "--yes")).toBe(2);
    expect(err()).toContain("does not exist on npm");
    await writeFile(inst("shop", ".changing-release"), "{}");
    h.err.length = 0;
    expect(await upgrade("shop", "--yes")).toBe(2);
    expect(err()).toContain("shop has an unfinished Release change");
  });

  it("fails for lack of space before the Instance stops", async () => {
    await start(["shop"]);
    await writeFile(inst("shop", "data", "big"), "x".repeat(300_000));
    expect(await upgrade("shop", "--yes")).toBe(1);
    expect(err()).toContain("Not enough space");
    expect(sysctls()).toEqual([]);
    expect(await linked("shop")).toBe("26.11.0");
    expect(out()).not.toContain("Continue?");
  });

  it("needs names or --all, not both", async () => {
    await start(["shop"]);
    expect(await upgrade("--yes")).toBe(2);
    expect(await upgrade("shop", "--all", "--yes")).toBe(2);
    expect(await upgrade("nosuch", "--yes")).toBe(2);
    expect(err()).toContain("There is no Instance named nosuch");
  });

  it("--all upgrades every Instance, one at a time, after one question", async () => {
    await start(["alpha", "beta"], { interactive: true, answers: ["y"] });
    expect(await upgrade("--all")).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(sysctls()).toEqual([
      "stop dcabsm@alpha",
      "start dcabsm@alpha",
      "stop dcabsm@beta",
      "start dcabsm@beta",
    ]);
    expect(out()).toContain("alpha     upgraded");
    expect(out()).toContain("beta      upgraded");
  });
});

describe("a failed start before the symlink moves", () => {
  it("restarts on the old Release with nothing changed", async () => {
    await start(["shop"]);
    net.tarCreateFails = true;
    expect(await upgrade("shop", "--yes")).toBe(1);
    expect(err()).toContain("Upgrade of shop failed before anything changed");
    expect(await linked("shop")).toBe("26.11.0");
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    await expect(stat(inst("shop", ".changing-release"))).rejects.toThrow();
    expect(out()).toContain("shop      failed, still on 26.11.0");
    expect(out()).toContain("Started and verified: /health UP, /info 26.11.0");
  });
});

describe("a failed Verification", () => {
  it("restores data from the Pre-upgrade backup, goes back and verifies", async () => {
    await start(["shop"]);
    broken.add("26.11.1");
    migrates = true;
    expect(await upgrade("shop", "--yes")).toBe(1);

    expect(await linked("shop")).toBe("26.11.0");
    // The new Release's migration is gone, the budget is as it was.
    expect(await readdir(inst("shop", "data"))).toEqual(["account.sqlite"]);
    expect(await readFile(inst("shop", "data", "account.sqlite"), "utf8")).toBe("budget of shop");
    await expect(stat(inst("shop", ".changing-release"))).rejects.toThrow();
    expect(sysctls()).toEqual([
      "stop dcabsm@shop",
      "start dcabsm@shop",
      "stop dcabsm@shop",
      "start dcabsm@shop",
    ]);
    // Rolled back without Regroup: the data tar extract is the only data step.
    expect(h.calls.some((c) => c.command === "tar" && c.args[0] === "-xzf")).toBe(true);
    expect(h.calls.some((c) => c.command === "chown" && c.args[0] === "-R")).toBe(true);
    expect(markers.at(-1)!.marker).toContain('"restoringData": true');
    expect(markers.slice(-2).map((m) => m.gate)).toEqual([true, true]);
    expect(out()).toContain("Rolling back automatically");
    expect(out()).toContain("Restored data from 20261109T120000Z-pre-upgrade-26.11.0.tar.gz");
    expect(out()).toContain("Switched back to 26.11.0");
    expect(out()).toContain("shop      failed, back on 26.11.0");
    expect(err()).toContain("Upgrade of shop failed and was rolled back.");
    expect(out()).not.toContain("On every device");
    const config = JSON.parse(await readFile(inst("shop", "config", "config.json"), "utf8"));
    expect(config.port).toBe(15127);
  });

  it("stays stopped with the marker and names the Backup when the rollback fails too", async () => {
    await start(["shop"]);
    broken.add("26.11.1");
    broken.add("26.11.0");
    expect(await upgrade("shop", "--yes")).toBe(1);

    const file = "20261109T120000Z-pre-upgrade-26.11.0.tar.gz";
    expect(err()).toContain("and so did the automatic rollback");
    expect(err()).toContain(backups("shop", file));
    expect(await readdir(backups("shop"))).toEqual([file]);
    // The rollback is tried once: two starts in all, and a final stop.
    expect(sysctls()).toEqual([
      "stop dcabsm@shop",
      "start dcabsm@shop",
      "stop dcabsm@shop",
      "start dcabsm@shop",
      "stop dcabsm@shop",
    ]);
    const marker = JSON.parse(await readFile(inst("shop", ".changing-release"), "utf8"));
    expect(marker.restoringData).toBe(true);
    expect(marker.backup).toBe(backups("shop", file));
    expect(out()).toContain("shop      failed, stopped");
  });

  it("stops at the first failure and leaves the rest untouched", async () => {
    await start(["alpha", "beta"]);
    broken.add("26.11.1");
    expect(await upgrade("alpha", "beta", "--yes")).toBe(1);
    expect(out()).toContain("alpha     failed, back on 26.11.0");
    expect(out()).toContain("beta      not started");
    expect(await linked("beta")).toBe("26.11.0");
    expect(sysctls().some((c) => c.endsWith("dcabsm@beta"))).toBe(false);
  });

  it("does not stop the batch for earlier successes, and reports them", async () => {
    await start(["alpha", "beta"]);
    // beta fails: make only beta's server report wrong by breaking after alpha is done.
    const inner = h.ctx.runner;
    h.ctx.runner = {
      run: (c, a) => {
        if (c === "systemctl" && a[0] === "start" && a.at(-1) === "dcabsm@beta") {
          broken.add("26.11.1");
        }
        return inner.run(c, a);
      },
    };
    expect(await upgrade("alpha", "beta", "--yes")).toBe(1);
    expect(out()).toContain("alpha     upgraded");
    expect(out()).toContain("beta      failed, back on 26.11.0");
    expect(out()).toContain("On every device");
    expect(await linked("alpha")).toBe("26.11.1");
  });
});

describe("Instances that are not running", () => {
  it("starts and verifies a stopped Instance, then returns it to stopped", async () => {
    await start(["shop"], { stopped: ["shop"] });
    expect(await upgrade("shop", "--yes")).toBe(0);
    expect(await linked("shop")).toBe("26.11.1");
    expect(sysctls()).toEqual(["stop dcabsm@shop", "start dcabsm@shop", "stop dcabsm@shop"]);
    expect(host.active.has("dcabsm@shop")).toBe(false);
    expect(out()).toContain("shop       26.11.0 → 26.11.1  (stopped; returns to stopped)");
    expect(out()).toContain("Started and verified: /health UP, /info 26.11.1");
    expect(await readdir(backups("shop"))).toHaveLength(1);
  });

  it("treats a failed Instance the same way", async () => {
    await start(["shop"]);
    failed.add("shop");
    host.active.delete("dcabsm@shop");
    expect(await upgrade("shop", "--yes")).toBe(0);
    expect(out()).toContain("(failed; returns to stopped)");
    expect(host.active.has("dcabsm@shop")).toBe(false);
    expect(await linked("shop")).toBe("26.11.1");
  });

  it("returns a stopped Instance to stopped after a rollback", async () => {
    await start(["shop"], { stopped: ["shop"] });
    broken.add("26.11.1");
    expect(await upgrade("shop", "--yes")).toBe(1);
    expect(host.active.has("dcabsm@shop")).toBe(false);
    expect(await linked("shop")).toBe("26.11.0");
  });

  it("only changes Release for an Instance that has never started", async () => {
    await start(["shop"], { empty: ["shop"], stopped: ["shop"] });
    expect(await upgrade("shop", "--yes")).toBe(0);
    expect(await linked("shop")).toBe("26.11.1");
    expect(sysctls()).toEqual([]);
    expect(await readdir(backups())).toEqual([]);
    expect(out()).toContain("never started; only changes Release");
    const config = JSON.parse(await readFile(inst("shop", "config", "config.json"), "utf8"));
    expect(config.port).toBe(15127);
  });
});
