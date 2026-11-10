import { mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { hashOf, SERVICE_PATH, unitTemplate } from "../src/host/owned.ts";
import { withLock } from "../src/lock.ts";
import { migrateLayout } from "../src/self/migrations.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const opt = () => h.ctx.paths.opt;
const read = (p: string) => readFile(p, "utf8");
const hostJson = async () => JSON.parse(await read(h.ctx.paths.hostConfig));
const names = (dir: string) => readdir(dir).catch(() => [] as string[]);
const update = (...args: string[]) => run(["self", "update", "--yes", ...args], h.ctx);

/** A Host with DCABSM `test` installed (the running version), an older `1.0.0` kept, and the installed key. */
async function start(
  opts: HarnessOptions & { config?: Record<string, unknown> } = {},
): Promise<void> {
  h = await harness(opts);
  const { paths } = h.ctx;
  await mkdir(join(paths.installDir, "share"), { recursive: true });
  await writeFile(paths.signingKey, "OLDKEY");
  await mkdir(join(opt(), "1.0.0", "bin"), { recursive: true });
  await mkdir(join(paths.binLink, ".."), { recursive: true });
  await symlink("/opt/dcabsm/test/bin/dcabsm", paths.binLink);
  if (opts.setUp ?? true) {
    await writeFile(
      paths.hostConfig,
      JSON.stringify(opts.config ?? { layout: 1, ownedFiles: {} }, null, 2),
    );
  }
}

describe("self update", () => {
  it("installs the latest signed version, switches the link and keeps only current and previous", async () => {
    await start();
    expect(await update()).toBe(0);

    expect(await names(opt())).toEqual(["1.3.0", "test"]);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/1.3.0/bin/dcabsm");
    expect(await read(join(opt(), "1.3.0/bin/dcabsm"))).toBe("wrapper");
    expect(h.out.join("\n")).toContain(
      "Signature good, checked with gpgv against the installed key",
    );
    expect(h.out).toContain("  ✓ Removed /opt/dcabsm/1.0.0/ (keeps current and previous)");
  });

  it("checks the signature only against the installed key", async () => {
    await start();
    await update();
    const gpgv = h.calls.find((c) => c.command === "gpgv")!;
    expect(gpgv.args.slice(0, 2)).toEqual(["--keyring", h.ctx.paths.signingKey]);
  });

  it("refuses a bad signature and leaves the Host as it was", async () => {
    await start();
    h.net.badSignature = true;
    expect(await update()).toBe(1);
    expect(h.err.join("\n")).toContain("does not verify against the installed key");
    expect(await names(opt())).toEqual(["1.0.0", "test"]);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/test/bin/dcabsm");
    expect(h.calls.some((c) => c.command === "tar")).toBe(false);
  });

  it("refuses a tarball that does not match SHA256SUMS", async () => {
    await start();
    h.net.dcabsmBadChecksum = true;
    expect(await update()).toBe(1);
    expect(h.err.join("\n")).toContain("does not match its SHA-256");
    expect(await names(opt())).toEqual(["1.0.0", "test"]);
  });

  it("ships a new signing key inside an update checked by the old one", async () => {
    await start();
    h.net.dcabsm["1.3.0"] = { layout: 1, files: { "share/dcabsm-signing-key.gpg": "NEWKEY" } };
    await update();
    expect(await read(join(opt(), "1.3.0/share/dcabsm-signing-key.gpg"))).toBe("NEWKEY");
    expect(h.calls.find((c) => c.command === "gpgv")!.args[1]).toBe(h.ctx.paths.signingKey);
    expect(await read(h.ctx.paths.signingKey)).toBe("OLDKEY");
  });

  it("carries the installed key forward when the update ships none", async () => {
    await start();
    await update();
    expect(await read(join(opt(), "1.3.0/share/dcabsm-signing-key.gpg"))).toBe("OLDKEY");
  });

  it("migrates a lower stored layout forward and says so", async () => {
    await start();
    h.net.dcabsmLatest = "2.0.0";
    await mkdir(join(h.ctx.paths.etc, "replaced"), { recursive: true });
    await writeFile(join(h.ctx.paths.etc, "replaced", "old"), "keep me");
    expect(await update()).toBe(0);

    expect(await hostJson()).toMatchObject({ layout: 2, layoutSince: "2.0.0" });
    expect(await read(join(h.ctx.paths.etc, "replaced/old"))).toBe("keep me");
    expect(await names(join(h.ctx.paths.etc, ".."))).not.toContainEqual(
      expect.stringContaining("aside"),
    );
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/2.0.0/bin/dcabsm");
    expect(h.out).toContain("  ✓ Copied /etc/dcabsm aside, migrated layout 1 → 2");
  });

  it("puts /etc/dcabsm back and keeps the old version when a migration fails", async () => {
    await start();
    h.net.dcabsmLatest = "2.0.0";
    h.net.dcabsm["2.0.0"] = { layout: 2, migrateFails: true };
    const before = await read(h.ctx.paths.hostConfig);

    expect(await update()).toBe(1);

    expect(h.err.join("\n")).toContain("Migrating layout 1 → 2 failed");
    expect(await read(h.ctx.paths.hostConfig)).toBe(before);
    expect(await names(h.ctx.paths.etc)).toEqual(["dcabsm.json"]);
    expect(await names(join(h.ctx.paths.etc, ".."))).toEqual(["dcabsm", "os-release"]);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/test/bin/dcabsm");
    expect(await names(opt())).toEqual(["1.0.0", "test"]);
    // The lock is released, so the next command can run.
    expect(await names(join(h.ctx.paths.lock, ".."))).toEqual([]);
  });

  it("refuses --to across a layout change, naming the way to do it", async () => {
    await start();
    expect(await update("--to", "2.0.0")).toBe(2);
    expect(h.err).toEqual([
      "error: DCABSM 2.0.0 uses layout 2; this Host is on layout 1.",
      "  Moving to a new layout is only done to the latest version: sudo dcabsm self update",
    ]);
    expect(await names(opt())).toEqual(["1.0.0", "test"]);
    expect((await hostJson()).layout).toBe(1);
  });

  it("moves to an older version with --to on the same layout", async () => {
    await start();
    expect(await update("--to", "1.1.0")).toBe(0);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/1.1.0/bin/dcabsm");
    expect(await names(opt())).toEqual(["1.1.0", "test"]);
  });

  it("refuses a version whose layout is lower than the Host's", async () => {
    await start({ config: { layout: 2, layoutSince: "2.0.0" } });
    expect(await update()).toBe(2);
    expect(h.err[0]).toBe("error: DCABSM 1.3.0 uses layout 1; this Host is on layout 2.");
    expect(await names(opt())).toEqual(["1.0.0", "test"]);
  });

  it("refuses a version that is not stable or not published", async () => {
    await start();
    expect(await update("--to", "1.3.0-rc1")).toBe(2);
    expect(await update("--to", "9.9.9")).toBe(1);
    expect(await names(opt())).toEqual(["1.0.0", "test"]);
  });

  it("asks before it downloads, and stops on no", async () => {
    await start({ interactive: true, answers: ["n"] });
    expect(await run(["self", "update"], h.ctx)).toBe(1);
    expect(h.asked).toEqual(["Continue? [y/N] "]);
    expect(h.net.fetched.filter((u) => u.includes("releases/download"))).toEqual([]);
  });

  it("never restarts an Instance and passes along 'restart needed'", async () => {
    await start();
    h.net.refreshOutput = "  ! Restart needed: family (its generated config.json changed).\n";
    await update();
    expect(h.out).toContain("  ! Restart needed: family (its generated config.json changed).");
    expect(h.calls.some((c) => c.command === "systemctl" && c.args[0] === "restart")).toBe(false);
  });

  it("works before setup, with nothing to migrate or refresh", async () => {
    await start({ setUp: false });
    expect(await update()).toBe(0);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/1.3.0/bin/dcabsm");
    expect(h.calls.some((c) => c.args.join(" ") === "self refresh")).toBe(false);
  });
});

describe("the layout gate", () => {
  it("refuses every command while the stored layout is higher, naming the version needed", async () => {
    await start({ config: { layout: 3, layoutSince: "2.0.0" } });
    expect(await run(["instance", "list"], h.ctx)).toBe(2);
    expect(h.err).toEqual([
      "error: This Host was last changed by a newer DCABSM (layout 3). This is DCABSM 0.0.0-dev (layout 1).",
      "  Install DCABSM 2.0.0 or newer: sudo dcabsm self update",
    ]);
  });

  it("refuses every command while the stored layout is lower", async () => {
    await start({ config: { layout: 0 } });
    expect(await run(["backup", "list", "--all"], h.ctx)).toBe(2);
    expect(h.err[0]).toContain("This Host is on layout 0");
    expect(h.err[1]).toBe("  Run: sudo dcabsm self update");
  });

  it("still lets self version and self update through", async () => {
    await start({ config: { layout: 3, layoutSince: "2.0.0" } });
    h.net.dcabsm["2.0.0"] = { layout: 3 };
    h.net.dcabsmLatest = "2.0.0";
    expect(await run(["self", "version"], h.ctx)).toBe(0);
    expect(await update()).toBe(0);
    expect((await hostJson()).layout).toBe(3);
  });

  it("migrates a Host left on a lower layout when self update runs", async () => {
    await start({ config: { layout: 0 } });
    h.net.dcabsm["1.3.0"] = { layout: 1 };
    expect(await update()).toBe(0);
    expect((await hostJson()).layout).toBe(1);
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
  });

  it("does not gate a Host with no stored layout yet", async () => {
    await start({ config: {} });
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
  });
});

describe("hidden steps", () => {
  it("only run inside self update's lock", async () => {
    await start();
    expect(await run(["self", "migrate"], h.ctx)).toBe(2);
    expect(await run(["self", "refresh"], h.ctx)).toBe(2);
    expect(h.err[0]).toBe("error: self migrate is a step of self update.");
  });

  it("are left out of help", async () => {
    await start();
    await run(["help"], h.ctx);
    expect(h.out.join("\n")).not.toContain("migrate");
  });
});

describe("migrateLayout", () => {
  it("runs each step forward in order and stores the layout", async () => {
    await start({ config: { layout: 1, backupDir: "/b" } });
    const ran: number[] = [];
    await migrateLayout(h.ctx, 1, 3, {
      2: async () => void ran.push(2),
      3: async () => void ran.push(3),
    });
    expect(ran).toEqual([2, 3]);
    expect(await hostJson()).toMatchObject({ layout: 3, backupDir: "/b" });
  });

  it("stops at a missing step without storing a layout", async () => {
    await start();
    await expect(migrateLayout(h.ctx, 1, 2, {})).rejects.toThrow("no migration to layout 2");
    expect((await hostJson()).layout).toBe(1);
  });
});

describe("self refresh", () => {
  async function refresh() {
    return withLock(h.ctx, "dcabsm self update", () => run(["self", "refresh"], h.ctx));
  }

  it("rewrites an older owned file DCABSM wrote and keeps one edited by hand", async () => {
    const stale = "# old unit\n";
    await start({ config: { layout: 1, ownedFiles: { [SERVICE_PATH]: hashOf(stale) } } });
    await mkdir(join(h.root, "etc/systemd/system"), { recursive: true });
    await writeFile(h.ctx.paths.under(SERVICE_PATH), stale);
    await writeFile(h.ctx.paths.under("/etc/systemd/system/dcabsm-nightly.timer"), "mine\n");

    expect(await refresh()).toBe(0);

    expect(await read(h.ctx.paths.under(SERVICE_PATH))).toBe(unitTemplate());
    expect(await read(h.ctx.paths.under("/etc/systemd/system/dcabsm-nightly.timer"))).toBe(
      "mine\n",
    );
    expect(h.out.join("\n")).toContain("dcabsm@.service");
    expect(h.out.join("\n")).toContain("Kept your edited /etc/systemd/system/dcabsm-nightly.timer");
    expect(h.calls).toContainEqual({ command: "systemctl", args: ["daemon-reload"] });
    expect((await hostJson()).ownedFiles[SERVICE_PATH]).toBe(hashOf(unitTemplate()));
  });

  it("regenerates an Instance's files and reports a restart for a running Instance only", async () => {
    await start({}); // fresh harness below needs the running state
    await h.cleanup();
    h = await harness({
      runner: (c, a) =>
        c === "systemctl" && a[0] === "is-active"
          ? { code: 0, stdout: a[1] === "dcabsm@family" ? "active\n" : "inactive\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });
    await writeFile(h.ctx.paths.hostConfig, JSON.stringify({ layout: 1, ownedFiles: {} }));
    for (const name of ["family", "idle"]) {
      const dir = join(h.ctx.paths.instances, name);
      await mkdir(join(dir, "config"), { recursive: true });
      await mkdir(join(dir, "nginx"), { recursive: true });
      await mkdir(join(h.ctx.paths.releases, "26.11.0"), { recursive: true });
      await symlink(join(h.ctx.paths.releases, "26.11.0"), join(dir, "release"));
      await writeFile(
        join(dir, "config/instance.json"),
        JSON.stringify({ port: 15127, hostname: `${name}.example.com`, scheduledBackups: true }),
      );
      await writeFile(join(dir, "config/config.json"), "{}\n");
      await writeFile(join(dir, "nginx/vhost.conf"), "old vhost\n");
    }

    expect(await refresh()).toBe(0);

    const out = h.out.join("\n");
    expect(out).toContain("2 vhost.conf");
    expect(out).toContain(
      "Restart needed: family (its generated config.json changed). Run: sudo dcabsm instance restart family",
    );
    expect(out).not.toContain("Restart needed: idle");
    const dir = join(h.ctx.paths.instances, "family");
    expect(await read(join(dir, "config/config.json"))).toContain('"port": 15127');
    expect(await read(join(dir, "nginx/vhost.conf"))).toContain("server_name family.example.com;");
  });

  it("puts the old vhosts back when nginx -t fails", async () => {
    await start({});
    await h.cleanup();
    h = await harness({
      runner: (c) =>
        c === "nginx"
          ? { code: 1, stdout: "", stderr: "nginx: bad config" }
          : { code: 0, stdout: "", stderr: "" },
    });
    await writeFile(h.ctx.paths.hostConfig, JSON.stringify({ layout: 1, ownedFiles: {} }));
    const dir = join(h.ctx.paths.instances, "family");
    await mkdir(join(dir, "config"), { recursive: true });
    await mkdir(join(dir, "nginx"), { recursive: true });
    await mkdir(join(h.ctx.paths.releases, "26.11.0"), { recursive: true });
    await symlink(join(h.ctx.paths.releases, "26.11.0"), join(dir, "release"));
    await writeFile(
      join(dir, "config/instance.json"),
      JSON.stringify({ port: 15127, hostname: "f.example.com", scheduledBackups: true }),
    );
    await writeFile(join(dir, "config/config.json"), "{}\n");
    await writeFile(join(dir, "nginx/vhost.conf"), "old vhost\n");

    expect(await refresh()).toBe(1);
    expect(await read(join(dir, "nginx/vhost.conf"))).toBe("old vhost\n");
  });
});
