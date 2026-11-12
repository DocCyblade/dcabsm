import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { CliError, firstLine, refusal } from "../errors.ts";
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

/**
 * Refuses an archive that holds anything but plain files and directories, or a name that is absolute
 * or climbs with `..`. Our own archives hold nothing else, and tar runs as root when it extracts, so a
 * symlink, hard link, device node, pipe or setuid file in an archive from elsewhere is an attack, not data.
 */
export async function vetArchive(ctx: Context, archive: string): Promise<void> {
  const names = await ctx.runner.run("tar", ["-tzf", archive]);
  const kinds = await ctx.runner.run("tar", ["-tvzf", archive]);
  if (names.code !== 0 || kinds.code !== 0) {
    throw new CliError(
      `tar could not read ${archive}: ${firstLine(names.stderr || kinds.stderr, "not a readable archive")}`,
    );
  }
  const nameLines = names.stdout.split("\n").filter((l) => l !== "");
  const kindLines = kinds.stdout.split("\n").filter((l) => l !== "");
  const unsafe = (why: string, name: string) =>
    new CliError(
      `${archive} holds an unsafe entry (${why}): ${JSON.stringify(name)}.`,
      "A DCABSM archive holds only files and directories. Do not restore an archive you do not trust.",
    );
  if (nameLines.length !== kindLines.length) throw unsafe("odd entry names", archive);
  nameLines.forEach((name, i) => {
    const kind = kindLines[i]![0];
    if (kind !== "-" && kind !== "d") throw unsafe(`type ${kind}, not a file or directory`, name);
    const perms = kindLines[i]!.slice(0, 10);
    if (/[sS]/.test(perms[3]! + perms[6]!)) throw unsafe("setuid or setgid bit", name);
    if (name.startsWith("/") || name.split("/").includes("..")) {
      throw unsafe("path leaves the archive", name);
    }
  });
}

/**
 * Reads and checks `manifest.json` from an archive. Refuses a newer format (spec 7.1). It also
 * vets the archive, so every restore or clone from a given archive stops here before it changes anything.
 */
export async function readManifest(ctx: Context, archive: string): Promise<Manifest> {
  await vetArchive(ctx, archive);
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
