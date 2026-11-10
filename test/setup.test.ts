import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { completionScript } from "../src/completion.ts";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { nginxOrgInPolicy, parseListeners } from "../src/host/checks.ts";
import { harness, UBUNTU_2404, type Harness, type HarnessOptions } from "./helpers.ts";
import { fakeHost, NGINX_ORG_POLICY, type FakeHost } from "./fakehost.ts";

let h: Harness;
afterEach(() => h.cleanup());

async function setup(
  host: FakeHost,
  args: string[] = ["--yes"],
  opts: HarnessOptions = {},
): Promise<number> {
  h = await harness({ setUp: false, runner: (c, a) => host.run(c, a), ...opts });
  return run(["host", "setup", ...args], h.ctx);
}

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;
const readConfig = async () => JSON.parse(await readFile(h.ctx.paths.hostConfig, "utf8"));
const pathExists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("host setup and the completion script", () => {
  it("writes it as an owned file with its hash recorded", async () => {
    expect(await setup(fakeHost())).toBe(0);
    const logical = "/usr/share/bash-completion/completions/dcabsm";
    const text = await readFile(h.ctx.paths.under(logical), "utf8");
    expect(text).toBe(completionScript());
    expect((await readConfig()).ownedFiles[logical]).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
  });
});

describe("host setup on a clean Debian 13 VM", () => {
  it("installs nginx and openssl, then leaves the Host tree and dcabsm.json", async () => {
    const host = fakeHost();
    expect(await setup(host)).toBe(0);

    expect(host.installed).toEqual(new Set(["nginx", "openssl"]));
    expect(h.calls.find((c) => c.command === "env" && c.args.includes("apt-get"))?.args).toEqual([
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      "nginx",
      "openssl",
    ]);

    const p = h.ctx.paths;
    for (const dir of [p.srv, p.node, p.releases, p.instances, p.acme])
      expect(await modeOf(dir)).toBe(0o755);
    expect(await modeOf(p.etc)).toBe(0o700);
    expect(await modeOf(p.under("/srv/dcabsm/backups"))).toBe(0o700);
    expect(await modeOf(p.hostConfig)).toBe(0o600);
    expect(await readConfig()).toMatchObject({
      layout: 1,
      backupDir: "/srv/dcabsm/backups",
      nightlyTime: "03:30",
      keep: { scheduled: 14, "pre-upgrade": 5, "pre-restore": 5, "pre-clone": 5 },
    });
    expect((await readConfig()).unsupportedHost).toBeUndefined();
  });

  it("shows the checks, then the plan, and asks once", async () => {
    const host = fakeHost();
    await setup(host, [], { interactive: true, answers: ["y"] });
    expect(h.asked).toEqual(["Go ahead? [y/N] "]);
    expect(h.out).toContain("Setup checks (nothing changes yet)");
    expect(h.out).toContain("  ✓ Debian 13 (trixie), amd64");
    expect(h.out).toContain("  · Install nginx and openssl with apt");
    expect(h.out).toContain("  · Backups in /srv/dcabsm/backups");
  });

  it("changes nothing when the plan is declined", async () => {
    const host = fakeHost();
    expect(await setup(host, [], { interactive: true, answers: ["n"] })).toBe(1);
    expect(h.out.at(-1)).toBe("Cancelled. Nothing changed.");
    expect(host.installed.size).toBe(0);
    expect(await pathExists(h.ctx.paths.etc)).toBe(false);
  });

  it("refuses with no terminal and no --yes, before any change", async () => {
    const host = fakeHost();
    expect(await setup(host, [])).toBe(2);
    expect(h.err).toEqual([
      "error: No terminal to confirm on.",
      "  Re-run with --yes to proceed without asking.",
    ]);
    expect(host.installed.size).toBe(0);
  });

  it("puts Backups where --backup-dir says, with no prompt", async () => {
    expect(await setup(fakeHost(), ["--yes", "--backup-dir", "/mnt/backups/dcabsm"])).toBe(0);
    expect((await readConfig()).backupDir).toBe("/mnt/backups/dcabsm");
    expect(await modeOf(h.ctx.paths.under("/mnt/backups/dcabsm"))).toBe(0o700);
    expect(await pathExists(h.ctx.paths.under("/srv/dcabsm/backups"))).toBe(false);
  });

  it("rejects a relative --backup-dir and an unknown flag with exit 2", async () => {
    expect(await setup(fakeHost(), ["--yes", "--backup-dir", "backups"])).toBe(2);
    expect(await run(["host", "setup", "--bogus"], h.ctx)).toBe(2);
  });

  it("logs one journald line for the changing command", async () => {
    await setup(fakeHost());
    expect(h.calls.at(-1)).toEqual({ command: "logger", args: ["-t", "dcabsm", "host setup: ok"] });
  });
});

