import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.ts";
import { MIGRATIONS } from "../src/self/migrations.ts";
import { harness, type Harness } from "./helpers.ts";

// The running DCABSM is 1.3.0 here, so versions compare.
vi.mock("../src/version.ts", () => ({
  VERSION: "1.3.0",
  LAYOUT: 1,
  versionLine: () => "DCABSM 1.3.0 (layout 1)",
}));

let h: Harness;
afterEach(() => {
  delete MIGRATIONS[1];
  return h.cleanup();
});

async function start(layout: number): Promise<void> {
  h = await harness({});
  const { paths } = h.ctx;
  await mkdir(join(paths.installDir, "share"), { recursive: true });
  await writeFile(paths.signingKey, "OLDKEY");
  await mkdir(join(paths.binLink, ".."), { recursive: true });
  await symlink("/opt/dcabsm/1.3.0/bin/dcabsm", paths.binLink);
  await writeFile(paths.hostConfig, JSON.stringify({ layout, ownedFiles: {} }));
}
const update = (...args: string[]) => run(["self", "update", "--yes", ...args], h.ctx);
const hostJson = async () => JSON.parse(await readFile(h.ctx.paths.hostConfig, "utf8"));
const downloads = () => h.net.fetched.filter((u) => u.includes("releases/download"));

describe("self update without --to", () => {
  it("reports up to date when the latest is the running version", async () => {
    await start(1);
    h.net.dcabsmLatest = "1.3.0";
    expect(await update()).toBe(0);
    expect(h.out).toEqual(["DCABSM 1.3.0 is already installed."]);
    expect(downloads()).toEqual([]);
  });

  it("refuses when the running version is ahead of the latest", async () => {
    await start(1);
    h.net.dcabsmLatest = "1.1.0";
    expect(await update()).toBe(2);
    expect(h.err[0]).toContain("ahead of the latest");
    expect(h.err[1]).toContain("--to 1.1.0");
    expect(downloads()).toEqual([]);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/1.3.0/bin/dcabsm");
  });

  it("still goes down with an explicit --to", async () => {
    await start(1);
    expect(await update("--to", "1.1.0")).toBe(0);
    expect(await readlink(h.ctx.paths.binLink)).toBe("/opt/dcabsm/1.1.0/bin/dcabsm");
  });
});

describe("self update --to the running version", () => {
  it("migrates a lower stored layout in place", async () => {
    await start(0);
    MIGRATIONS[1] = async () => {};
    expect(await update("--to", "1.3.0")).toBe(0);
    expect(await hostJson()).toMatchObject({ layout: 1, layoutSince: "1.3.0" });
    expect(h.out).toContain("  ✓ Copied /etc/dcabsm aside, migrated layout 0 → 1");
    expect(downloads()).toEqual([]);
  });
});
