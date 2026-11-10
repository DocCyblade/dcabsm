import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./helpers.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";

let h: Harness;
afterEach(() => h.cleanup());

type Appliance = "core" | "nodejs";

interface Options {
  version?: string;
  /** Installed packages. Default: the turnkey-* one matching the appliance. */
  packages?: string[];
  firstBoot?: "done" | "pending" | "fence";
  /** The three clashing pieces are in place. Default: yes. */
  pieces?: boolean;
  renewalJob?: boolean;
  interactive?: boolean;
  answers?: string[];
  setUp?: boolean;
}

const put = async (logical: string, text: string, mode = 0o644) => {
  const path = h.ctx.paths.under(logical);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode });
  await chmod(path, mode);
};

const hasEntry = (logical: string) =>
  lstat(h.ctx.paths.under(logical)).then(
    () => true,
    () => false,
  );

const modeOf = async (logical: string) => (await stat(h.ctx.paths.under(logical))).mode & 0o777;

const SITE = "/etc/nginx/sites-enabled/nodejs";
const JOB = "/etc/cron.daily/confconsole-dehydrated";

const restorePieces = async (host: FakeHost) => {
  await put("/etc/nginx/sites-available/nodejs", "server {}\n");
  await mkdir(h.ctx.paths.under("/etc/nginx/sites-enabled"), { recursive: true });
  await rm(h.ctx.paths.under(SITE), { force: true });
  await symlink("/etc/nginx/sites-available/nodejs", h.ctx.paths.under(SITE));
  host.enabled.add("pm2-node");
  host.active.add("pm2-node");
  await put(JOB, "#!/bin/sh\n", 0o755);
};

/** A TurnKey appliance after (or before) its first boot, as the faked runner and the temporary root show it. */
async function appliance(kind: Appliance, opts: Options = {}): Promise<FakeHost> {
  const host = fakeHost();
  for (const pkg of opts.packages ?? [`turnkey-${kind}-19.0`]) host.installed.add(pkg);
  const firstBoot = opts.firstBoot ?? "done";
  if (firstBoot === "fence") host.active.add("turnkey-init-fence");
  h = await harness({
    setUp: opts.setUp ?? false,
    interactive: opts.interactive,
    answers: opts.answers,
    runner: (c, a) => host.run(c, a),
  });
  await put("/etc/turnkey_version", `${opts.version ?? `turnkey-${kind}-19.0-trixie-amd64`}\n`);
  await put(
    "/etc/default/inithooks",
    `RUN_FIRSTBOOT=${firstBoot === "pending" ? "true" : "false"}\n`,
  );
  const pieces = opts.pieces ?? true;
  if (pieces && kind === "nodejs") await restorePieces(host);
  else if (opts.renewalJob) await put(JOB, "#!/bin/sh\n", 0o755);
  if (pieces && kind === "nodejs" && opts.renewalJob === false) await rm(h.ctx.paths.under(JOB));
  return host;
}

async function turnkey(
  kind: Appliance,
  args: string[],
  opts: Options = {},
): Promise<{ code: number; host: FakeHost }> {
  const host = await appliance(kind, opts);
  return { code: await run(args, h.ctx), host };
}

/** An appliance that setup has finished with, where the clashing pieces have then come back. */
async function setUpThenBack(kind: Appliance, opts: Options = {}): Promise<FakeHost> {
  const host = await appliance(kind, opts);
  expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
  await restorePieces(host);
  h.out.length = 0;
  h.asked.length = 0;
  return host;
}

describe("host setup on TurnKey Node.js", () => {
  it("disables the three pieces after one confirmation and deletes nothing", async () => {
    const { code, host } = await turnkey("nodejs", ["host", "setup"], {
      interactive: true,
      answers: ["y"],
    });
    expect(code).toBe(0);
    expect(h.asked).toEqual(["Go ahead? [y/N] "]);
    expect(h.out).toContain(
      "  · Disable TurnKey's nodejs Nginx site, pm2-node.service and confconsole's Let's Encrypt renewal job (nothing is deleted)",
    );
    expect(await hasEntry(SITE)).toBe(false);
    expect(await readFile(h.ctx.paths.under("/etc/nginx/sites-available/nodejs"), "utf8")).toBe(
      "server {}\n",
    );
    expect(host.enabled.has("pm2-node")).toBe(false);
    expect(host.active.has("pm2-node")).toBe(false);
    expect(await modeOf(JOB)).toBe(0o644);
  });

  it("changes nothing when the plan is declined", async () => {
    const { code, host } = await turnkey("nodejs", ["host", "setup"], {
      interactive: true,
      answers: ["n"],
    });
    expect(code).toBe(1);
    expect(await hasEntry(SITE)).toBe(true);
    expect(host.active.has("pm2-node")).toBe(true);
    expect(await modeOf(JOB)).toBe(0o755);
  });

  it("names only the pieces that are there", async () => {
    await turnkey("nodejs", ["host", "setup", "--yes"], { renewalJob: false });
    expect(h.out).toContain(
      "  · Disable TurnKey's nodejs Nginx site and pm2-node.service (nothing is deleted)",
    );
  });

  it("leaves Webmin, confconsole, inithooks, Postfix and the firewall alone", async () => {
    await turnkey("nodejs", ["host", "setup", "--yes"]);
    const systemctl = h.calls
      .filter((c) => c.command === "systemctl")
      .map((c) => c.args.join(" "))
      .filter((a) => !a.startsWith("is-"));
    expect(systemctl.filter((a) => /webmin|confconsole|inithooks|postfix|fence/.test(a))).toEqual(
      [],
    );
    expect(h.calls.some((c) => c.command === "ufw")).toBe(false);
    expect(await readFile(h.ctx.paths.under("/etc/default/inithooks"), "utf8")).toBe(
      "RUN_FIRSTBOOT=false\n",
    );
  });
});