describe("host setup re-run", () => {
  it("does nothing when everything is in place", async () => {
    const host = fakeHost();
    await setup(host);
    const before = await readFile(h.ctx.paths.hostConfig, "utf8");
    h.out.length = 0;
    h.calls.length = 0;
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect(h.out.at(-1)).toBe("Every check passes; nothing to do.");
    expect(h.calls.some((c) => c.command === "env" && c.args.includes("apt-get"))).toBe(false);
    expect(await readFile(h.ctx.paths.hostConfig, "utf8")).toBe(before);
  });

  it("recreates only what is missing and never touches an Instance", async () => {
    const host = fakeHost();
    await setup(host);
    const instance = h.ctx.paths.instances + "/family/data";
    await mkdir(instance, { recursive: true });
    await writeFile(instance + "/account.sqlite", "mine");
    await (await import("node:fs/promises")).rm(h.ctx.paths.acme, { recursive: true });
    host.installed.delete("openssl");
    h.calls.length = 0;

    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect(await pathExists(h.ctx.paths.acme)).toBe(true);
    expect(
      h.calls.find((c) => c.command === "env" && c.args.includes("apt-get"))?.args.slice(-1),
    ).toEqual(["openssl"]);
    expect(await readFile(instance + "/account.sqlite", "utf8")).toBe("mine");
  });

  it("carries on after apt failed, then finishes", async () => {
    const host = fakeHost({
      aptResult: { code: 100, stdout: "", stderr: "E: Unable to locate package nginx" },
    });
    expect(await setup(host)).toBe(1);
    expect(h.err).toEqual([
      "error: apt could not install nginx and openssl: E: Unable to locate package nginx",
      "  Fix the problem, then run again: sudo dcabsm host setup",
    ]);
    expect(await pathExists(h.ctx.paths.hostConfig)).toBe(false);

    host.aptResult = { code: 0, stdout: "", stderr: "" };
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect(await pathExists(h.ctx.paths.hostConfig)).toBe(true);
  });

  it("refuses a different --backup-dir, keeping the stored one", async () => {
    await setup(fakeHost());
    h.err.length = 0;
    expect(await run(["host", "setup", "--yes", "--backup-dir", "/mnt/other"], h.ctx)).toBe(2);
    expect(h.err[0]).toBe("error: Backups are already in /srv/dcabsm/backups, not /mnt/other.");
    expect((await readConfig()).backupDir).toBe("/srv/dcabsm/backups");
  });

  it("accepts the same --backup-dir again", async () => {
    await setup(fakeHost(), ["--yes", "--backup-dir", "/mnt/b"]);
    expect(await run(["host", "setup", "--yes", "--backup-dir", "/mnt/b"], h.ctx)).toBe(0);
  });
});

