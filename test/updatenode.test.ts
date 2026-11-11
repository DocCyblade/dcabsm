import { mkdir, readlink, readdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { fakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

/** Units systemd says are active. */
let active: Set<string>;

interface Setup {
  /** Instance name → whether it is running. */
  instances: Record<string, boolean>;
  changing?: string[];
  answers?: string[];
  restartFails?: string[];
}

async function start(setup: Setup) {
  active = new Set(
    Object.entries(setup.instances)
      .filter(([, up]) => up)
      .map(([n]) => `dcabsm@${n}`),
  );
  const net = fakeNet();
  net.index.unshift({ version: "v24.11.2", lts: "Krypton" });
  h = await harness({
    net,
    interactive: setup.answers !== undefined,
    answers: setup.answers,
    runner: (command, args) => {
      if (command !== "systemctl") return ok();
      const unit = args[args.length - 1]!;
      if (args[0] === "is-active") {
        return active.has(unit) ? ok("active\n") : { code: 3, stdout: "inactive\n", stderr: "" };
      }
      if (args[0] === "restart" && setup.restartFails?.includes(unit.replace("dcabsm@", ""))) {
        return { code: 1, stdout: "", stderr: "boom" };
      }
      return ok();
    },
  });
  let t = Date.parse("2026-11-09T12:00:00Z");
  h.ctx.now = () => new Date((t += 10));
  const { node, releases, instances } = h.ctx.paths;
  await mkdir(join(node, "24.11.1", "bin"), { recursive: true });
  await writeFile(join(node, "24.11.1", "bin", "node"), "node");
  await symlink("24.11.1", join(node, "24"));
  await mkdir(join(releases, "26.11.1"), { recursive: true });
  await writeFile(join(releases, "26.11.1", ".dcabsm-node-major"), "24\n");
  let port = 15127;
  for (const name of Object.keys(setup.instances)) {
    const dir = join(instances, name);
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(
      join(dir, "config", "instance.json"),
      JSON.stringify({ port: port++, hostname: `${name}.example.org`, scheduledBackups: true }),
    );
    await symlink(join(releases, "26.11.1"), join(dir, "release"));
    if (setup.changing?.includes(name)) await writeFile(join(dir, ".changing-release"), "x");
  }
  h.calls.length = 0;
}

const restarts = () =>
  h.calls.filter((c) => c.command === "systemctl" && c.args[0] === "restart").map((c) => c.args[1]);
const text = () => h.out.join("\n");

describe("release update-node", () => {
  it("installs the patch, repoints node/<major> and restarts running Instances one at a time", async () => {
    await start({ instances: { family: true, test: false, shop: true }, answers: ["y"] });
    expect(await run(["release", "update-node"], h.ctx)).toBe(0);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.2");
    expect(await readdir(h.ctx.paths.node)).toContain("24.11.2");
    expect(restarts()).toEqual(["dcabsm@family", "dcabsm@shop"]);
    // Each restart clears the start-limit count first, so a run of restarts never trips it.
    const verbs = h.calls
      .filter((c) => c.command === "systemctl" && ["reset-failed", "restart"].includes(c.args[0]!))
      .map((c) => `${c.args[0]} ${c.args[1]}`);
    expect(verbs).toEqual([
      "reset-failed dcabsm@family",
      "restart dcabsm@family",
      "reset-failed dcabsm@shop",
      "restart dcabsm@shop",
    ]);
    expect(text()).toContain("Node 24.11.1 → 24.11.2");
    expect(text()).toContain(
      "Restarts, one at a time: family, shop, test (stopped, stays stopped)",
    );
    expect(text()).toContain("Installed Node 24.11.2, checked with gpgv");
    expect(text()).toContain("Restarted family");
    expect(h.calls.some((c) => c.command === "gpgv")).toBe(true);
  });

  it("changes nothing when the answer is no", async () => {
    await start({ instances: { family: true }, answers: ["n"] });
    expect(await run(["release", "update-node"], h.ctx)).toBe(1);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
    expect(await readdir(h.ctx.paths.node)).not.toContain("24.11.2");
    expect(restarts()).toEqual([]);
  });

  it("--yes skips the question; without a terminal it needs --yes", async () => {
    await start({ instances: { family: true } });
    expect(await run(["release", "update-node"], h.ctx)).toBe(2);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(0);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.2");
  });

  it("skips and names an Instance with a .changing-release marker", async () => {
    await start({ instances: { family: true, busy: true }, changing: ["busy"] });
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(0);
    expect(restarts()).toEqual(["dcabsm@family"]);
    expect(text()).toContain("busy (unfinished Release change, skipped)");
    expect(text()).toContain("Skipped busy");
  });

  it("does not repoint when the signature does not verify", async () => {
    await start({ instances: { family: true } });
    h.net.badSignature = true;
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(1);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
    expect(await readdir(h.ctx.paths.node)).not.toContain("24.11.2");
    expect(restarts()).toEqual([]);
  });

  it("does not repoint when the checksum does not match", async () => {
    await start({ instances: { family: true } });
    h.net.badChecksum = true;
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(1);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
  });

  it("does not repoint when a Release's native modules fail on the new patch", async () => {
    await start({ instances: { family: true } });
    h.net.brokenDirs = [join(h.ctx.paths.releases, "26.11.1")];
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(1);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
    expect(restarts()).toEqual([]);
  });

  it("goes on after an Instance fails to restart, then fails the command naming it", async () => {
    await start({ instances: { a: true, b: true }, restartFails: ["a"] });
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(1);
    expect(restarts()).toEqual(["dcabsm@a", "dcabsm@b"]);
    expect(h.err.join("\n")).toContain("a");
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.2");
  });

  it("says so when every major is on its newest patch", async () => {
    await start({ instances: { family: true } });
    h.net.index.shift();
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(0);
    expect(text()).toContain("newest patch");
    expect(restarts()).toEqual([]);
  });

  it("reports an end-of-life major", async () => {
    await start({ instances: { family: true } });
    h.net.nodeEnd["v24"] = "2026-10-01";
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(0);
    expect(text()).toContain("Node 24 is end of life (since 2026-10-01)");
  });

  it("reports an end-of-life major that has no newer patch", async () => {
    await start({ instances: {} });
    h.net.index.shift();
    h.net.nodeEnd["v24"] = "2026-10-01";
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(0);
    expect(text()).toContain("Node 24 is end of life");
  });

  it("changes nothing when nodejs.org cannot be reached", async () => {
    await start({ instances: { family: true } });
    h.net.down = ["nodejs.org"];
    expect(await run(["release", "update-node", "--yes"], h.ctx)).toBe(1);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
  });
});
