import { access, chmod, chown, mkdir, rename, writeFile } from "node:fs/promises";

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