describe("refusals change nothing and exit 2", () => {
  const untouched = async (host: FakeHost) => {
    expect(host.installed.size).toBe(0);
    expect(await pathExists(h.ctx.paths.etc)).toBe(false);
    expect(await pathExists(h.ctx.paths.srv)).toBe(false);
    expect(h.calls.some((c) => c.command === "env" && c.args.includes("apt-get"))).toBe(false);
  };

  it("an OS that is not in the table", async () => {
    const host = fakeHost();
    expect(
      await setup(host, ["--yes"], {
        osRelease: 'ID=fedora\nVERSION_ID="41"\nPRETTY_NAME="Fedora Linux 41"\n',
      }),
    ).toBe(2);
    expect(h.err[0]).toBe("error: Fedora Linux 41 on amd64 is not a supported Host.");
    expect(h.err[1]).toContain("Supported: Debian 13, Ubuntu 24.04 LTS, Ubuntu 26.04 LTS");
    await untouched(host);
  });

  it("an architecture that is not in the table", async () => {
    expect(await setup(fakeHost(), ["--yes"], { arch: "riscv64" })).toBe(2);
    expect(h.err[0]).toBe(
      "error: Debian GNU/Linux 13 (trixie) on riscv64 is not a supported Host.",
    );
  });

  it("accepts Ubuntu 24.04 on arm64", async () => {
    expect(await setup(fakeHost(), ["--yes"], { osRelease: UBUNTU_2404, arch: "arm64" })).toBe(0);
    expect(h.out).toContain("  ✓ Ubuntu 24.04 LTS (noble), arm64");
  });

  it("no os-release at all", async () => {
    expect(await setup(fakeHost(), ["--yes"], { osRelease: null })).toBe(2);
  });

  it("the Proxmox VE host", async () => {
    const host = fakeHost();
    h = await harness({ setUp: false, runner: (c, a) => host.run(c, a) });
    await mkdir(dirname(h.ctx.paths.under("usr/bin/pveversion")), { recursive: true });
    await writeFile(h.ctx.paths.under("usr/bin/pveversion"), "");
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(2);
    expect(h.err).toEqual([
      "error: This is the Proxmox VE host itself.",
      "  Install DCABSM in a virtual machine on it instead.",
    ]);
    await untouched(host);
  });

  it("a container", async () => {
    const host = fakeHost({ container: "lxc" });
    expect(await setup(host)).toBe(2);
    expect(h.err[0]).toBe("error: This Host is a container (lxc).");
    await untouched(host);
  });

  it("nginx.org's package as apt's candidate", async () => {
    const host = fakeHost({ policy: NGINX_ORG_POLICY });
    expect(await setup(host)).toBe(2);
    expect(h.err[0]).toBe("error: Nginx comes from nginx.org's package.");
    await untouched(host);
  });

  it("another process on port 80, naming it", async () => {
    const host = fakeHost({
      listeners: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("apache2",pid=812,fd=4))\n',
    });
    expect(await setup(host)).toBe(2);
    expect(h.err[0]).toBe("error: Port 80 is already in use by apache2 (pid 812).");
    await untouched(host);
  });

  it("a source-built nginx on port 443", async () => {
    const host = fakeHost({
      listeners: 'LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=77,fd=6))\n',
      exe: { 77: "/usr/local/sbin/nginx" },
    });
    expect(await setup(host)).toBe(2);
    expect(h.err[0]).toBe("error: Port 443 is already in use by nginx (pid 77).");
  });

  it("an existing Nginx config that fails nginx -t", async () => {
    const host = fakeHost({
      nginxTest: {
        code: 1,
        stdout: "",
        stderr: 'nginx: [emerg] unknown directive "foo" in /etc/nginx/nginx.conf:3\n',
      },
    });
    host.installed.add("nginx");
    expect(await setup(host)).toBe(2);
    expect(h.err[0]).toBe(
      'error: The existing Nginx config fails nginx -t: nginx: [emerg] unknown directive "foo" in /etc/nginx/nginx.conf:3',
    );
    await untouched({ ...host, installed: new Set() });
  });

  it("allows the distro's own running Nginx on 80 and 443", async () => {
    const host = fakeHost({
      listeners:
        'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=77,fd=6))\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=77,fd=7))\n',
      exe: { 77: "/usr/sbin/nginx" },
    });
    host.installed.add("nginx");
    expect(await setup(host)).toBe(0);
  });

  it("prints every refusal's reason", async () => {
    const host = fakeHost({ container: "docker", policy: NGINX_ORG_POLICY });
    expect(await setup(host)).toBe(2);
    expect(h.err[0]).toBe("error: This Host is a container (docker).");
    expect(h.out).toContain("  ✗ Nginx comes from nginx.org's package.");
  });
});

