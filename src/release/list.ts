import { readdir, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { formatColumns } from "../columns.ts";
import type { Context } from "../context.ts";
import type { Invocation } from "../table.ts";
import { installedReleases, releaseNodeMajor } from "./install.ts";
import { linkedPatch } from "./node.ts";

/** Instance names by the Release their `release` symlink points to. Dot-prefixed names are ignored. */
async function instancesByRelease(ctx: Context): Promise<Map<string, string[]>> {
  const used = new Map<string, string[]>();
  let names: string[];
  try {
    names = await readdir(ctx.paths.instances);
  } catch {
    return used;
  }
  for (const name of names.filter((n) => !n.startsWith(".")).sort()) {
    try {
      const target = basename(await readlink(join(ctx.paths.instances, name, "release")));
      used.set(target, [...(used.get(target) ?? []), name]);
    } catch {
      // No release link: the Instance is not on any Release.
    }
  }
  return used;
}

/** `release list` (docs/cli.md). */
export async function releaseList({ ctx }: Invocation): Promise<void> {
  const releases = await installedReleases(ctx);
  if (releases.length === 0) {
    ctx.io.out("No Releases installed.");
    ctx.io.out("  Install one: sudo dcabsm release install <v>");
    return;
  }
  const used = await instancesByRelease(ctx);
  const rows = [["RELEASE", "NODE", "USED BY"]];
  for (const version of releases) {
    const major = await releaseNodeMajor(ctx, version);
    const patch = major === undefined ? undefined : await linkedPatch(ctx, major);
    rows.push([version, patch ?? "?", (used.get(version) ?? []).join(", ") || "-"]);
  }
  for (const line of formatColumns(rows)) ctx.io.out(line);
}
