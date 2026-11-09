import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { hashOf } from "../src/host/owned.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { fakeNet } from "./fakenet.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

/** A Host that `host setup` has just finished with. */
async function setUpHost(host: FakeHost = fakeHost(), opts: HarnessOptions = {}) {
  h = await harness({ setUp: false, runner: (c, a) => host.run(c, a), ...opts });
  expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
  h.out.length = 0;
  h.calls.length = 0;
}
const at = (logical: string) => h.ctx.paths.under(logical);
const text = () => h.out.join("\n");
const doctor = (...args: string[]) => run(["host", "doctor", ...args], h.ctx);

describe("host doctor on a Host setup has just finished with", () => {
  it("is read-only, passes every check and exits 0", async () => {
    await setUpHost();
    expect(await doctor()).toBe(0);
    expect(h.out[0]).toBe("Read-only. Takes no lock.");
    expect(h.out).toContain("  ✓ Debian 13 (trixie), amd64");
    expect(h.out.some((l) => l.includes("✗") || l.includes("!"))).toBe(false);
  });
});

describe("Host settings and Nginx", () => {
  it("shows the Unsupported Host mark as a failure, exit 2", async () => {
    await setUpHost();
    const config = JSON.parse(await readFile(h.ctx.paths.hostConfig, "utf8"));
    config.unsupportedHost = { since: "2026-10-02", overrides: ["DCABSM_ALLOW_CONTAINER"] };
    await writeFile(h.ctx.paths.hostConfig, JSON.stringify(config));
    expect(await doctor()).toBe(2);
    expect(h.out).toContain(
      "  ✗ UNSUPPORTED HOST: a safety check was overridden on 2026-10-02. You are on your own.",
    );
  });

  it("fails on an OS that is no longer supported", async () => {
    await setUpHost();
    await writeFile(
      h.ctx.paths.osRelease,
      'PRETTY_NAME="Fedora Linux 41"\nID=fedora\nVERSION_ID=41\n',
    );
    expect(await doctor()).toBe(2);
    expect(text()).toContain("✗ Fedora Linux 41 on amd64 is not a supported Host.");
  });

  it("fails when something foreign listens on 443", async () => {
    const host = fakeHost();
    await setUpHost(host);
    host.listeners = 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("caddy",pid=77,fd=7))\n';
    expect(await doctor()).toBe(2);
    expect(text()).toContain("✗ Port 443 is already in use by caddy (pid 77).");
  });

  it("fails when nginx -t fails", async () => {
    const host = fakeHost();
    await setUpHost(host);
    host.nginxTest = { code: 1, stdout: "", stderr: "nginx: [emerg] unknown directive" };
    expect(await doctor()).toBe(2);
    expect(text()).toContain("✗ The existing Nginx config fails nginx -t: nginx: [emerg] unknown");
  });

  it("fails on a stopped Nginx, and --fix starts and enables it", async () => {
    const host = fakeHost();
    await setUpHost(host);
    host.active.delete("nginx");
    host.enabled.delete("nginx");
    expect(await doctor()).toBe(2);
    expect(text()).toContain("✗ Nginx is not running and not enabled at boot  (host doctor --fix)");

    expect(await doctor("--fix", "--yes")).toBe(0);
    expect(host.active.has("nginx") && host.enabled.has("nginx")).toBe(true);
    expect(text()).toContain("✓ Nginx running and enabled");
  });

  it("notes another default server on 443", async () => {
    await setUpHost();
    await mkdir(at("/etc/nginx/sites-enabled"), { recursive: true });
    await writeFile(
      at("/etc/nginx/sites-enabled/other"),
      "server { listen 443 ssl default_server; }\n",
    );
    expect(await doctor()).toBe(0);
    expect(text()).toContain("· Another default server on 443");
  });
});

const UNIT = "/etc/systemd/system/dcabsm@.service";
const NGINX_INCLUDE = "/etc/nginx/conf.d/dcabsm.conf";
const read = (logical: string) => readFile(at(logical), "utf8");
const systemctl = () =>
  h.calls.filter((c) => c.command === "systemctl").map((c) => c.args.join(" "));

