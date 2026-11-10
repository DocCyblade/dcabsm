import { mkdir, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

interface Opts {
  interactive?: boolean;
  /** Login methods in account.sqlite; null: no account.sqlite (never started). */
  methods?: string[] | null;
  exit?: number;
}

/** Instance `test`, with an account.sqlite holding the given login methods. */
async function start(opts: Opts = {}) {
  h = await harness({ interactive: opts.interactive ?? true });
  const dir = join(h.ctx.paths.instances, "test");
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, "server-files"), { recursive: true });
  await writeFile(
    join(dir, "config", "instance.json"),
    JSON.stringify({ port: 15127, hostname: "test.example.org", scheduledBackups: true }),
  );
  await symlink(join(h.ctx.paths.releases, "26.11.1"), join(dir, "release"));
  if (opts.methods !== null) {
    const db = new DatabaseSync(join(dir, "server-files", "account.sqlite"));
    db.exec("CREATE TABLE auth (method TEXT, display_name TEXT, extra_data TEXT, active INTEGER)");
    for (const m of opts.methods ?? ["password"]) {
      db.prepare("INSERT INTO auth (method) VALUES (?)").run(m);
    }
    db.close();
  }
  const handed: Array<{ command: string; args: string[] }> = [];
  h.ctx.runner.inherit = async (command, args) => {
    handed.push({ command, args });
    return opts.exit ?? 0;
  };
  return handed;
}

describe("instance reset-password", () => {
  it("prints the hint, then hands the terminal to Actual's tool as the Instance account", async () => {
    const handed = await start();
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(0);
    expect(h.out[0]).toBe("If you paste a password, press Enter separately.");
    expect(h.out[1]).toContain("DCABSM never sees the password");
    expect(handed).toHaveLength(1);
    const { command, args } = handed[0]!;
    expect(command).toBe("runuser");
    expect(args.slice(0, 3)).toEqual(["-u", "dcabsm-test", "--"]);
    expect(args.slice(-3)).toEqual([
      "--config",
      "/srv/dcabsm/instances/test/config/config.json",
      "--reset-password",
    ]);
    expect(args).toContain("/srv/dcabsm/instances/test/release/node_modules/.bin/actual-server");
    expect(args).toContain("ACTUAL_DATA_DIR=/srv/dcabsm/instances/test/data");
  });

  it("also resets when password and OpenID are both set", async () => {
    const handed = await start({ methods: ["openid", "password"] });
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(0);
    expect(handed).toHaveLength(1);
  });

  it("also runs on a started Instance that has no password yet", async () => {
    const handed = await start({ methods: [] });
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(0);
    expect(handed).toHaveLength(1);
  });

  it("refuses with no terminal", async () => {
    const handed = await start({ interactive: false });
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("Password reset needs a terminal");
    expect(handed).toHaveLength(0);
  });

  it("refuses on an Instance that has never started", async () => {
    const handed = await start({ methods: null });
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("has never started");
    expect(h.err.join("\n")).toContain("https://test.example.org");
    expect(handed).toHaveLength(0);
  });

  it("refuses on an OpenID-only Instance", async () => {
    const handed = await start({ methods: ["openid"] });
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("Reset passwords with your OpenID provider.");
    expect(handed).toHaveLength(0);
  });

  it("refuses an unknown Instance and an unfinished Release change", async () => {
    await start();
    expect(await run(["instance", "reset-password", "nope"], h.ctx)).toBe(2);
    await writeFile(join(h.ctx.paths.instances, "test", ".changing-release"), "");
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("unfinished Release change");
  });

  it("fails when Actual's tool exits non-zero", async () => {
    await start({ exit: 1 });
    expect(await run(["instance", "reset-password", "test"], h.ctx)).toBe(1);
    expect(h.err.join("\n")).toContain("The password was not changed");
  });
});
