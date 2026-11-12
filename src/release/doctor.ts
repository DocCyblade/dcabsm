import { chmod, lstat, readlink, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import type { Check, CheckResult } from "../host/checks.ts";
import { installedReleases, releaseNodeMajor } from "./install.ts";

/** Where a Release's `node` link should point: the runtime link of its recorded major (spec 3.1). */
const wantedLink = (ctx: Context, major: number): string => join(ctx.paths.node, String(major));

/** What the Release's `node` link points to, or undefined when there is no link. */
async function linkOf(dir: string): Promise<string | undefined> {
  try {
    return await readlink(join(dir, "node"));
  } catch {
    return undefined;
  }
}

/** Repoints the link inside a read-only Release directory, and leaves the directory as it was. */
async function repoint(dir: string, target: string): Promise<void> {
  const mode = (await lstat(dir)).mode & 0o777;
  await chmod(dir, mode | 0o200);
  try {
    const temp = join(dir, "node.new");
    await rm(temp, { force: true });
    await symlink(target, temp);
    await rename(temp, join(dir, "node"));
  } finally {
    await chmod(dir, mode);
  }
}

/** Every Release's `node` link points at `node/<major>` for the major recorded with it (spec 3.1, 10.6). */
async function nodeLinks(ctx: Context): Promise<CheckResult[]> {
  const problems: CheckResult[] = [];
  const releases = await installedReleases(ctx);
  for (const version of releases) {
    const major = await releaseNodeMajor(ctx, version);
    if (major === undefined) continue; // The native-module check already fails a Release with no recorded major.
    const dir = join(ctx.paths.releases, version);
    const found = await linkOf(dir);
    const wanted = wantedLink(ctx, major);
    if (found === wanted) continue;
    problems.push({
      kind: "problem",
      severity: "fail",
      message:
        found === undefined
          ? `Release ${version} has no node link; it should point to node/${major}`
          : `Release ${version}'s node link points to ${found}, not node/${major}`,
      fix: { apply: () => repoint(dir, wanted) },
    });
  }
  if (problems.length > 0) return problems;
  return [
    {
      kind: "pass",
      label:
        releases.length === 0
          ? "No Releases, so no node links to check"
          : "Every Release's node link matches its Node major",
    },
  ];
}

export const releaseChecks: Check[] = [{ id: "release-node-links", run: nodeLinks }];
