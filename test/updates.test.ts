import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { updateFooter } from "../src/host/updates.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";
import { fakeNet } from "./fakenet.ts";

let h: Harness;
afterEach(() => h.cleanup());

/** A set-up Host with Releases and Node majors installed, as `release install` leaves them. */
async function start(
  opts: HarnessOptions & { releases?: string[]; node?: Record<number, string> } = {},
): Promise<void> {
  h = await harness(opts);
  for (const v of opts.releases ?? ["26.11.0"]) {
    await mkdir(join(h.ctx.paths.releases, v), { recursive: true });
  }
  await mkdir(h.ctx.paths.node, { recursive: true });
  for (const [major, patch] of Object.entries(opts.node ?? { 24: "24.11.0" })) {
    await mkdir(join(h.ctx.paths.node, patch), { recursive: true });
    await symlink(patch, join(h.ctx.paths.node, major));
  }
}

const check = () => run(["host", "check-updates"], h.ctx);
const stored = async () => JSON.parse(await readFile(h.ctx.paths.updateCheck, "utf8"));

describe("host check-updates", () => {
  it("reports a newer Release, Node patch and DCABSM version and stores the result", async () => {
    await start();
    expect(await check()).toBe(0);
    expect(h.out).toEqual([
      "  ✓ Actual 26.11.1 is available (newest installed: 26.11.0)",
      "  ✓ DCABSM 1.3.0 is available (this is 0.0.0-dev): sudo dcabsm self update",
      "  ✓ Node 24.11.1 patch for Node 24 (installed 24.11.0): sudo dcabsm release update-node",
      "  · instance list shows this result until the next check. Ordinary commands never use the network.",
    ]);
    expect(await stored()).toEqual({
      checkedAt: "2026-11-09T12:00:00.000Z",
      actual: "26.11.1",
      dcabsm: "1.3.0",
      node: { "24": { latest: "24.11.1" } },
    });
  });

  it("says so when everything is current", async () => {
    await start({
      releases: ["26.11.1"],
      node: { 24: "24.11.1" },
      net: fakeNet({ dcabsmLatest: "0.0.0" }),
    });
    expect(await check()).toBe(0);
    expect(h.out.slice(0, 3)).toEqual([
      "  ✓ Actual 26.11.1 is the latest stable Release",
      "  ✓ DCABSM 0.0.0 is the latest version",
      "  ✓ Node 24 is on its newest patch (24.11.1)",
    ]);
  });

  it("reports an installed Node major that is end of life", async () => {
    await start({ node: { 24: "24.11.1", 20: "20.19.5" } });
    await check();
    expect(h.out).toContain(
      "  ! Node 20 is end of life (since 2026-04-30): sudo dcabsm release update-node",
    );
    expect((await stored()).node["20"]).toEqual({ latest: "20.19.5", eol: "2026-04-30" });
  });

  it("warns when npm is down, still checks the rest and keeps the earlier Release result", async () => {
    await start();
    await check();
    h.out.length = 0;
    h.net.down = ["registry.npmjs.org"];
    h.net.dcabsmLatest = "1.4.0";
    expect(await check()).toBe(0);
    expect(h.out[0]).toMatch(/^ {2}! Could not reach the npm registry: /);
    expect(h.out).toContain(
      "  ✓ DCABSM 1.4.0 is available (this is 0.0.0-dev): sudo dcabsm self update",
    );
    const doc = await stored();
    expect(doc.actual).toBe("26.11.1");
    expect(doc.dcabsm).toBe("1.4.0");
  });

  it("works with no Releases or Node installed", async () => {
    await start({ releases: [], node: {} });
    expect(await check()).toBe(0);
    expect(h.out[0]).toBe("  ✓ Actual 26.11.1 is the latest stable Release");
    expect((await stored()).node).toEqual({});
  });

  it("is the only command that fetches: release list fetches nothing", async () => {
    await start();
    await run(["release", "list"], h.ctx);
    expect(h.net.fetched).toEqual([]);
  });
});

describe("updateFooter", () => {
  it("points to the check when none has run", async () => {
    await start();
    expect(await updateFooter(h.ctx)).toEqual({
      lastCheck: undefined,
      lines: ["→ No update check yet: sudo dcabsm host check-updates"],
    });
  });

  it("shows the last result without the network", async () => {
    await start();
    await check();
    h.net.fetched.length = 0;
    expect(await updateFooter(h.ctx)).toEqual({
      lastCheck: "2026-11-09 12:00 UTC",
      lines: [
        "→ Actual 26.11.1 is available: sudo dcabsm instance upgrade <names>|--all",
        "→ DCABSM 1.3.0 is available: sudo dcabsm self update",
        "→ Node 24.11.1 patch for Node 24: sudo dcabsm release update-node",
      ],
    });
    expect(h.net.fetched).toEqual([]);
  });

  it("drops what has since been installed", async () => {
    await start({ node: { 24: "24.11.0", 20: "20.19.5" } });
    await check();
    await mkdir(join(h.ctx.paths.releases, "26.11.1"));
    await rm(join(h.ctx.paths.node, "24"));
    await symlink("24.11.1", join(h.ctx.paths.node, "24"));
    const { lines } = await updateFooter(h.ctx);
    expect(lines).toEqual([
      "→ DCABSM 1.3.0 is available: sudo dcabsm self update",
      "→ Node 20 is end of life: sudo dcabsm release update-node",
    ]);
  });
});
