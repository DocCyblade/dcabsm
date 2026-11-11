import { copyFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { regroup } from "../src/instance/regroup.ts";

/**
 * `account.sqlite` in test/fixtures/actual-<release>/ is the one Actual's own migrations create for
 * that Release (see the README there). Group files get the schema Actual's `getGroupDb` creates.
 */
const GROUP_SCHEMA = `
CREATE TABLE messages_binary (timestamp TEXT PRIMARY KEY, is_encrypted BOOLEAN, content bytea);
CREATE TABLE messages_merkles (id INTEGER PRIMARY KEY, merkle TEXT);`;

let dir: string;
afterEach(() => rm(dir, { recursive: true, force: true }));

async function layout(release: string) {
  dir = await mkdtemp(join(tmpdir(), "dcabsm-regroup-"));
  const serverFiles = join(dir, "server-files");
  const userFiles = join(dir, "user-files");
  await mkdir(serverFiles);
  await mkdir(userFiles);
  copyFileSync(
    join(import.meta.dirname, "fixtures", `actual-${release}`, "account.sqlite"),
    join(serverFiles, "account.sqlite"),
  );
  return { serverFiles, userFiles };
}

function addBudget(serverFiles: string, userFiles: string, id: string, group: string | null) {
  const db = new DatabaseSync(join(serverFiles, "account.sqlite"));
  db.prepare(
    "INSERT INTO files (id, group_id, sync_version, name, deleted) VALUES (?, ?, 2, ?, 0)",
  ).run(id, group, `budget ${id}`);
  db.close();
  if (group === null) return;
  const g = new DatabaseSync(join(userFiles, `group-${group}.sqlite`));
  g.exec(GROUP_SCHEMA);
  g.prepare("INSERT INTO messages_binary VALUES (?, 0, ?)").run(`ts-${id}-1`, Buffer.from("one"));
  g.prepare("INSERT INTO messages_binary VALUES (?, 0, ?)").run(`ts-${id}-2`, Buffer.from("two"));
  g.prepare("INSERT INTO messages_merkles VALUES (1, ?)").run(`{"merkle-of":"${id}"}`);
  g.close();
}

describe.each(["26.10.0", "26.11.0"])("regroup on a real Actual %s account.sqlite", (release) => {
  it("gives each Budget file a new group id and renames its group file, keeping every message", async () => {
    const { serverFiles, userFiles } = await layout(release);
    addBudget(serverFiles, userFiles, "file-a", "old-group-a");
    addBudget(serverFiles, userFiles, "file-b", "old-group-b");
    addBudget(serverFiles, userFiles, "file-reset", null);

    expect(await regroup(serverFiles, userFiles)).toBe(2);

    const db = new DatabaseSync(join(serverFiles, "account.sqlite"));
    const rows = db.prepare("SELECT id, group_id, name FROM files ORDER BY id").all() as Array<{
      id: string;
      group_id: string | null;
      name: string;
    }>;
    db.close();
    const [a, b, reset] = rows;
    expect(reset!.group_id).toBeNull();
    for (const [row, old] of [
      [a!, "old-group-a"],
      [b!, "old-group-b"],
    ] as const) {
      expect(row.group_id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(row.group_id).not.toBe(old);
      expect(row.name).toBe(`budget ${row.id}`);
      expect(existsSync(join(userFiles, `group-${old}.sqlite`))).toBe(false);
    }
    expect(a!.group_id).not.toBe(b!.group_id);
    expect((await readdir(userFiles)).sort()).toEqual(
      [`group-${a!.group_id}.sqlite`, `group-${b!.group_id}.sqlite`].sort(),
    );

    const g = new DatabaseSync(join(userFiles, `group-${a!.group_id}.sqlite`));
    expect(g.prepare("SELECT timestamp FROM messages_binary ORDER BY timestamp").all()).toEqual([
      expect.objectContaining({ timestamp: "ts-file-a-1" }),
      expect.objectContaining({ timestamp: "ts-file-a-2" }),
    ]);
    expect(g.prepare("SELECT merkle FROM messages_merkles").get()).toEqual(
      expect.objectContaining({ merkle: '{"merkle-of":"file-a"}' }),
    );
    g.close();
  });

  it("regroups nothing when there are no Budget files", async () => {
    const { serverFiles, userFiles } = await layout(release);
    expect(await regroup(serverFiles, userFiles)).toBe(0);
  });
});

describe("regroup", () => {
  it("still gives a new id to a Budget file whose group file is missing", async () => {
    const { serverFiles, userFiles } = await layout("26.11.0");
    addBudget(serverFiles, userFiles, "file-a", "old-group-a");
    await rm(join(userFiles, "group-old-group-a.sqlite"));
    expect(await regroup(serverFiles, userFiles)).toBe(1);
    const db = new DatabaseSync(join(serverFiles, "account.sqlite"));
    expect(db.prepare("SELECT group_id FROM files").get()).not.toEqual(
      expect.objectContaining({ group_id: "old-group-a" }),
    );
    db.close();
  });
});
