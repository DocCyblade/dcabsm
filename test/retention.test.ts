import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const BACKUPS = "/srv/dcabsm/backups";

async function start(config: object = {}): Promise<void> {
  h = await harness();
  await writeFile(h.ctx.paths.hostConfig, JSON.stringify(config));
  for (const name of ["family", "test"]) {
    await mkdir(join(h.ctx.paths.instances, name, "config"), { recursive: true });
    await writeFile(
      join(h.ctx.paths.instances, name, "config", "instance.json"),
      JSON.stringify({ hostname: `${name}.example.org`, port: 15127 }),
    );
  }
}

/** `n` archives of a kind on consecutive days from the 1st, oldest first. */
async function archives(dir: string, kind: string, n: number): Promise<string[]> {
  const d = h.ctx.paths.under(`${BACKUPS}/${dir}`);
  await mkdir(d, { recursive: true });
  const files: string[] = [];
  for (let i = 1; i <= n; i++) {
    const file = `202610${String(i).padStart(2, "0")}T033000Z-${kind}-26.10.0.tar.gz`;
    await writeFile(join(d, file), "x");
    files.push(file);
  }
  return files;
}

const left = async (dir: string): Promise<string[]> =>
  (await readdir(h.ctx.paths.under(`${BACKUPS}/${dir}`))).sort();

describe("backup prune", () => {
  it("keeps the newest of each kind by the defaults and never touches manual", async () => {
    await start();
    const sched = await archives("family", "scheduled", 16);
    const up = await archives("family", "pre-upgrade", 7);
    const manual = await archives("family", "manual", 20);
    expect(await run(["backup", "prune", "family"], h.ctx)).toBe(0);
    const now = await left("family");
    expect(now.filter((f) => f.includes("-scheduled-"))).toEqual(sched.slice(2));
    expect(now.filter((f) => f.includes("-pre-upgrade-"))).toEqual(up.slice(2));
    expect(now.filter((f) => f.includes("-manual-"))).toEqual(manual);
    expect(h.out.join("\n")).toContain(`Deleted family/${sched[0]}`);
  });

  it("--dry-run lists and deletes nothing", async () => {
    await start();
    const sched = await archives("family", "scheduled", 15);
    expect(await run(["backup", "prune", "--dry-run"], h.ctx)).toBe(0);
    expect(await left("family")).toEqual(sched);
    expect(h.out.join("\n")).toContain(`Would delete family/${sched[0]}`);
  });

  it("counts per Instance and takes names or --all", async () => {
    await start({ keep: { scheduled: 2 } });
    await archives("family", "scheduled", 4);
    await archives("test", "scheduled", 4);
    expect(await run(["backup", "prune", "test"], h.ctx)).toBe(0);
    expect(await left("family")).toHaveLength(4);
    expect(await left("test")).toHaveLength(2);
    expect(await run(["backup", "prune", "--all"], h.ctx)).toBe(0);
    expect(await left("family")).toHaveLength(2);
  });

  it("never deletes the newest pre-upgrade, at the lowest count, 1", async () => {
    await start({ keep: { "pre-upgrade": 1 } });
    const up = await archives("family", "pre-upgrade", 3);
    expect(await run(["backup", "prune"], h.ctx)).toBe(0);
    expect(await left("family")).toEqual([up[2]]);
  });

  it("leaves .removed- folders alone", async () => {
    await start();
    const dir = "old.removed-20261101T000000Z";
    const fin = await archives(dir, "final", 3);
    const sched = await archives(dir, "scheduled", 30);
    expect(await run(["backup", "prune", "--all"], h.ctx)).toBe(0);
    expect(await left(dir)).toEqual([...fin, ...sched].sort());
  });

  it("says so when there is nothing to prune", async () => {
    await start();
    await archives("family", "scheduled", 3);
    expect(await run(["backup", "prune"], h.ctx)).toBe(0);
    expect(h.out.join("\n")).toContain(
      "Nothing to prune. Keeping newest 14 scheduled, 5 pre-upgrade, 5 pre-restore, 5 pre-clone; manual backups are never pruned.",
    );
  });

  it("refuses an unknown Instance and names together with --all", async () => {
    await start();
    expect(await run(["backup", "prune", "nope"], h.ctx)).toBe(2);
    expect(await run(["backup", "prune", "family", "--all"], h.ctx)).toBe(2);
  });
});

describe("host settings and host set", () => {
  const read = async () => JSON.parse(await readFile(h.ctx.paths.hostConfig, "utf8"));

  it("shows every setting with defaults", async () => {
    await start();
    expect(await run(["host", "settings"], h.ctx)).toBe(0);
    expect(h.out).toEqual([
      "  backup-dir        /srv/dcabsm/backups  (set at setup)",
      "  nightly-time      03:30",
      "  keep-scheduled    14",
      "  keep-pre-upgrade  5",
      "  keep-pre-restore  5",
      "  keep-pre-clone    5",
    ]);
  });

  it("marks a hand-edited count that Retention can't use", async () => {
    await start({ keep: { scheduled: 0, "pre-upgrade": 7 } });
    await run(["host", "settings"], h.ctx);
    const text = h.out.join("\n");
    expect(text).toContain("keep-scheduled    14  (stored value invalid, using default)");
    expect(text).toContain("keep-pre-upgrade  7\n");
  });

  it("sets a keep count and shows it", async () => {
    await start({ backupDir: "/mnt/b" });
    expect(await run(["host", "set", "keep-scheduled", "30"], h.ctx)).toBe(0);
    expect((await read()).keep.scheduled).toBe(30);
    expect((await read()).keep["pre-clone"]).toBe(5);
    h.out.length = 0;
    await run(["host", "settings"], h.ctx);
    expect(h.out[0]).toContain("/mnt/b");
    expect(h.out.join("\n")).toContain("keep-scheduled    30");
  });

  it.each(["0", "-1", "1.5", "abc", ""])("refuses keep count %j", async (v) => {
    await start();
    expect(await run(["host", "set", "keep-scheduled", v], h.ctx)).toBe(2);
    expect((await read()).keep).toBeUndefined();
  });

  it("refuses unknown keys, backup-dir, manual and final", async () => {
    await start();
    for (const key of ["backup-dir", "keep-manual", "keep-final", "colour"]) {
      expect(await run(["host", "set", key, "3"], h.ctx)).toBe(2);
    }
  });

  it("regenerates the timer on a new nightly-time", async () => {
    await start();
    const timer = h.ctx.paths.under("/etc/systemd/system/dcabsm-nightly.timer");
    expect(await run(["host", "set", "nightly-time", "03:45"], h.ctx)).toBe(0);
    expect(await readFile(timer, "utf8")).toContain("03:45:00");
    expect(await run(["host", "set", "nightly-time", "04:15"], h.ctx)).toBe(0);
    expect(await readFile(timer, "utf8")).toContain("04:15:00");
    expect((await read()).nightlyTime).toBe("04:15");
    expect(h.calls.map((c) => c.args.join(" "))).toContain("restart dcabsm-nightly.timer");
  });

  it("refuses a bad time", async () => {
    await start();
    for (const v of ["25:00", "3:30", "0330", "03:60"]) {
      expect(await run(["host", "set", "nightly-time", v], h.ctx)).toBe(2);
    }
  });
});
