import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** Units systemd says are active; `systemctl start` adds, `stop` removes. */
let active: Set<string>;

async function start(names: string[], opts: { failing?: string[] } = {}) {
  active = new Set();
  h = await harness({
    runner: (command, args) => {
      if (command === "journalctl") return ok("line one\nline two\n");
      if (command !== "systemctl") return ok();
      const unit = args[args.length - 1]!;
      if (args[0] === "is-active") {
        if (opts.failing?.includes(unit.replace("dcabsm@", ""))) return ok("failed\n");
        return active.has(unit) ? ok("active\n") : { code: 3, stdout: "inactive\n", stderr: "" };
      }
      if (args[0] === "show") return ok("0\n");
      if (args[0] === "start" || args[0] === "restart") active.add(unit);
      if (args[0] === "stop") active.delete(unit);
      return ok();
    },
  });
  let t = Date.parse("2026-11-09T12:00:00Z");
  h.ctx.now = () => new Date((t += 10));
  h.ctx.fetcher.fetch = async (url) => {
    const body = url.endsWith("/health") ? { status: "UP" } : { build: { version: "26.11.1" } };
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(body)) };
  };
  let port = 15127;
  for (const name of names) {
    const dir = join(h.ctx.paths.instances, name);
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "config", "instance.json"),
      JSON.stringify({ port: port++, hostname: `${name}.example.org`, scheduledBackups: true }),
    );
    await symlink(join(h.ctx.paths.releases, "26.11.1"), join(dir, "release"));
  }
  h.calls.length = 0;
}

const sysctl = () =>
  h.calls.filter((c) => c.command === "systemctl" && !["is-active", "show"].includes(c.args[0]!));

describe("instance start, stop and restart", () => {
  it("start starts, verifies, then enables the unit", async () => {
    await start(["test"]);
    expect(await run(["instance", "start", "test"], h.ctx)).toBe(0);
    expect(sysctl().map((c) => c.args)).toEqual([
      ["start", "dcabsm@test"],
      ["enable", "dcabsm@test"],
    ]);
    expect(h.out.join("\n")).toMatch(/Started and verified: \/health UP, \/info 26\.11\.1/);
  });

  it("stop stops and disables the unit and leaves the vhost alone", async () => {
    await start(["test"]);
    expect(await run(["instance", "stop", "test"], h.ctx)).toBe(0);
    expect(sysctl().map((c) => c.args)).toEqual([
      ["stop", "dcabsm@test"],
      ["disable", "dcabsm@test"],
    ]);
    expect(h.out.join("\n")).toContain("Stopped test. It stays stopped after a reboot");
    expect(h.calls.some((c) => c.command === "nginx")).toBe(false);
  });

  it("restart leaves enablement alone", async () => {
    await start(["test"]);
    expect(await run(["instance", "restart", "test"], h.ctx)).toBe(0);
    expect(sysctl().map((c) => c.args)).toEqual([["restart", "dcabsm@test"]]);
    expect(h.out.join("\n")).toContain("Started and verified");
  });

  it("--all acts on every Instance", async () => {
    await start(["a", "b"]);
    expect(await run(["instance", "stop", "--all"], h.ctx)).toBe(0);
    expect(sysctl().map((c) => c.args.join(" "))).toEqual([
      "stop dcabsm@a",
      "disable dcabsm@a",
      "stop dcabsm@b",
      "disable dcabsm@b",
    ]);
  });

  it("an unknown name is refused before anything runs", async () => {
    await start(["a", "b"]);
    expect(await run(["instance", "stop", "a", "nope"], h.ctx)).toBe(2);
    expect(sysctl()).toEqual([]);
    expect(h.err.join("\n")).toContain("There is no Instance named nope.");
  });

  it("needs names or --all", async () => {
    await start([]);
    expect(await run(["instance", "start"], h.ctx)).toBe(2);
  });

  it("refuses an Instance with an unfinished Release change", async () => {
    await start(["test"]);
    await writeFile(join(h.ctx.paths.instances, "test", ".changing-release"), "");
    expect(await run(["instance", "start", "test"], h.ctx)).toBe(2);
    expect(sysctl()).toEqual([]);
    expect(h.err.join("\n")).toContain("unfinished Release change");
  });

  it("a failed verification exits 1, does not enable, and the rest still run", async () => {
    await start(["a", "b"], { failing: ["a"] });
    expect(await run(["instance", "start", "a", "b"], h.ctx)).toBe(1);
    const args = sysctl().map((c) => c.args.join(" "));
    expect(args).toContain("start dcabsm@b");
    expect(args).toContain("enable dcabsm@b");
    expect(args).not.toContain("enable dcabsm@a");
  });

  it("instance list shows stopped and failed", async () => {
    await start(["a", "b", "c"], { failing: ["c"] });
    active.add("dcabsm@a");
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toMatch(/a\s+active/);
    expect(text).toMatch(/b\s+stopped/);
    expect(text).toMatch(/c\s+failed/);
  });
});

describe("instance logs", () => {
  it("shows the last 50 lines of the unit's journal", async () => {
    await start(["test"]);
    expect(await run(["instance", "logs", "test"], h.ctx)).toBe(0);
    expect(h.calls[0]).toEqual({
      command: "journalctl",
      args: ["-u", "dcabsm@test", "--no-pager", "-n", "50"],
    });
    expect(h.out).toEqual(["line one", "line two"]);
  });

  it("--since replaces the line count", async () => {
    await start(["test"]);
    await run(["instance", "logs", "test", "--since", "15 min ago"], h.ctx);
    expect(h.calls[0]!.args).toEqual(["-u", "dcabsm@test", "--no-pager", "--since", "15 min ago"]);
  });

  it("-f follows", async () => {
    await start(["test"]);
    await run(["instance", "logs", "test", "-f"], h.ctx);
    expect(h.calls[0]!.args).toEqual(["-u", "dcabsm@test", "--no-pager", "-n", "50", "-f"]);
  });

  it("refuses an unknown Instance", async () => {
    await start([]);
    expect(await run(["instance", "logs", "nope"], h.ctx)).toBe(2);
  });
});