describe("host setup on TurnKey Core", () => {
  it("asks nothing extra when there is no renewal job", async () => {
    const { code } = await turnkey("core", ["host", "setup"], {
      interactive: true,
      answers: ["y"],
    });
    expect(code).toBe(0);
    expect(h.asked).toEqual(["Go ahead? [y/N] "]);
    expect(h.out.some((l) => l.includes("Disable TurnKey"))).toBe(false);
  });

  it("disables only the renewal job when there is one", async () => {
    await turnkey("core", ["host", "setup", "--yes"], { renewalJob: true });
    expect(h.out).toContain(
      "  · Disable confconsole's Let's Encrypt renewal job (nothing is deleted)",
    );
    expect(await modeOf(JOB)).toBe(0o644);
  });
});

describe("host setup refusals on TurnKey", () => {
  const nothingChanged = async (host: FakeHost) => {
    expect(host.installed.has("nginx")).toBe(false);
    expect(await hasEntry(h.ctx.paths.etc)).toBe(false);
  };

  it("refuses another appliance, naming it, and changes nothing", async () => {
    const { code, host } = await turnkey("core", ["host", "setup", "--yes"], {
      version: "turnkey-wordpress-19.0-trixie-amd64",
      packages: ["turnkey-wordpress"],
    });
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("wordpress");
    expect(h.err.join("\n")).toContain(
      "Only TurnKey Core and Node.js are supported. Use one of those, or plain Debian 13.",
    );
    await nothingChanged(host);
  });

  it("refuses when the version file and the package disagree", async () => {
    const { code, host } = await turnkey("nodejs", ["host", "setup", "--yes"], {
      packages: ["turnkey-core-19.0"],
    });
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("Only TurnKey Core and Node.js are supported");
    await nothingChanged(host);
  });

  it("refuses while RUN_FIRSTBOOT is still true", async () => {
    const { code, host } = await turnkey("core", ["host", "setup", "--yes"], {
      firstBoot: "pending",
    });
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("first-boot setup");
    await nothingChanged(host);
  });

  it("refuses while the init fence is still up", async () => {
    const { code, host } = await turnkey("core", ["host", "setup", "--yes"], {
      firstBoot: "fence",
    });
    expect(code).toBe(2);
    expect(h.err.join("\n")).toContain("first-boot setup");
    await nothingChanged(host);
  });

  it("does not look for TurnKey on a plain Debian Host", async () => {
    const host = fakeHost();
    h = await harness({ setUp: false, runner: (c, a) => host.run(c, a) });
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect(h.out.some((l) => l.includes("TurnKey"))).toBe(false);
  });
});

describe("host doctor on TurnKey", () => {
  const doctor = (...args: string[]) => run(["host", "doctor", ...args], h.ctx);

  it("names the appliance in the OS line and is quiet once setup is done", async () => {
    await appliance("nodejs");
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    h.out.length = 0;
    expect(await doctor()).toBe(0);
    expect(h.out).toContain("  ✓ TurnKey Node.js 19.0 (Debian 13), amd64");
    expect(h.out.some((l) => l.startsWith("  ! "))).toBe(false);
  });

  it("warns when a disabled piece is back, without changing it", async () => {
    await setUpThenBack("nodejs");
    expect(await doctor()).toBe(1);
    for (const piece of ["sites-enabled/nodejs", "pm2-node.service", "confconsole-dehydrated"])
      expect(h.out.some((l) => l.startsWith("  ! ") && l.includes(piece))).toBe(true);
    expect(await hasEntry(SITE)).toBe(true);
  });

  it("--fix disables them again after asking", async () => {
    const host = await setUpThenBack("nodejs", { interactive: true, answers: ["a"] });
    expect(await doctor("--fix")).toBe(0);
    expect(h.asked[0]).toBe("fix / skip / all? [f/s/a] ");
    expect(await hasEntry(SITE)).toBe(false);
    expect(host.active.has("pm2-node")).toBe(false);
    expect(host.enabled.has("pm2-node")).toBe(false);
    expect(await modeOf(JOB)).toBe(0o644);
  });

  it("notes webmin-nginx", async () => {
    await appliance("core", {
      packages: ["turnkey-core-19.0", "webmin-nginx"],
    });
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    h.out.length = 0;
    expect(await doctor()).toBe(0);
    expect(h.out.some((l) => l.startsWith("  · ") && l.includes("webmin-nginx"))).toBe(true);
  });

  it("fails on another appliance", async () => {
    await appliance("core", {
      setUp: true,
      version: "turnkey-lamp-19.0-trixie-amd64",
      packages: ["turnkey-lamp"],
    });
    expect(await doctor()).toBe(2);
  });
});
