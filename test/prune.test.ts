import { mkdir, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { makeReadOnly } from "../src/fsutil.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

async function start(opts: HarnessOptions = {}): Promise<void> {
  h = await harness(opts);
  for (const dir of [h.ctx.paths.releases, h.ctx.paths.node, h.ctx.paths.instances]) {
    await mkdir(dir, { recursive: true });
  }
}

async function release(version: string, major: number): Promise<void> {
  const dir = join(h.ctx.paths.releases, version);
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await writeFile(join(dir, ".dcabsm-node-major"), `${major}\n`);
  await writeFile(join(dir, "node_modules", "x.js"), "");
  await makeReadOnly(dir);
}

async function runtime(patch: string, linkMajor?: number): Promise<void> {
  await mkdir(join(h.ctx.paths.node, patch, "bin"), { recursive: true });
  await writeFile(join(h.ctx.paths.node, patch, "bin", "node"), "");
  if (linkMajor !== undefined) await symlink(patch, join(h.ctx.paths.node, String(linkMajor)));
}

async function instance(name: string, version: string, marker?: string): Promise<void> {
  const dir = join(h.ctx.paths.instances, name);
  await mkdir(dir, { recursive: true });
  await symlink(join(h.ctx.paths.releases, version), join(dir, "release"));
  if (marker !== undefined) await writeFile(join(dir, ".changing-release"), marker);
}

const ls = async (dir: string) => (await readdir(dir)).sort();
const prune = (...flags: string[]) => run(["release", "prune", ...flags], h.ctx);

describe("release prune", () => {
  it("removes a Release no Instance uses and keeps one an Instance links to", async () => {
    await start();
    await release("26.10.0", 24);
    await release("26.11.0", 24);
    await runtime("24.11.1", 24);
    await instance("family", "26.11.0");
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.11.0"]);
    expect(h.out).toContain("  ✓ Removed Release 26.10.0");
    expect(h.out).toContain(
      "  · A rollback to a removed Release reinstalls it from npm, without its old lockfile.",
    );
  });

  it("keeps a Release that a .changing-release marker names, as from or to", async () => {
    await start();
    await release("26.10.0", 24);
    await release("26.11.0", 24);
    await release("26.12.0", 24);
    await runtime("24.11.1", 24);
    await instance(
      "family",
      "26.12.0",
      JSON.stringify({ from: "26.10.0", to: "26.11.0", backup: "/b/26.99.0.tar.gz" }),
    );
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.10.0", "26.11.0", "26.12.0"]);
    expect(h.out).toEqual(["No unused Releases."]);
  });

  it("does not take a version for one that only prefixes a version in the marker", async () => {
    await start();
    await release("26.1.0", 24);
    await release("26.10.0", 24);
    await runtime("24.11.1", 24);
    await instance("family", "26.10.0", "from=26.10.0");
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.10.0"]);
  });

  it("removes a Node runtime no remaining Release uses, with its major link", async () => {
    await start();
    await release("26.10.0", 22);
    await release("26.11.0", 24);
    await runtime("22.20.0", 22);
    await runtime("24.11.1", 24);
    await instance("family", "26.11.0");
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.node)).toEqual(["24", "24.11.1"]);
    expect(await readlink(join(h.ctx.paths.node, "24"))).toBe("24.11.1");
  });

  it("removes an older patch of a major a kept Release uses", async () => {
    await start();
    await release("26.11.0", 24);
    await runtime("24.11.1");
    await runtime("24.11.2", 24);
    await instance("family", "26.11.0");
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.node)).toEqual(["24", "24.11.2"]);
  });

  it("keeps a Node runtime used by a Release the marker keeps", async () => {
    await start();
    await release("26.10.0", 22);
    await release("26.11.0", 24);
    await runtime("22.20.0", 22);
    await runtime("24.11.1", 24);
    await instance("family", "26.11.0", JSON.stringify({ from: "26.10.0", to: "26.11.0" }));
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.node)).toEqual(["22", "22.20.0", "24", "24.11.1"]);
  });

  it("leaves dot-prefixed work directories alone and runs no command", async () => {
    await start();
    await release("26.10.0", 24);
    await runtime("24.11.1", 24);
    await mkdir(join(h.ctx.paths.node, ".installing-24.12.0"));
    await mkdir(join(h.ctx.paths.releases, ".installing-26.12.0"));
    await mkdir(join(h.ctx.paths.instances, ".restoring"));
    expect(await prune("--yes")).toBe(0);
    expect(await ls(h.ctx.paths.releases)).toEqual([".installing-26.12.0"]);
    expect(await ls(h.ctx.paths.node)).toEqual([".installing-24.12.0"]);
    expect(h.calls.filter((c) => c.command !== "logger")).toEqual([]);
  });

  it("says so and changes nothing when everything is used", async () => {
    await start();
    await release("26.11.0", 24);
    await runtime("24.11.1", 24);
    await instance("family", "26.11.0");
    expect(await prune()).toBe(0);
    expect(h.out).toEqual(["No unused Releases."]);
    expect(h.asked).toEqual([]);
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.11.0"]);
  });

  it("lists what will go and asks before removing, then removes on y", async () => {
    await start({ interactive: true, answers: ["y"] });
    await release("26.10.0", 22);
    await release("26.11.0", 24);
    await runtime("22.20.0", 22);
    await runtime("24.11.1", 24);
    await instance("family", "26.11.0");
    expect(await prune()).toBe(0);
    expect(h.out.slice(0, 2)).toEqual(["  · Release 26.10.0", "  · Node runtime 22.20.0"]);
    expect(h.asked).toEqual([
      "Remove these unused Releases and any Node runtime no Release uses? [y/N] ",
    ]);
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.11.0"]);
    expect(await ls(h.ctx.paths.node)).toEqual(["24", "24.11.1"]);
  });

  it("removes nothing when the answer is not yes", async () => {
    await start({ interactive: true, answers: [""] });
    await release("26.10.0", 24);
    await runtime("24.11.1", 24);
    expect(await prune()).toBe(1);
    expect(h.out).toContain("Cancelled. Nothing changed.");
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.10.0"]);
    expect(await ls(h.ctx.paths.node)).toEqual(["24", "24.11.1"]);
  });

  it("refuses without a terminal unless --yes", async () => {
    await start();
    await release("26.10.0", 24);
    expect(await prune()).toBe(2);
    expect(h.err[0]).toContain("No terminal to confirm on.");
    expect(await ls(h.ctx.paths.releases)).toEqual(["26.10.0"]);
  });

  it("refuses an unknown flag or argument", async () => {
    await start();
    expect(await prune("--force")).toBe(2);
    expect(await prune("26.10.0")).toBe(2);
  });
});