describe("owned files and the timer", () => {
  it("warns about a missing file, exit 1, and --fix writes it back", async () => {
    await setUpHost();
    const original = await read(UNIT);
    await rm(at(UNIT));
    expect(await doctor()).toBe(1);
    expect(text()).toContain(`! ${UNIT} is missing  (host doctor --fix)`);
    expect(await readdir(at("/etc/systemd/system"))).not.toContain("dcabsm@.service");

    expect(await doctor("--fix", "--yes")).toBe(0);
    expect(await read(UNIT)).toBe(original);
    expect(systemctl()).toContain("daemon-reload");
  });

  it("replaces DCABSM's own older output without a diff", async () => {
    await setUpHost();
    const original = await read(UNIT);
    const older = "# an older DCABSM wrote this\n";
    await writeFile(at(UNIT), older);
    const config = JSON.parse(await readFile(h.ctx.paths.hostConfig, "utf8"));
    config.ownedFiles[UNIT] = hashOf(older);
    await writeFile(h.ctx.paths.hostConfig, JSON.stringify(config));

    expect(await doctor()).toBe(1);
    expect(await doctor("--fix", "--yes")).toBe(0);
    expect(await read(UNIT)).toBe(original);
    expect(await readdir(at("/etc/dcabsm"))).not.toContain("replaced");
  });

  it("shows a diff for an edited file and saves the old copy when it replaces it", async () => {
    await setUpHost(fakeHost(), { interactive: true, answers: ["f"] });
    const original = await read(UNIT);
    await writeFile(at(UNIT), original.replace("RestartSec=5", "RestartSec=30"));

    expect(await doctor()).toBe(1);
    expect(text()).toContain(`! ${UNIT} was edited by hand  (host doctor --fix)`);
    h.out.length = 0;

    expect(await doctor("--fix")).toBe(0);
    expect(h.asked).toEqual(["fix / skip / all? [f/s/a] "]);
    expect(h.out).toContain("    - RestartSec=30");
    expect(h.out).toContain("    + RestartSec=5");
    expect(await read(UNIT)).toBe(original);
    const [stamp] = await readdir(at("/etc/dcabsm/replaced"));
    expect(stamp).toBe("20261109T120000Z");
    expect(await read(`/etc/dcabsm/replaced/${stamp}${UNIT}`)).toContain("RestartSec=30");
  });

  it("leaves an edited file alone on skip, and keeps warning", async () => {
    await setUpHost(fakeHost(), { interactive: true, answers: ["s"] });
    const edited = (await read(UNIT)).replace("RestartSec=5", "RestartSec=30");
    await writeFile(at(UNIT), edited);
    expect(await doctor("--fix")).toBe(1);
    expect(await read(UNIT)).toBe(edited);
    expect(text()).toContain(`! ${UNIT} was edited by hand`);
  });

  it("answers all for the rest of the problems", async () => {
    await setUpHost(fakeHost(), { interactive: true, answers: ["a"] });
    await rm(at(UNIT));
    await rm(at(NGINX_INCLUDE));
    expect(await doctor("--fix")).toBe(0);
    expect(h.asked).toHaveLength(1);
    expect(await read(UNIT)).toContain("[Service]");
    expect(await read(NGINX_INCLUDE)).toContain("include");
  });

  it("puts an Nginx file back when nginx -t fails after the fix", async () => {
    const host = fakeHost();
    await setUpHost(host);
    const edited = "# hand-made\n";
    await writeFile(at(NGINX_INCLUDE), edited);
    host.nginxTest = { code: 1, stdout: "", stderr: "nginx: [emerg] bad" };
    // The Nginx config check also fails now, so the exit code is 2 whatever the fix does.
    expect(await doctor("--fix", "--yes")).toBe(2);
    expect(await read(NGINX_INCLUDE)).toBe(edited);
    expect(text()).toContain("Could not fix");
  });

  it("fixes a timer that is not enabled", async () => {
    const host = fakeHost();
    await setUpHost(host);
    host.enabled.delete("dcabsm-nightly.timer");
    expect(await doctor()).toBe(1);
    expect(text()).toContain("! dcabsm-nightly.timer is not enabled  (host doctor --fix)");
    expect(await doctor("--fix", "--yes")).toBe(0);
    expect(host.enabled.has("dcabsm-nightly.timer")).toBe(true);
  });

  it("refuses --fix with no terminal and no --yes, changing nothing", async () => {
    await setUpHost();
    await rm(at(UNIT));
    expect(await doctor("--fix")).toBe(2);
    expect(h.err).toEqual([
      "error: No terminal to confirm on.",
      "  Re-run with --yes to proceed without asking.",
    ]);
    expect(await readdir(at("/etc/systemd/system"))).not.toContain("dcabsm@.service");
  });
});