describe("overrides and the Unsupported Host mark", () => {
  it("DCABSM_ALLOW_CONTAINER=1 passes with a warning, a log line and a permanent mark", async () => {
    const host = fakeHost({ container: "docker" });
    expect(await setup(host, ["--yes"], { env: { DCABSM_ALLOW_CONTAINER: "1" } })).toBe(0);
    expect(h.out.join("\n")).toContain(
      "! UNSUPPORTED: This Host is a container (docker). DCABSM_ALLOW_CONTAINER=1 lets setup go on. You are on your own.",
    );
    expect(h.calls.map((c) => c.args[2])).toContain(
      "host setup: override DCABSM_ALLOW_CONTAINER=1 used",
    );
    expect((await readConfig()).unsupportedHost).toEqual({
      since: "2026-11-09",
      overrides: ["DCABSM_ALLOW_CONTAINER"],
    });
  });

  it("DCABSM_ALLOW_NGINX_ORG=1 passes too", async () => {
    const host = fakeHost({ policy: NGINX_ORG_POLICY });
    expect(await setup(host, ["--yes"], { env: { DCABSM_ALLOW_NGINX_ORG: "1" } })).toBe(0);
    expect((await readConfig()).unsupportedHost.overrides).toEqual(["DCABSM_ALLOW_NGINX_ORG"]);
  });

  it("only the value 1 counts", async () => {
    expect(
      await setup(fakeHost({ container: "lxc" }), ["--yes"], {
        env: { DCABSM_ALLOW_CONTAINER: "yes" },
      }),
    ).toBe(2);
  });

  it("the mark outlives the override and warns again on every run", async () => {
    const host = fakeHost({ container: "docker" });
    await setup(host, ["--yes"], { env: { DCABSM_ALLOW_CONTAINER: "1" } });
    host.container = "none";
    h.out.length = 0;
    h.err.length = 0;
    h.ctx.env = {};
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect((await readConfig()).unsupportedHost.since).toBe("2026-11-09");
    // another command still shows the banner
    h.err.length = 0;
    await run(["instance", "list"], h.ctx);
    expect(h.err[0]).toBe(
      "UNSUPPORTED HOST: a safety check was overridden on 2026-11-09. You are on your own.",
    );
  });

  it("a re-run with a second override adds to the mark and keeps the date", async () => {
    const host = fakeHost({ container: "docker" });
    await setup(host, ["--yes"], { env: { DCABSM_ALLOW_CONTAINER: "1" } });
    h.ctx.now = () => new Date("2027-01-01T00:00:00Z");
    host.policy = NGINX_ORG_POLICY;
    h.ctx.env = { DCABSM_ALLOW_CONTAINER: "1", DCABSM_ALLOW_NGINX_ORG: "1" };
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect((await readConfig()).unsupportedHost).toEqual({
      since: "2026-11-09",
      overrides: ["DCABSM_ALLOW_CONTAINER", "DCABSM_ALLOW_NGINX_ORG"],
    });
  });
});

describe("a Host that later runs an unsupported OS", () => {
  it("lets other commands run with a warning and a log line; only setup refuses", async () => {
    const host = fakeHost();
    await setup(host);
    await writeFile(
      h.ctx.paths.osRelease,
      'ID=fedora\nVERSION_ID="41"\nPRETTY_NAME="Fedora Linux 41"\n',
    );
    h.err.length = 0;
    h.calls.length = 0;

    expect(await run(["cert", "test"], h.ctx)).toBe(1); // reaches the handler: "not built yet"
    expect(h.err[0]).toBe(
      "! Fedora Linux 41 on amd64 is not a supported Host. Backup and restore still work, but you are on your own.",
    );
    expect(h.calls[0]?.args[2]).toBe("host check: unsupported OS Fedora Linux 41 on amd64");

    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(2);
  });

  it("stays quiet on a supported OS", async () => {
    await setup(fakeHost());
    h.err.length = 0;
    await run(["cert", "test"], h.ctx);
    expect(h.err).toEqual(["error: cert test is not built yet.", "  See: dcabsm help"]);
  });
});

describe("robustness", () => {
  it("refuses a corrupt dcabsm.json instead of rewriting it", async () => {
    const host = fakeHost();
    await setup(host);
    await writeFile(h.ctx.paths.hostConfig, "{oops");
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(2);
    expect(await readFile(h.ctx.paths.hostConfig, "utf8")).toBe("{oops");
  });

  it("accepts the distro's Nginx whose binary was replaced by an upgrade", async () => {
    const host = fakeHost({
      listeners: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=77,fd=6))\n',
      exe: { 77: "/usr/sbin/nginx (deleted)" },
    });
    host.installed.add("nginx");
    expect(await setup(host)).toBe(0);
  });
});

describe("check parsers", () => {
  it("spots nginx.org only on the installed or candidate version", () => {
    expect(nginxOrgInPolicy(NGINX_ORG_POLICY)).toBe(true);
    const older = NGINX_ORG_POLICY.replace("Candidate: 1.28.0-1~trixie", "Candidate: 1.26.3-3");
    expect(nginxOrgInPolicy(older)).toBe(false);
    expect(nginxOrgInPolicy("N: Unable to locate package nginx")).toBe(false);
  });

  it("reads only ports 80 and 443 out of ss", () => {
    const out = [
      'LISTEN 0 4096 127.0.0.1:5006 0.0.0.0:* users:(("node",pid=9,fd=18))',
      "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*",
      'LISTEN 0 128 [::]:443 [::]:* users:(("caddy",pid=5,fd=3))',
    ].join("\n");
    expect(parseListeners(out)).toEqual([
      { port: 80, process: undefined, pid: undefined },
      { port: 443, process: "caddy", pid: 5 },
    ]);
  });
});
