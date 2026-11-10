import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const NAME = "family";
let active = true;
let nginxFails = false;

async function start(
  release = "26.11.0",
  opts: { interactive?: boolean; answers?: string[] } = {},
) {
  active = true;
  nginxFails = false;
  h = await harness({
    ...opts,
    runner: (command, args) => {
      if (command === "systemctl" && args[0] === "is-active") {
        return active
          ? { code: 0, stdout: "active\n", stderr: "" }
          : { code: 3, stdout: "inactive\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "show") {
        return { code: 0, stdout: "0\n", stderr: "" };
      }
      if (command === "nginx" && args[0] === "-t" && nginxFails) {
        return { code: 1, stdout: "", stderr: "nginx: bad config\n" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  h.ctx.fetcher.fetch = async (url) => {
    const body = url.endsWith("/health") ? { status: "UP" } : { build: { version: release } };
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(body)) };
  };
  const dir = join(h.ctx.paths.instances, NAME);
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, "nginx"), { recursive: true });
  await writeRecord({});
  await writeFile(join(dir, "nginx", "vhost.conf"), "OLD VHOST\n");
  await symlink(join(h.ctx.paths.releases, release), join(dir, "release"));
  h.calls.length = 0;
}

const file = (...p: string[]) => join(h.ctx.paths.instances, NAME, ...p);
const writeRecord = (extra: object) =>
  writeFile(
    file("config", "instance.json"),
    JSON.stringify({
      port: 15127,
      hostname: "family.example.org",
      scheduledBackups: true,
      ...extra,
    }),
  );
const record = async () => JSON.parse(await readFile(file("config", "instance.json"), "utf8"));
const config = async () => JSON.parse(await readFile(file("config", "config.json"), "utf8"));
const systemctls = () =>
  h.calls.filter(
    (c) => c.command === "systemctl" && c.args[0] !== "is-active" && c.args[0] !== "show",
  );
const err = () => h.err.join("\n");
const set = (...args: string[]) => run(["instance", "set", NAME, ...args], h.ctx);

describe("instance set", () => {
  it("writes the record and a config.json with the nested Actual key", async () => {
    await start();
    expect(await set("upload-sync-limit-mb", "100", "--yes")).toBe(0);
    expect((await record()).settings).toEqual({ "upload-sync-limit-mb": 100 });
    const cfg = await config();
    expect(cfg.upload).toEqual({ fileSizeSyncLimitMB: 100 });
    expect(cfg.port).toBe(15127);
    expect(cfg.trustedProxies).toEqual(["127.0.0.1/32"]);
    expect(h.out.join("\n")).toContain(`upload-sync-limit-mb = 100 for ${NAME}`);
  });

  it("refuses an unknown key", async () => {
    await start();
    expect(await set("bogus", "1", "--yes")).toBe(2);
    expect(err()).toContain("unknown setting");
  });

  it("refuses always-set and never-settable keys", async () => {
    await start();
    for (const key of [
      "port",
      "dataDir",
      "loginMethod",
      "https.key",
      "webRoot",
      "env",
      "mode",
      "projectRoot",
    ]) {
      h.err.length = 0;
      expect(await set(key, "x", "--yes")).toBe(2);
      expect(err()).toContain(`${key} can't be set`);
    }
    expect((await record()).settings).toBeUndefined();
  });

  it("refuses a bad value", async () => {
    await start();
    for (const [key, value] of [
      ["upload-limit-mb", "0"],
      ["upload-limit-mb", "1025"],
      ["upload-limit-mb", "1.5"],
      ["openid-enforce", "yes"],
      ["openid-user-creation", "auto"],
      ["simplefin-allowed-networks", "10.0.0.0/33"],
      ["simplefin-allowed-networks", "nope"],
    ] as const) {
      expect(await set(key, value, "--yes"), `${key} ${value}`).toBe(2);
    }
    expect((await record()).settings).toBeUndefined();
  });

  it("refuses a key the Release doesn't know, naming the first Release", async () => {
    await start("26.10.0");
    expect(await set("simplefin-allowed-networks", "10.0.0.0/8", "--yes")).toBe(2);
    expect(err()).toContain(`needs 26.11.0, ${NAME} runs 26.10.0`);
    expect((await record()).settings).toBeUndefined();
  });

  it("writes a list for simplefin-allowed-networks on a Release that knows it", async () => {
    await start();
    expect(await set("simplefin-allowed-networks", "10.0.0.0/8, 192.168.1.5", "--yes")).toBe(0);
    expect((await config()).simplefinAllowedNetworks).toEqual(["10.0.0.0/8", "192.168.1.5"]);
  });

  it("refuses while a .changing-release marker exists", async () => {
    await start();
    await writeFile(file(".changing-release"), "{}");
    expect(await set("openid-enforce", "true", "--yes")).toBe(2);
    expect(err()).toContain("unfinished Release change");
    expect((await record()).settings).toBeUndefined();
  });

  it("takes the lock", async () => {
    await start();
    await mkdir(join(h.ctx.paths.lock, ".."), { recursive: true });
    await writeFile(h.ctx.paths.lock, JSON.stringify({ pid: process.pid, command: "other" }));
    expect(await set("openid-enforce", "true", "--yes")).toBe(1);
    expect(err()).toContain("Another dcabsm command is running");
    expect((await record()).settings).toBeUndefined();
  });

  it("does not touch Nginx for a non-upload setting", async () => {
    await start();
    await set("openid-enforce", "true", "--yes");
    expect(h.calls.some((c) => c.command === "nginx")).toBe(false);
    expect(await readFile(file("nginx", "vhost.conf"), "utf8")).toBe("OLD VHOST\n");
  });
});

describe("restart handling", () => {
  it("--yes restarts a running Instance", async () => {
    await start();
    await set("openid-enforce", "true", "--yes");
    expect(systemctls().map((c) => c.args)).toEqual([["restart", `dcabsm@${NAME}`]]);
  });

  it("asks on a terminal, default yes", async () => {
    await start("26.11.0", { interactive: true, answers: [""] });
    await set("openid-enforce", "true");
    expect(h.asked).toEqual([`Restart ${NAME} now? [Y/n] `]);
    expect(systemctls().map((c) => c.args)).toEqual([["restart", `dcabsm@${NAME}`]]);
  });

  it("does not restart when the answer is no", async () => {
    await start("26.11.0", { interactive: true, answers: ["n"] });
    expect(await set("openid-enforce", "true")).toBe(0);
    expect(systemctls()).toEqual([]);
    expect(h.out.join("\n")).toContain("restart needed");
  });

  it("says restart needed with no terminal and no --yes", async () => {
    await start();
    expect(await set("openid-enforce", "true")).toBe(0);
    expect(systemctls()).toEqual([]);
    expect(h.out.join("\n")).toContain(`restart needed: sudo dcabsm instance restart ${NAME}`);
  });

  it("never starts a stopped Instance", async () => {
    await start();
    active = false;
    await set("openid-enforce", "true", "--yes");
    expect(systemctls()).toEqual([]);
    expect(h.out.join("\n")).toContain("applies on the next start");
  });
});

describe("upload limits and Nginx", () => {
  it("regenerates the vhost from the largest limit, tests and reloads", async () => {
    await start();
    await set("upload-sync-limit-mb", "100", "--yes");
    const vhost = await readFile(file("nginx", "vhost.conf"), "utf8");
    expect(vhost).toContain("client_max_body_size 101m;");
    expect(h.calls.map((c) => [c.command, ...c.args].join(" "))).toEqual(
      expect.arrayContaining(["nginx -t", "systemctl reload nginx"]),
    );
    expect(h.out.join("\n")).toContain(
      "Nginx: client_max_body_size 101m, nginx -t passed, reloaded",
    );
  });

  it("puts the old vhost back and changes nothing when nginx -t fails", async () => {
    await start();
    nginxFails = true;
    expect(await set("upload-limit-mb", "100", "--yes")).toBe(1);
    expect(await readFile(file("nginx", "vhost.conf"), "utf8")).toBe("OLD VHOST\n");
    expect((await record()).settings).toBeUndefined();
    expect(h.calls.some((c) => c.args.join(" ") === "reload nginx")).toBe(false);
    expect(systemctls()).toEqual([]);
  });
});

describe("settings with nothing to change", () => {
  it("unset on a key at default says so and touches nothing", async () => {
    await start();
    expect(await run(["instance", "unset", NAME, "upload-limit-mb", "--yes"], h.ctx)).toBe(0);
    expect(h.out.join("\n")).toContain("Nothing changed");
    expect(systemctls()).toEqual([]);
    expect(h.calls.some((c) => c.command === "nginx" || c.command === "chown")).toBe(false);
  });

  it("set to the value already set says so and touches nothing", async () => {
    await start();
    await set("upload-limit-mb", "100", "--yes");
    h.calls.length = 0;
    h.out.length = 0;
    expect(await set("upload-limit-mb", "100", "--yes")).toBe(0);
    expect(h.out.join("\n")).toContain("Nothing changed");
    expect(h.calls.filter((c) => !["systemctl", "logger"].includes(c.command))).toEqual([]);
    expect(systemctls()).toEqual([]);
  });

  it("writes the record before Nginx reloads", async () => {
    await start();
    const inner = h.ctx.runner;
    let recordAtReload: unknown;
    h.ctx.runner = {
      run: async (c, a) => {
        if (c === "systemctl" && a[0] === "reload") recordAtReload = (await record()).settings;
        return inner.run(c, a);
      },
    };
    await set("upload-limit-mb", "100", "--yes");
    expect(recordAtReload).toEqual({ "upload-limit-mb": 100 });
  });
});

describe("instance unset", () => {
  it("returns a key to default and drops it from config.json, whatever the Release", async () => {
    await start();
    await set("simplefin-allowed-networks", "10.0.0.0/8", "--yes");
    await symlink(join(h.ctx.paths.releases, "26.10.0"), file("release.new"));
    await rename(file("release.new"), file("release"));
    expect(await run(["instance", "unset", NAME, "simplefin-allowed-networks"], h.ctx)).toBe(0);
    expect((await record()).settings).toEqual({});
    expect((await config()).simplefinAllowedNetworks).toBeUndefined();
  });

  it("restores the vhost default for an upload limit", async () => {
    await start();
    await set("upload-limit-mb", "200", "--yes");
    await run(["instance", "unset", NAME, "upload-limit-mb", "--yes"], h.ctx);
    expect(await readFile(file("nginx", "vhost.conf"), "utf8")).toContain(
      "client_max_body_size 51m;",
    );
  });

  it("refuses an unknown key", async () => {
    await start();
    expect(await run(["instance", "unset", NAME, "bogus", "--yes"], h.ctx)).toBe(2);
    expect(err()).toContain("unknown setting");
  });
});

describe("instance settings and show", () => {
  const withSettings = {
    settings: { "upload-sync-limit-mb": 100, "simplefin-allowed-networks": "10.0.0.0/8" },
  };

  it("lists every key with value, source and use", async () => {
    await start("26.10.0");
    await writeRecord(withSettings);
    expect(await run(["instance", "settings", NAME], h.ctx)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toMatch(/KEY\s+ACTUAL KEY\s+VALUE\s+SOURCE\s+USED/);
    expect(out).toMatch(/upload-sync-limit-mb\s+upload\.fileSizeSyncLimitMB\s+100\s+set\s+yes/);
    expect(out).toMatch(/upload-limit-mb\s+upload\.fileSizeLimitMB\s+20\s+default\s+yes/);
    expect(out).toMatch(
      /simplefin-allowed-networks\s+simplefinAllowedNetworks\s+10\.0\.0\.0\/8\s+set\s+not used by 26\.10\.0/,
    );
  });

  it("shows the empty default as (empty)", async () => {
    await start();
    await run(["instance", "settings", NAME], h.ctx);
    expect(h.out.join("\n")).toMatch(/simplefinAllowedNetworks\s+\(empty\)\s+default\s+yes/);
  });

  it("show lists settings set and those not used", async () => {
    await start("26.10.0");
    await writeRecord(withSettings);
    await run(["instance", "show", NAME], h.ctx);
    const out = h.out.join("\n");
    expect(out).toMatch(/Settings\s+upload-sync-limit-mb 100/);
    expect(out).toContain("simplefin-allowed-networks 10.0.0.0/8 (not used by 26.10.0)");
  });
});
