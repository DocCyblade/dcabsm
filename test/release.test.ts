import { mkdir, readFile, readdir, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { satisfies, parseVersion } from "../src/release/semver.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";
import { fakeHost } from "./fakehost.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";

let h: Harness;
afterEach(() => h.cleanup());

async function start(opts: HarnessOptions = {}): Promise<void> {
  h = await harness(opts);
  await mkdir(h.ctx.paths.releases, { recursive: true });
  await mkdir(h.ctx.paths.node, { recursive: true });
  await mkdir(h.ctx.paths.instances, { recursive: true });
}

const install = (v: string) => run(["release", "install", v], h.ctx);
const names = async (dir: string) => (await readdir(dir)).sort();
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("which versions are accepted", () => {
  it.each(["26.11.0-beta.1", "v26.11.0", "26.11", "26.11.0+x", "latest"])(
    "refuses %j as not stable, before touching the network",
    async (v) => {
      await start();
      expect(await install(v)).toBe(2);
      expect(h.err[0]).toContain("not a stable Release version");
      expect(h.net.fetched).toEqual([]);
    },
  );

  it("refuses a version below the floor with the documented message", async () => {
    await start();
    expect(await install("26.9.0")).toBe(2);
    expect(h.err[0]).toBe(
      "error: 26.9.0 is older than 26.10.0, the oldest Release DCABSM supports.",
    );
    expect(h.net.fetched).toEqual([]);
  });

  it("accepts the floor itself", async () => {
    await start();
    expect(await install("26.10.0")).toBe(0);
    expect(await names(h.ctx.paths.releases)).toEqual(["26.10.0"]);
  });

  it("refuses a version npm does not have", async () => {
    await start();
    expect(await install("26.10.9")).toBe(2);
    expect(h.err[0]).toContain("does not exist on npm");
    expect(await names(h.ctx.paths.releases)).toEqual([]);
  });
});

describe("choosing the Node runtime", () => {
  it("takes the newest LTS major that satisfies engines.node", async () => {
    await start({ net: fakeNet({ actual: { "26.11.0": ">=20 <24" } }) });
    expect(await install("26.11.0")).toBe(0);
    expect(
      await readFile(join(h.ctx.paths.releases, "26.11.0", ".dcabsm-node-major"), "utf8"),
    ).toBe("22\n");
    expect(await names(h.ctx.paths.node)).toEqual(["22", "22.21.0"]);
  });

  it("never goes past the ceiling, even for a Node that is newer and LTS", async () => {
    await start({
      net: fakeNet({
        index: [
          { version: "v26.0.0", lts: "Future" },
          { version: "v24.11.1", lts: "Krypton" },
        ],
      }),
    });
    expect(await install("26.11.0")).toBe(0);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
    expect(await exists(join(h.ctx.paths.node, "26"))).toBe(false);
  });

  it("skips a current (non-LTS) major", async () => {
    await start({ net: fakeNet({ actual: { "26.11.0": ">=22" } }) });
    await install("26.11.0");
    expect(await exists(join(h.ctx.paths.node, "25"))).toBe(false);
  });

  it("refuses, pointing to self update, when no major fits, and leaves nothing", async () => {
    await start({ net: fakeNet({ actual: { "26.11.0": ">=26" } }) });
    expect(await install("26.11.0")).toBe(1);
    expect(h.err.join("\n")).toContain("sudo dcabsm self update");
    expect(await names(h.ctx.paths.releases)).toEqual([]);
    expect(await names(h.ctx.paths.node)).toEqual([]);
  });

  it("never uses the system's Node", async () => {
    await start();
    await install("26.11.0");
    const programs = h.calls.map((c) => (c.command === "env" ? c.args[1] : c.command));
    expect(programs.filter((p) => /(^|\/)(node|npm)$/.test(p!))).toSatisfy((list: string[]) =>
      list.every((p) => p.startsWith(h.ctx.paths.node)),
    );
  });
});

describe("the Node runtime download", () => {
  it("verifies the signature with gpgv and the shipped keyring, then the checksum", async () => {
    await start();
    await install("26.11.0");
    const gpgv = h.calls.find((c) => c.command === "gpgv")!;
    expect(gpgv.args[0]).toBe("--keyring");
    expect(gpgv.args[1]).toBe(h.ctx.paths.nodeKeyring);
    expect(gpgv.args.some((a) => a.endsWith("SHASUMS256.txt.sig"))).toBe(true);
    expect(gpgv.args.some((a) => a.endsWith("SHASUMS256.txt"))).toBe(true);
    expect(h.net.fetched).toContain(
      "https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz",
    );
    expect(await exists(join(h.ctx.paths.node, "24.11.1", "bin", "node"))).toBe(true);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
    expect(await names(h.ctx.paths.node)).toEqual(["24", "24.11.1"]);
  });

  it("downloads the arm64 build on arm64", async () => {
    await start({ arch: "arm64" });
    await install("26.11.0");
    expect(h.net.fetched).toContain(
      "https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-arm64.tar.xz",
    );
  });

  it("refuses a bad signature and leaves no Node and no Release", async () => {
    await start({ net: fakeNet({ badSignature: true }) });
    expect(await install("26.11.0")).toBe(1);
    expect(h.err[0]).toContain("signature");
    expect(await names(h.ctx.paths.node)).toEqual([]);
    expect(await names(h.ctx.paths.releases)).toEqual([]);
  });

  it("refuses a tarball that does not match SHASUMS256.txt", async () => {
    await start({ net: fakeNet({ badChecksum: true }) });
    expect(await install("26.11.0")).toBe(1);
    expect(h.err[0]).toContain("SHA-256");
    expect(await names(h.ctx.paths.node)).toEqual([]);
  });

  it("points node/<major> at the newest installed patch, and never back", async () => {
    await start();
    await mkdir(join(h.ctx.paths.node, "24.11.0", "bin"), { recursive: true });
    await writeFile(join(h.ctx.paths.node, "24.11.0", "bin", "node"), "");
    await symlink("24.11.0", join(h.ctx.paths.node, "24"));
    await install("26.11.0");
    // The installed major is used as it is; only update-node moves patches.
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.0");
    expect(
      await readFile(join(h.ctx.paths.releases, "26.11.0", ".dcabsm-node-major"), "utf8"),
    ).toBe("24\n");
  });
});

describe("the npm install", () => {
  it("runs npm --save-exact --ignore-scripts with the Release's own Node, and keeps the lockfile", async () => {
    await start();
    await install("26.11.0");
    const npm = h.calls.find((c) => c.command === "env" && c.args[1]?.endsWith("/bin/npm"))!;
    expect(npm.args[0]).toMatch(new RegExp(`^PATH=${join(h.ctx.paths.node, "24.11.1", "bin")}:`));
    expect(npm.args[1]).toBe(join(h.ctx.paths.node, "24.11.1", "bin", "npm"));
    expect(npm.args).toEqual(expect.arrayContaining(["--save-exact", "--ignore-scripts"]));
    expect(npm.args.at(-1)).toBe("@actual-app/sync-server@26.11.0");
    expect(npm.args[npm.args.indexOf("--prefix") + 1]).toBe(
      join(h.ctx.paths.releases, ".installing-26.11.0"),
    );
    expect(await exists(join(h.ctx.paths.releases, "26.11.0", "package-lock.json"))).toBe(true);
  });

  it("refuses the Release and deletes the temporary directory when a native module does not load", async () => {
    await start({ net: fakeNet({ nativeFails: true }) });
    expect(await install("26.11.0")).toBe(1);
    expect(h.err.join("\n")).toContain("bcrypt, argon2, better-sqlite3");
    expect(await names(h.ctx.paths.releases)).toEqual([]);
  });

  it("checks all three native modules", async () => {
    await start();
    await install("26.11.0");
    const check = h.calls.find((c) => c.args[0] === "-e")!;
    for (const m of ["bcrypt", "argon2", "better-sqlite3"]) expect(check.args[1]).toContain(m);
    expect(check.command).toBe(join(h.ctx.paths.node, "24.11.1", "bin", "node"));
  });

  it("clears a leftover .installing directory from a crashed run", async () => {
    await start();
    await mkdir(join(h.ctx.paths.releases, ".installing-26.11.0"));
    await writeFile(join(h.ctx.paths.releases, ".installing-26.11.0", "stale"), "x");
    expect(await install("26.11.0")).toBe(0);
    expect(await names(h.ctx.paths.releases)).toEqual(["26.11.0"]);
    expect(await exists(join(h.ctx.paths.releases, "26.11.0", "stale"))).toBe(false);
  });
});

describe("the installed Release", () => {
  it("is read-only and records its Node major", async () => {
    await start();
    expect(await install("26.11.0")).toBe(0);
    const dir = join(h.ctx.paths.releases, "26.11.0");
    expect((await stat(dir)).mode & 0o222).toBe(0);
    expect((await stat(join(dir, "package-lock.json"))).mode & 0o222).toBe(0);
    expect(await readFile(join(dir, ".dcabsm-node-major"), "utf8")).toBe("24\n");
    await expect(writeFile(join(dir, "new"), "x")).rejects.toThrow();
  });

  it("is left alone when installed again", async () => {
    await start();
    await install("26.11.0");
    h.net.fetched.length = 0;
    expect(await install("26.11.0")).toBe(0);
    expect(h.out.at(-1)).toBe("Release 26.11.0 is already installed.");
    expect(h.net.fetched).toEqual([]);
  });
});

describe("release list", () => {
  it("shows Releases, their Node and the Instances on them, and ignores dot directories", async () => {
    await start();
    await install("26.10.0");
    await install("26.11.0");
    await mkdir(join(h.ctx.paths.releases, ".installing-26.12.0"));
    await mkdir(join(h.ctx.paths.instances, "family"));
    await symlink(
      join(h.ctx.paths.releases, "26.11.0"),
      join(h.ctx.paths.instances, "family", "release"),
    );
    await mkdir(join(h.ctx.paths.instances, "test"));
    await symlink(
      join(h.ctx.paths.releases, "26.10.0"),
      join(h.ctx.paths.instances, "test", "release"),
    );
    await mkdir(join(h.ctx.paths.instances, ".changing"));
    h.out.length = 0;
    expect(await run(["release", "list"], h.ctx)).toBe(0);
    expect(h.out).toEqual([
      "RELEASE  NODE     USED BY",
      "26.10.0  24.11.1  test",
      "26.11.0  24.11.1  family",
    ]);
  });

  it("shows a Release no Instance uses, and says so when there are none", async () => {
    await start();
    await run(["release", "list"], h.ctx);
    expect(h.out[0]).toBe("No Releases installed.");
    await install("26.11.0");
    h.out.length = 0;
    await run(["release", "list"], h.ctx);
    expect(h.out).toEqual(["RELEASE  NODE     USED BY", "26.11.0  24.11.1  -"]);
  });
});

describe("host setup step 8", () => {
  const setup = async (args: string[] = [], net: FakeNet = fakeNet()) => {
    const host = fakeHost();
    h = await harness({ setUp: false, net, runner: (c, a) => host.run(c, a) });
    return run(["host", "setup", "--yes", ...args], h.ctx);
  };

  it("installs the latest stable Release", async () => {
    expect(await setup()).toBe(0);
    expect(await names(h.ctx.paths.releases)).toEqual(["26.11.1"]);
    expect(h.out).toContain("  · Install Actual 26.11.1 with its Node runtime");
  });

  it("installs --release <v> instead", async () => {
    expect(await setup(["--release", "26.10.0"])).toBe(0);
    expect(await names(h.ctx.paths.releases)).toEqual(["26.10.0"]);
  });

  it("refuses a bad --release before changing anything", async () => {
    expect(await setup(["--release", "26.9.0"])).toBe(2);
    expect(await exists(h.ctx.paths.srv)).toBe(false);
  });

  it("does not pull a newer Release on a re-run once one loads", async () => {
    expect(await setup(["--release", "26.10.0"])).toBe(0);
    h.net.fetched.length = 0;
    h.out.length = 0;
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect(await names(h.ctx.paths.releases)).toEqual(["26.10.0"]);
    expect(h.net.fetched).toEqual([]);
    expect(h.out).toContain("Every check passes; nothing to do.");
  });

  it("carries on after a failed install, installing the Release on the re-run", async () => {
    const net = fakeNet({ nativeFails: true });
    expect(await setup([], net)).toBe(1);
    expect(await names(h.ctx.paths.releases)).toEqual([]);
    net.nativeFails = false;
    expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
    expect(await names(h.ctx.paths.releases)).toEqual(["26.11.1"]);
  });
});

describe("engines.node ranges", () => {
  const ok = (v: string, range: string) => satisfies(parseVersion(v)!, range);
  it.each([
    ["24.11.1", ">=20", true],
    ["24.11.1", ">=20 <24", false],
    ["22.21.0", "^22 || ^24", true],
    ["20.19.5", "^22 || ^24", false],
    ["22.21.0", "22", true],
    ["22.21.0", "22.x", true],
    ["22.21.0", ">= 22.0.0", true],
    ["22.1.0", "~22.2.0", false],
    ["24.0.0", "<=22", false],
    ["24.11.1", "*", true],
  ])("%s against %j is %s", (v, range, expected) => {
    expect(ok(v, range)).toBe(expected);
  });
});
