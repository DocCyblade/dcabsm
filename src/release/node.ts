import { createHash } from "node:crypto";
import { mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { CliError } from "../errors.ts";
import { fetchOk } from "../fetchutil.ts";
import { exists } from "../fsutil.ts";
import { step } from "../output.ts";
import { NODE_CEILING } from "./constants.ts";
import { compareText, parseVersion, satisfies } from "./semver.ts";

const DIST = "https://nodejs.org/dist";

/** Newest patch of each LTS major no newer than the ceiling, from nodejs.org's `index.json`. */
async function ltsPatches(ctx: Context): Promise<Map<number, string>> {
  const body = await fetchOk(ctx, `${DIST}/index.json`);
  const entries = JSON.parse(new TextDecoder().decode(body)) as Array<{
    version: string;
    lts: string | false;
  }>;
  const newest = new Map<number, string>();
  for (const entry of entries) {
    const v = parseVersion(entry.version);
    if (!v || !entry.lts || v[0] > NODE_CEILING) continue;
    const have = newest.get(v[0]);
    if (!have || compareText(entry.version, have) > 0) newest.set(v[0], entry.version.slice(1));
  }
  return newest;
}

export interface NodeChoice {
  major: number;
  /** The newest patch nodejs.org offers for the major. */
  patch: string;
}

/** The newest LTS major that satisfies `engines.node` and is no newer than the ceiling (spec 3.1). */
export async function chooseNode(
  ctx: Context,
  release: string,
  engines: string | undefined,
): Promise<NodeChoice> {
  const patches = await ltsPatches(ctx);
  const fits = [...patches]
    .filter(([, patch]) => engines === undefined || satisfies(parseVersion(patch)!, engines))
    .sort((a, b) => b[0] - a[0]);
  const best = fits[0];
  if (!best) {
    throw new CliError(
      `Release ${release} needs Node ${engines ?? "(unknown)"}, and this DCABSM runs Releases only on Node ${NODE_CEILING} or older.`,
      "Update DCABSM, which may support a newer Node: sudo dcabsm self update",
    );
  }
  return { major: best[0], patch: best[1] };
}

/** The installed patch `node/<major>` points to, if any. */
export async function linkedPatch(ctx: Context, major: number): Promise<string | undefined> {
  try {
    return await readlink(join(ctx.paths.node, String(major)));
  } catch {
    return undefined;
  }
}

export async function pointMajorAt(ctx: Context, major: number, patch: string): Promise<void> {
  const link = join(ctx.paths.node, String(major));
  const current = await linkedPatch(ctx, major);
  if (current !== undefined && compareText(current, patch) >= 0) return;
  const tmp = `${link}.tmp`;
  await rm(tmp, { force: true });
  await symlink(patch, tmp);
  await rename(tmp, link);
}

/**
 * Makes sure a Node runtime for the major is installed (spec 3.3) and returns
 * its patch. An installed major is used as it is; `release update-node` moves patches.
 */
export async function ensureNode(ctx: Context, choice: NodeChoice): Promise<string> {
  const installed = await linkedPatch(ctx, choice.major);
  if (installed !== undefined && (await exists(join(ctx.paths.node, installed, "bin", "node")))) {
    return installed;
  }
  const { patch } = choice;
  const final = join(ctx.paths.node, patch);
  if (!(await exists(join(final, "bin", "node")))) {
    await installPatch(ctx, patch);
    step(
      ctx,
      "done",
      `Installed Node runtime ${patch} (checked with gpgv against nodejs.org's keys)`,
    );
  }
  await pointMajorAt(ctx, choice.major, patch);
  return (await linkedPatch(ctx, choice.major)) ?? patch;
}

export async function installPatch(ctx: Context, patch: string): Promise<void> {
  const base = `${DIST}/v${patch}`;
  const file = `node-v${patch}-linux-${ctx.arch}.tar.xz`;
  const work = join(ctx.paths.node, `.installing-${patch}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const sums = await fetchOk(ctx, `${base}/SHASUMS256.txt`);
    const sig = await fetchOk(ctx, `${base}/SHASUMS256.txt.sig`);
    const sumsPath = join(work, "SHASUMS256.txt");
    const sigPath = join(work, "SHASUMS256.txt.sig");
    await writeFile(sumsPath, sums);
    await writeFile(sigPath, sig);
    const check = await ctx.runner.run("gpgv", [
      "--keyring",
      ctx.paths.nodeKeyring,
      sigPath,
      sumsPath,
    ]);
    if (check.code !== 0) {
      throw new CliError(
        `The signature on Node ${patch}'s SHASUMS256.txt does not verify against nodejs.org's release keys.`,
        "Nothing was installed. If the keys changed, update DCABSM: sudo dcabsm self update",
      );
    }
    const line = new TextDecoder()
      .decode(sums)
      .split("\n")
      .find((l) => l.trim().endsWith(`  ${file}`));
    const expected = line?.trim().split(/\s+/)[0];
    if (!expected) throw new CliError(`SHASUMS256.txt has no entry for ${file}.`);
    const tarball = await fetchOk(ctx, `${base}/${file}`);
    if (createHash("sha256").update(tarball).digest("hex") !== expected) {
      throw new CliError(
        `${file} does not match its SHA-256 in SHASUMS256.txt.`,
        "Nothing was installed.",
      );
    }
    const tarPath = join(work, file);
    await writeFile(tarPath, tarball);
    const dest = join(work, "runtime");
    await mkdir(dest);
    const untar = await ctx.runner.run("tar", [
      "-xJf",
      tarPath,
      "-C",
      dest,
      "--strip-components=1",
    ]);
    if (untar.code !== 0) throw new CliError(`Could not unpack ${file}: ${untar.stderr.trim()}`);
    await rename(dest, join(ctx.paths.node, patch));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
