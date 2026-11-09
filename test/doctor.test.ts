import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
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
    await writeFile(h.ctx.paths.osRelease, 'PRETTY_NAME="Fedora Linux 41"\nID=fedora\nVERSION_ID=41\n');
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
    await writeFile(at("/etc/nginx/sites-enabled/other"), "server { listen 443 ssl default_server; }\n");
    expect(await doctor()).toBe(0);
    expect(text()).toContain("· Another default server on 443");
  });
});
