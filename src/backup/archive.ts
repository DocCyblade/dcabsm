import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { DEFAULT_BACKUP_DIR, readHostConfig } from "../host/config.ts";

/** The archive format this DCABSM writes (spec 7.1). Older formats are read for good. */
export const ARCHIVE_FORMAT = 1;

/** The Backup kinds (spec 7.2). */
export const KINDS = [
  "manual",
  "scheduled",
  "pre-upgrade",
  "pre-restore",
  "pre-clone",
  "final",
] as const;
export type Kind = (typeof KINDS)[number];

/** `manifest.json`, the first member of every archive (spec 7.1). */
export interface Manifest {
  format: number;
  name: string;
  kind: string;
  /** UTC, `2026-11-07T14:12:00Z`. */
  time: string;
  release: string;
  /** For information only. */
  node: string;
  dcabsm: string;
  hostname: string;
}

/** The backup directory as the Host sees it, for text shown to the System Admin. */
export async function logicalBackupRoot(ctx: Context): Promise<string> {
  return (await readHostConfig(ctx))?.backupDir ?? DEFAULT_BACKUP_DIR;
}

/** The backup directory on disk, under the root. */
export async function backupRoot(ctx: Context): Promise<string> {
  return ctx.paths.under(await logicalBackupRoot(ctx));
}

/** The path of an archive in an Instance's Backups, from the file name `takeBackup` returned. */
export async function backupPath(ctx: Context, name: string, file: string): Promise<string> {
  return join(await backupRoot(ctx), name, file);
}

/** Refuses a path that is not a file: the check for an archive given on the command line. */
export async function requireArchiveFile(archive: string): Promise<void> {
  const found = await stat(archive).catch(() => undefined);
  if (!found?.isFile()) {
    throw refusal(`${archive} is not an archive file.`, "Give the path of a .tar.gz archive.");
  }
}

/** `20261107T141200Z` */
export function timeStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/[-:]/g, "");
}

/** The time a `timeStamp` names. */
export const stampTime = (stamp: string): Date =>
  new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );

export const archiveName = (time: Date, kind: Kind, release: string): string =>
  `${timeStamp(time)}-${kind}-${release}.tar.gz`;

export interface ArchiveName {
  stamp: string;
  kind: string;
  release: string;
}

const NAME_PATTERN = new RegExp(`^(\\d{8}T\\d{6}Z)-(${KINDS.join("|")})-(.+)\\.tar\\.gz$`);

/** The facts in an archive's name, or undefined if it isn't one of ours. */
export function parseArchiveName(file: string): ArchiveName | undefined {
  const m = NAME_PATTERN.exec(file);
  return m ? { stamp: m[1]!, kind: m[2]!, release: m[3]! } : undefined;
}

export interface ArchiveInfo extends ArchiveName {
  file: string;
  path: string;
  size: number;
}

/** The archives in `backups/<name>/`, oldest first. Dot-prefixed temporary files are ignored. */
export async function listArchives(ctx: Context, name: string): Promise<ArchiveInfo[]> {
  const dir = join(await backupRoot(ctx), name);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const found: ArchiveInfo[] = [];
  for (const file of files) {
    const parsed = parseArchiveName(file);
    if (!parsed) continue;
    const path = join(dir, file);
    found.push({ ...parsed, file, path, size: (await stat(path)).size });
  }
  return found.sort((a, b) => a.stamp.localeCompare(b.stamp));
}

/** Reads and checks `manifest.json` from an archive. Refuses a newer format (spec 7.1). */
export async function readManifest(ctx: Context, archive: string): Promise<Manifest> {
  const res = await ctx.runner.run("tar", ["-xzOf", archive, "manifest.json"]);
  let manifest: Partial<Manifest> | undefined;
  try {
    if (res.code === 0) manifest = JSON.parse(res.stdout) as Partial<Manifest>;
  } catch {
    manifest = undefined;
  }
  if (!manifest || typeof manifest.format !== "number") {
    throw new CliError(`${archive} is not a DCABSM archive: it has no readable manifest.json.`);
  }
  if (manifest.format > ARCHIVE_FORMAT) {
    throw refusal(
      `${archive} is archive format ${manifest.format}, newer than this DCABSM reads (${ARCHIVE_FORMAT}).`,
      "Update DCABSM, then run again: sudo dcabsm self update",
    );
  }
  return manifest as Manifest;
}