const modeOf = async (logical: string) => (await stat(at(logical))).mode & 0o777;
const exists = (logical: string) =>
  stat(at(logical)).then(
    () => true,
    () => false,
  );

describe("ownership and modes", () => {
  it("warns about wrong modes and --fix restores them", async () => {
    await setUpHost();
    await mkdir(at("/srv/dcabsm/backups/family"), { recursive: true });
    await writeFile(at("/srv/dcabsm/backups/family/scheduled.tar.zst"), "x", { mode: 0o644 });
    await chmod(at("/srv/dcabsm/instances"), 0o777);
    await chmod(at("/etc/dcabsm"), 0o755);
    await chmod(h.ctx.paths.hostConfig, 0o644);
    await chmod(at("/srv/dcabsm/releases/26.11.1"), 0o755);

    expect(await doctor()).toBe(1);
    expect(text()).toContain("! /srv/dcabsm/instances has mode 777, not 755  (host doctor --fix)");
    expect(text()).toContain("! /etc/dcabsm/dcabsm.json has mode 644, not 600");
    expect(text()).toContain("! /srv/dcabsm/releases/26.11.1 has mode 755, not read-only");
    expect(text()).toContain(
      "! /srv/dcabsm/backups/family/scheduled.tar.zst has mode 644, not 600",
    );

    expect(await doctor("--fix", "--yes")).toBe(0);
    expect(await modeOf("/srv/dcabsm/instances")).toBe(0o755);
    expect(await modeOf("/etc/dcabsm")).toBe(0o700);
    expect(await modeOf("/etc/dcabsm/dcabsm.json")).toBe(0o600);
    expect(await modeOf("/srv/dcabsm/releases/26.11.1")).toBe(0o555);
    expect(await modeOf("/srv/dcabsm/backups/family/scheduled.tar.zst")).toBe(0o600);
    expect(text()).toContain("✓ Ownership and modes");
  });
});

describe("leftovers", () => {
  it("deletes leftover .installing-* folders with --fix", async () => {
    await setUpHost();
    await mkdir(at("/srv/dcabsm/releases/.installing-26.11.2/node_modules"), { recursive: true });
    await mkdir(at("/srv/dcabsm/node/.installing-24.11.2"), { recursive: true });
    expect(await doctor()).toBe(1);
    expect(text()).toContain(
      "! Leftover .installing-26.11.2 folder in /srv/dcabsm/releases  (host doctor --fix)",
    );
    expect(text()).toContain("! Leftover .installing-24.11.2 folder in /srv/dcabsm/node");
    expect(await doctor("--fix", "--yes")).toBe(0);
    expect(await exists("/srv/dcabsm/releases/.installing-26.11.2")).toBe(false);
    expect(await exists("/srv/dcabsm/node/.installing-24.11.2")).toBe(false);
  });

  it("deletes dcabsm-* accounts that have no Instance, and only those", async () => {
    await setUpHost();
    await mkdir(at("/srv/dcabsm/instances/family"), { recursive: true });
    await writeFile(
      at("/etc/passwd"),
      "root:x:0:0::/root:/bin/bash\ndcabsm-family:x:990:990::/nonexistent:/usr/sbin/nologin\n" +
        "dcabsm-ghost:x:991:991::/nonexistent:/usr/sbin/nologin\n",
    );
    expect(await doctor()).toBe(1);
    expect(text()).toContain("! Account dcabsm-ghost has no Instance  (host doctor --fix)");
    expect(text()).not.toContain("dcabsm-family");
    h.calls.length = 0;
    await doctor("--fix", "--yes");
    expect(h.calls.filter((c) => c.command === "userdel").map((c) => c.args)).toEqual([
      ["dcabsm-ghost"],
    ]);
  });

  it("lists .removed- Backup folders with their size, as a note", async () => {
    await setUpHost();
    const dir = "/srv/dcabsm/backups/family.removed-20261101T000000Z";
    await mkdir(at(dir), { recursive: true, mode: 0o700 });
    await writeFile(at(`${dir}/final.tar.zst`), Buffer.alloc(2048), { mode: 0o600 });
    expect(await doctor()).toBe(0);
    expect(text()).toContain(`· ${dir} holds 2.0 KB; deleting it is a Manual System Admin task`);
  });
});

