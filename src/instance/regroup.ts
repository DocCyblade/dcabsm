import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exists } from "../fsutil.ts";

/** The files SQLite may keep beside a database. */
const SIDECARS = ["", "-wal", "-shm"];

async function renameGroup(userFiles: string, from: string, to: string): Promise<void> {
  for (const suffix of SIDECARS) {
    const source = join(userFiles, `group-${from}.sqlite${suffix}`);
    if (await exists(source)) await rename(source, join(userFiles, `group-${to}.sqlite${suffix}`));
  }
}

/**
 * Regroup (spec 7.5, ADR-0004): gives each Budget file in `account.sqlite` a new group id and renames
 * its `group-<id>.sqlite` to match, keeping every message. A device that holds the old id is told the
 * file was reset. Budget files that were never uploaded have no group id and stay as they are.
 * Returns how many Budget files were regrouped.
 *
 * Group files move first and the table is updated in one transaction, so a failure puts the group
 * files back and `account.sqlite` is untouched.
 */
export async function regroup(serverFiles: string, userFiles: string): Promise<number> {
  const db = new DatabaseSync(join(serverFiles, "account.sqlite"));
  const moved: Array<{ from: string; to: string }> = [];
  try {
    const rows = db
      .prepare("SELECT id, group_id FROM files WHERE group_id IS NOT NULL")
      .all() as Array<{
      id: string;
      group_id: string;
    }>;
    const update = db.prepare("UPDATE files SET group_id = ? WHERE id = ?");
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const to = randomUUID();
        await renameGroup(userFiles, row.group_id, to);
        moved.push({ from: row.group_id, to });
        update.run(to, row.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      for (const { from, to } of moved.reverse()) await renameGroup(userFiles, to, from);
      throw err;
    }
    return rows.length;
  } finally {
    db.close();
  }
}
