import { access, chmod, chown, lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Only root can hand a file to root; anyone else already owns what they just made. */
async function ownedByRoot(path: string): Promise<void> {
  if (process.getuid?.() === 0) await chown(path, 0, 0);
}

export async function ensureDir(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  await chmod(path, mode);
  await ownedByRoot(path);
}

/** Writes through a temporary name, so a crash never leaves half a file. */
export async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await ownedByRoot(tmp);
  await rename(tmp, path);
}

async function walk(path: string, visit: (p: string, isDir: boolean) => Promise<void>) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await visit(path, true);
    for (const name of await readdir(path)) await walk(join(path, name), visit);
  } else {
    await visit(path, false);
  }
}

/** Takes the write bits off a tree, so nothing can change it (spec 2.2). Symlinks are left alone. */
export async function makeReadOnly(path: string): Promise<void> {
  const files: string[] = [];
  const dirs: string[] = [];
  await walk(path, async (p, isDir) => {
    (isDir ? dirs : files).push(p);
  });
  for (const p of files) await chmod(p, (await lstat(p)).mode & 0o555);
  for (const p of dirs.reverse()) await chmod(p, (await lstat(p)).mode & 0o555);
}

/** Undoes `makeReadOnly`, so a tree can be deleted. A missing path is fine. */
export async function makeWritable(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await walk(path, async (p, isDir) => {
    if (!isDir) return;
    await chmod(p, (await lstat(p)).mode | 0o700);
  });
}
