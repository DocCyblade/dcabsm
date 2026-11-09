import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { hashOf } from "../src/host/owned.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

async function setup(host: FakeHost, args = ["--yes"], opts: HarnessOptions = {}) {
  h = await harness({ setUp: false, runner: (c, a) => host.run(c, a), ...opts });
  return run(["host", "setup", ...args], h.ctx);
}
const rerun = (args = ["--yes"]) => run(["host", "setup", ...args], h.ctx);
const at = (logical: string) => h.ctx.paths.under(logical);
const read = (logical: string) => readFile(at(logical), "utf8");
const config = async () => JSON.parse(await readFile(h.ctx.paths.hostConfig, "utf8"));
const systemctl = () =>
  h.calls.filter((c) => c.command === "systemctl").map((c) => c.args.join(" "));
const pathExists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const UNIT = "/etc/systemd/system/dcabsm@.service";
const TIMER = "/etc/systemd/system/dcabsm-nightly.timer";
const DEFAULT = "/etc/nginx/conf.d/dcabsm-default.conf";

describe("owned files written by host setup", () => {
  it("writes the Instance unit template as spec 4.5 says", async () => {
    expect(await setup(fakeHost())).toBe(0);
    const unit = await read(UNIT);
    const i = "/srv/dcabsm/instances/%i";
    for (const line of [
      `ExecStart=${i}/release/node_modules/.bin/actual-server --config ${i}/config/config.json`,
      `WorkingDirectory=${i}`,
      `Environment=ACTUAL_DATA_DIR=${i}/data`,
      "Environment=NODE_ENV=production",
      `ConditionPathExists=!${i}/.changing-release`,
      `ConditionPathExists=${i}/release/node/bin/node`,
      "Restart=on-failure",
      "RestartSec=5",
      "StartLimitBurst=3",
      "StartLimitIntervalSec=300",
      "User=dcabsm-%i",
      "UMask=0077",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "ProtectSystem=strict",
      `ReadWritePaths=${i}/data ${i}/server-files ${i}/user-files`,
      "ProtectProc=invisible",
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      "SystemCallFilter=@system-service",
    ])
      expect(unit.split("\n")).toContain(line);
    expect(unit).toMatch(/^Environment=PATH=\/srv\/dcabsm\/instances\/%i\/release\/node\/bin:/m);
    expect(unit).not.toContain("MemoryDenyWriteExecute=yes");
  });

  it("writes the Nightly timer and service, and enables the timer", async () => {
    expect(await setup(fakeHost())).toBe(0);
    const timer = await read(TIMER);
    expect(timer).toContain("OnCalendar=*-*-* 03:30:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).not.toMatch(/RandomizedDelaySec=[1-9]/);
    expect(await read("/etc/systemd/system/dcabsm-nightly.service")).toContain(
      "ExecStart=/usr/local/bin/dcabsm host nightly",
    );
    expect(systemctl()).toContain("enable dcabsm-nightly.timer");
  });

  it("writes the conf.d include and the catch-all, checks nginx -t, starts and enables Nginx", async () => {
    expect(await setup(fakeHost())).toBe(0);
    expect(await read("/etc/nginx/conf.d/dcabsm.conf")).toContain(
      "include /srv/dcabsm/instances/*/nginx/vhost.conf;",
    );
    const def = await read(DEFAULT);
    expect(def).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
    expect(def).toContain("ssl_reject_handshake on;");
    const order = h.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    expect(order.lastIndexOf("nginx -t")).toBeGreaterThan(-1);
    expect(order.indexOf("systemctl enable nginx")).toBeGreaterThan(order.lastIndexOf("nginx -t"));
  });

  it("skips the catch-all when another default server is on 443, and never edits that file", async () => {
    h = await harness({ setUp: false });
    const other = at("/etc/nginx/sites-enabled/mine");
    await mkdir(dirname(other), { recursive: true });
    const text = "server { listen 443 ssl default_server; # mine\n}\n";
    await writeFile(other, text);
    expect(await rerun()).toBe(0);
    expect(await pathExists(at(DEFAULT))).toBe(false);
    expect(await readFile(other, "utf8")).toBe(text);
    expect(await pathExists(at("/etc/nginx/conf.d/dcabsm.conf"))).toBe(true);
  });

  it("records a hash of each file it wrote", async () => {
    expect(await setup(fakeHost())).toBe(0);
    const hashes = (await config()).ownedFiles;
    expect(Object.keys(hashes).sort()).toEqual([
      DEFAULT,
      "/etc/nginx/conf.d/dcabsm.conf",
      "/etc/systemd/system/dcabsm-nightly.service",
      TIMER,
      UNIT,
      "/usr/share/bash-completion/completions/dcabsm",
    ]);
    expect(hashes[UNIT]).toBe(hashOf(await read(UNIT)));
  });

  it("replaces a file that still matches its hash without asking", async () => {
    expect(await setup(fakeHost())).toBe(0);
    const old = "# older DCABSM output\n";
    await writeFile(at(TIMER), old);
    const cfg = await config();
    cfg.ownedFiles[TIMER] = hashOf(old);
    await writeFile(h.ctx.paths.hostConfig, JSON.stringify(cfg));
    expect(await rerun(["--yes"])).toBe(0);
    expect(await read(TIMER)).toContain("OnCalendar=");
    expect(h.asked).toEqual([]);
    expect(await pathExists(at("/etc/dcabsm/replaced"))).toBe(false);
  });

  it("without a terminal or --yes, stops before any change and lists edited files", async () => {
    expect(await setup(fakeHost())).toBe(0);
    await writeFile(at(UNIT), "edited\n");
    await writeFile(at(TIMER), "also edited\n");
    h.calls.length = 0;
    h.err.length = 0;
    expect(await rerun([])).toBe(2);
    expect(h.err.join("\n")).toContain(UNIT);
    expect(h.err.join("\n")).toContain(TIMER);
    expect(await read(UNIT)).toBe("edited\n");
    expect(systemctl()).toEqual([]);
  });

  it("with --yes and no terminal, replaces and saves the old copy", async () => {
    expect(await setup(fakeHost())).toBe(0);
    await writeFile(at(UNIT), "edited\n");
    expect(await rerun(["--yes"])).toBe(0);
    expect(await read(UNIT)).toContain("[Service]");
    const [stamp] = await readdir(at("/etc/dcabsm/replaced"));
    expect(stamp).toBe("20261109T120000Z");
    expect(await readFile(join(at("/etc/dcabsm/replaced"), stamp!, UNIT), "utf8")).toBe("edited\n");
    expect((await config()).ownedFiles[UNIT]).toBe(hashOf(await read(UNIT)));
  });

  it("on a terminal shows a diff and keeps on k, leaving the file and a warning", async () => {
    expect(await setup(fakeHost())).toBe(0);
    await writeFile(at(UNIT), "edited\n");
    h.ctx.io.interactive = true;
    h.answers.push("k", "y");
    expect(await rerun([])).toBe(0);
    expect(await read(UNIT)).toBe("edited\n");
    expect(h.out.some((l) => l.includes("- edited"))).toBe(true);
    expect(h.asked[0]).toContain(
      "replace (old copy saved to /etc/dcabsm/replaced/) or keep? [r/k]",
    );
    expect(h.out.some((l) => l.includes("Kept your edited") && l.includes(UNIT))).toBe(true);
  });

  it("on a terminal replaces on r", async () => {
    expect(await setup(fakeHost())).toBe(0);
    await writeFile(at(UNIT), "edited\n");
    h.ctx.io.interactive = true;
    h.answers.push("r", "y");
    expect(await rerun([])).toBe(0);
    expect(await read(UNIT)).toContain("[Service]");
  });

  it("stops without reloading when nginx -t fails after the change", async () => {
    const host = fakeHost();
    expect(await setup(host)).toBe(0);
    await writeFile(at("/etc/nginx/conf.d/dcabsm.conf"), "edited\n");
    host.nginxTest = { code: 1, stdout: "", stderr: "nginx: [emerg] bad\n" };
    h.calls.length = 0;
    expect(await rerun(["--yes"])).not.toBe(0);
    expect(systemctl()).not.toContain("reload nginx");
  });

  it("asks before starting an Nginx that was installed but stopped", async () => {
    const host = fakeHost();
    host.installed.add("nginx");
    host.installed.add("openssl");
    const base = host.run.bind(host);
    host.run = (c, a) =>
      c === "systemctl" && a[0] === "is-active" ? { code: 3, stdout: "", stderr: "" } : base(c, a);
    expect(await setup(host, [], { interactive: true, answers: ["y", "y"] })).toBe(0);
    expect(h.asked.some((q) => q.includes("Nginx is installed but stopped"))).toBe(true);
    expect(systemctl()).toContain("enable --now nginx");
  });

  it("is a no-op on a second run", async () => {
    expect(await setup(fakeHost())).toBe(0);
    h.out.length = 0;
    expect(await rerun([])).toBe(0);
    expect(h.out).toContain("Every check passes; nothing to do.");
  });
});

describe("nginx -t after a change (spec 10.5)", () => {
  const INCLUDE = "/etc/nginx/conf.d/dcabsm.conf";
  const bad = { code: 1, stdout: "", stderr: "nginx: [emerg] bad\n" };

  it("puts back the previous file, records no hash and does not reload when it fails", async () => {
    const host = fakeHost();
    expect(await setup(host)).toBe(0);
    const old = "# older DCABSM output\n";
    await writeFile(at(INCLUDE), old);
    const cfg = await config();
    cfg.ownedFiles[INCLUDE] = hashOf(old);
    await writeFile(h.ctx.paths.hostConfig, JSON.stringify(cfg));
    let tests = 0;
    const base = host.run.bind(host);
    host.run = (c, a) => (c === "nginx" && tests++ > 0 ? bad : base(c, a));
    h.calls.length = 0;
    h.err.length = 0;
    expect(await rerun(["--yes"])).toBe(1);
    expect(await read(INCLUDE)).toBe(old);
    expect((await config()).ownedFiles[INCLUDE]).toBe(hashOf(old));
    expect(systemctl()).not.toContain("reload nginx");
    expect(h.err[0]).toContain("nginx -t failed after the change: nginx: [emerg] bad");
  });

  it("removes newly created files and records no hash for them", async () => {
    const host = fakeHost();
    host.installed.add("nginx");
    host.installed.add("openssl");
    // The refusal check (10.3) passes; the test after the change fails.
    let tests = 0;
    const base = host.run.bind(host);
    host.run = (c, a) => (c === "nginx" && tests++ > 0 ? bad : base(c, a));
    expect(await setup(host)).toBe(1);
    expect(await pathExists(at(INCLUDE))).toBe(false);
    expect(await pathExists(at(DEFAULT))).toBe(false);
    const hashes = (await config()).ownedFiles ?? {};
    expect(hashes[INCLUDE]).toBeUndefined();
    expect(hashes[DEFAULT]).toBeUndefined();
    expect(systemctl()).not.toContain("reload nginx");
  });
});

describe("a re-run with nothing else to do", () => {
  it("still starts and enables a stopped Nginx, asking first", async () => {
    const host = fakeHost();
    expect(await setup(host)).toBe(0);
    const base = host.run.bind(host);
    host.run = (c, a) =>
      c === "systemctl" && a[0] === "is-active" ? { code: 3, stdout: "", stderr: "" } : base(c, a);
    h.ctx.io.interactive = true;
    h.answers.push("y");
    h.calls.length = 0;
    expect(await rerun([])).toBe(0);
    expect(h.asked.some((q) => q.includes("Nginx is installed but stopped"))).toBe(true);
    expect(systemctl()).toContain("enable --now nginx");
  });

  it("enables an Nginx that is running but not enabled", async () => {
    const host = fakeHost();
    expect(await setup(host)).toBe(0);
    const base = host.run.bind(host);
    host.run = (c, a) =>
      c === "systemctl" && a[0] === "is-enabled" ? { code: 1, stdout: "", stderr: "" } : base(c, a);
    h.calls.length = 0;
    expect(await rerun(["--yes"])).toBe(0);
    expect(systemctl()).toContain("enable --now nginx");
  });
});

describe("IPv6 listeners (spec 5.2, 5.3)", () => {
  it("leaves them out of the catch-all when the Host has no IPv6", async () => {
    expect(await setup(fakeHost())).toBe(0);
    const def = await read(DEFAULT);
    expect(def).toContain("listen 443 ssl default_server;");
    expect(def).not.toContain("[::]");
  });

  it("adds them when the Host has IPv6", async () => {
    const host = fakeHost();
    h = await harness({ setUp: false, runner: (c, a) => host.run(c, a) });
    await mkdir(at("/proc/net"), { recursive: true });
    await writeFile(
      at("/proc/net/if_inet6"),
      "00000000000000000000000000000001 01 80 10 80       lo\n",
    );
    expect(await rerun()).toBe(0);
    expect(await read(DEFAULT)).toContain("listen [::]:443 ssl default_server;");
  });
});

describe("host setup takes the lock (spec 10.2 step 1)", () => {
  it("fails at once when another command holds it", async () => {
    const host = fakeHost();
    h = await harness({ setUp: false, runner: (c, a) => host.run(c, a) });
    await mkdir(dirname(h.ctx.paths.lock), { recursive: true });
    await writeFile(
      h.ctx.paths.lock,
      JSON.stringify({ pid: process.pid, command: "dcabsm other" }),
    );
    expect(await rerun()).toBe(1);
    expect(h.err[0]).toContain("Another dcabsm command is running");
    expect(h.calls.filter((c) => c.command === "env")).toEqual([]);
  });
});