describe("Backups and the rest of the Host", () => {
  it("warns when Backups share a disk with Instance data", async () => {
    await setUpHost(fakeHost({ backupDevice: "/dev/vda1" }));
    expect(await doctor()).toBe(1);
    expect(text()).toContain("! Backups share a disk with Instance data (/dev/vda1)");
  });

  it("notes a missing bash-completion package", async () => {
    const host = fakeHost();
    await setUpHost(host);
    expect(await doctor()).toBe(0);
    expect(text()).toContain("· The bash-completion package is not installed");
    host.installed.add("bash-completion");
    await doctor();
    expect(text()).toContain("✓ bash-completion installed");
  });

  const UFW_NO_443 =
    "Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n";
  it("warns about a firewall without 443 and never changes it", async () => {
    await setUpHost(fakeHost({ ufw: UFW_NO_443 }));
    expect(await doctor("--fix", "--yes")).toBe(1);
    expect(text()).toContain(
      "! Firewall active without 443 allowed: manual System Admin task, e.g. ufw allow 443/tcp",
    );
    expect(h.calls.filter((c) => c.command === "ufw").map((c) => c.args)).toEqual([
      ["status"],
      ["status"],
    ]);
  });

  it("passes a firewall that allows 80 and 443", async () => {
    await setUpHost(
      fakeHost({ ufw: "Status: active\n\n80,443/tcp                  ALLOW       Anywhere\n" }),
    );
    await doctor();
    expect(text()).toContain("✓ Firewall allows 80 and 443");
  });
});

describe("Releases and Node", () => {
  it("fails a Release whose native modules do not load, pointing to instance upgrade", async () => {
    const net = fakeNet();
    await setUpHost(fakeHost(), { net });
    net.nativeFails = true;
    expect(await doctor()).toBe(2);
    expect(text()).toContain(
      "✗ Release 26.11.1 does not load its native modules: run sudo dcabsm instance upgrade",
    );
  });

  it("notes a newer Node patch, pointing to release update-node", async () => {
    const net = fakeNet();
    await setUpHost(fakeHost(), { net });
    net.index.unshift({ version: "v24.11.2", lts: "Krypton" });
    expect(await doctor()).toBe(0);
    expect(text()).toContain(
      "· Node 24.11.2 is available (runtime on 24.11.1): sudo dcabsm release update-node",
    );
  });

  it("warns about a Node major that is end of life", async () => {
    const net = fakeNet();
    await setUpHost(fakeHost(), { net });
    net.nodeEnd["v24"] = "2026-10-01";
    expect(await doctor()).toBe(1);
    expect(text()).toContain("! Node 24 is end of life since 2026-10-01");
  });

  it("notes, without failing, when nodejs.org cannot be reached", async () => {
    const net = fakeNet();
    await setUpHost(fakeHost(), { net });
    net.offline = true;
    expect(await doctor()).toBe(0);
    expect(text()).toContain("· Could not look for Node patches or end of life");
  });
});

describe("the lock", () => {
  const holdLock = async (command: string) => {
    await mkdir(at("/run/lock"), { recursive: true });
    await writeFile(h.ctx.paths.lock, JSON.stringify({ pid: process.pid, command }));
  };

  it("says so when the lock is held, and still reads", async () => {
    await setUpHost();
    await holdLock("dcabsm instance upgrade --all");
    expect(await doctor()).toBe(0);
    expect(text()).toContain(
      `! The lock is held by pid ${process.pid} (dcabsm instance upgrade --all); doctor does not wait for it, and what it finds may change.`,
    );
    expect(await exists("/run/lock/dcabsm.lock")).toBe(true);
  });

  it("--fix refuses while another command holds the lock", async () => {
    await setUpHost();
    await holdLock("dcabsm x");
    expect(await doctor("--fix", "--yes")).toBe(1);
    expect(h.err[0]).toContain("Another dcabsm command is running");
  });

  it("takes no lock and logs nothing without --fix", async () => {
    await setUpHost();
    await doctor();
    expect(await exists("/run/lock/dcabsm.lock")).toBe(false);
    expect(h.calls.some((c) => c.command === "logger")).toBe(false);
  });
});
