import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFlags } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, firstLine, refusal } from "../errors.ts";
import { fetchOk } from "../fetchutil.ts";
import { exists } from "../fsutil.ts";
import { DCABSM_LATEST } from "../host/updates.ts";
import { readHostConfig } from "../host/config.ts";
import { step } from "../output.ts";
import { confirmOrCancel } from "../prompt.ts";
import { pathsUnder } from "../paths.ts";
import { STABLE_VERSION } from "../release/constants.ts";
import { compareText, parseVersion } from "../release/semver.ts";
import type { Invocation } from "../table.ts";
import { LAYOUT, VERSION } from "../version.ts";
import { storedLayout } from "./layout.ts";
import { migrateLayout } from "./migrations.ts";
import { selfRefresh } from "./refresh.ts";

const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };
/** `/opt/dcabsm` and the link under `/usr/local/bin`, as written on the Host (they hang off the root in `paths.ts`). */
const LOGICAL_OPT = pathsUnder("/", "/").opt;
const LOGICAL_LINK = pathsUnder("/", "/").binLink;

const releaseBase = (version: string) =>
  `https://github.com/DocCyblade/dcabsm/releases/download/v${version}`;

/** The newest stable DCABSM on GitHub. */
async function latestVersion(ctx: Context): Promise<string> {
  const body = await fetchOk(ctx, DCABSM_LATEST);
  const tag = (JSON.parse(new TextDecoder().decode(body)) as { tag_name?: string }).tag_name;
  const version = tag?.replace(/^v/, "") ?? "";
  if (!STABLE_VERSION.test(version)) {
    throw new CliError(`GitHub named a DCABSM version it can't read: ${tag}.`);
  }
  return version;
}

/** Downloads the tarball and checks it, against the key already installed and nothing from the download. */
async function downloadVerified(ctx: Context, version: string, dir: string): Promise<string> {
  const arch = ARCH[ctx.arch];
  if (!arch) throw refusal(`DCABSM has no build for ${ctx.arch}.`);
  const file = `dcabsm-${version}-linux-${arch}.tar.gz`;
  const base = releaseBase(version);
  const tarball = await fetchOk(ctx, `${base}/${file}`);
  const sums = await fetchOk(ctx, `${base}/SHA256SUMS`);
  const sig = await fetchOk(ctx, `${base}/SHA256SUMS.sig`);
  step(ctx, "done", `Downloaded ${file}`);

  const sumsPath = join(dir, "SHA256SUMS");
  const sigPath = join(dir, "SHA256SUMS.sig");
  await writeFile(sumsPath, sums);
  await writeFile(sigPath, sig);
  const check = await ctx.runner.run("gpgv", [
    "--keyring",
    ctx.paths.signingKey,
    sigPath,
    sumsPath,
  ]);
  if (check.code !== 0) {
    throw new CliError(
      `The signature on SHA256SUMS does not verify against the installed key.`,
      `Nothing was changed. DCABSM only trusts the key it already has. gpgv: ${firstLine(check.stderr, `exit ${check.code}`)}`,
    );
  }
  step(ctx, "done", "Signature good, checked with gpgv against the installed key");

  const line = new TextDecoder()
    .decode(sums)
    .split("\n")
    .find((l) => l.trim().endsWith(`  ${file}`));
  const expected = line?.trim().split(/\s+/)[0];
  if (!expected) throw new CliError(`SHA256SUMS has no entry for ${file}.`, "Nothing was changed.");
  if (createHash("sha256").update(tarball).digest("hex") !== expected) {
    throw new CliError(`${file} does not match its SHA-256 in SHA256SUMS.`, "Nothing was changed.");
  }
  const path = join(dir, file);
  await writeFile(path, tarball);
  return path;
}

/** The layout a downloaded version expects, as it says itself. */
async function layoutOf(ctx: Context, dir: string): Promise<number> {
  const res = await ctx.runner.run(join(dir, "bin", "dcabsm"), ["--version"]);
  const layout = /\(layout (\d+)\)/.exec(res.stdout)?.[1];
  if (res.code !== 0 || layout === undefined) {
    throw new CliError(
      "The downloaded DCABSM does not run on this Host.",
      `Nothing was changed. ${firstLine(res.stderr, "It printed no version.")}`,
    );
  }
  return Number(layout);
}

/** A copy of `/etc/dcabsm` taken before a migration (spec 11.4). */
interface Aside {
  /** Puts the copy back over `/etc/dcabsm`. */
  restore(): Promise<void>;
  /** Drops the copy once the whole update has worked. */
  discard(): Promise<void>;
}

async function copyAside(ctx: Context): Promise<Aside> {
  const etc = ctx.paths.etc;
  const stamp = ctx.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const aside = `${etc}.aside-${stamp}`;
  await cp(etc, aside, { recursive: true, preserveTimestamps: true });
  return {
    restore: async () => {
      await rm(etc, { recursive: true, force: true });
      await rename(aside, etc);
    },
    discard: () => rm(aside, { recursive: true, force: true }),
  };
}

/** Runs the migration with the copy aside. If it fails the copy goes back; otherwise the copy is kept for the caller. */
async function migrateAside(
  ctx: Context,
  from: number,
  to: number,
  migrate: () => Promise<void>,
  onFailure: string,
): Promise<Aside> {
  const aside = await copyAside(ctx);
  try {
    await migrate();
  } catch (err) {
    await aside.restore();
    throw new CliError(
      `Migrating layout ${from} → ${to} failed: ${errorMessage(err)}`,
      `/etc/dcabsm was put back as it was. ${onFailure}`,
    );
  }
  step(ctx, "done", `Copied /etc/dcabsm aside, migrated layout ${from} → ${to}`);
  return aside;
}

/** Runs one hidden step with the new version's own code and forwards what it printed. */
async function runStep(ctx: Context, dir: string, verb: "migrate" | "refresh"): Promise<void> {
  const res = await ctx.runner.run(join(dir, "bin", "dcabsm"), ["self", verb]);
  for (const line of res.stdout.split("\n")) if (line !== "") ctx.io.out(line);
  if (res.code !== 0) {
    throw new CliError(
      firstLine(res.stderr.replace(/^error: /, ""), `self ${verb} exited ${res.code}`),
    );
  }
}

async function switchLink(ctx: Context, version: string): Promise<void> {
  await mkdir(join(ctx.paths.binLink, ".."), { recursive: true });
  const tmp = `${ctx.paths.binLink}.tmp`;
  await rm(tmp, { force: true });
  await symlink(`${LOGICAL_OPT}/${version}/bin/dcabsm`, tmp);
  await rename(tmp, ctx.paths.binLink);
}

/** Puts the link back as it was, or removes it when there was none. */
async function restoreLink(ctx: Context, old: string | undefined): Promise<void> {
  const now = await readlink(ctx.paths.binLink).catch(() => undefined);
  if (now === old) return;
  await rm(ctx.paths.binLink, { force: true });
  if (old !== undefined) await symlink(old, ctx.paths.binLink);
}

/** The version the link pointed to, or the running version's directory when there is no link. */
async function currentDir(ctx: Context): Promise<string> {
  try {
    const m = /\/([^/]+)\/bin\/dcabsm$/.exec(await readlink(ctx.paths.binLink));
    if (m) return m[1]!;
  } catch {
    // No link: fall back to where this process runs from.
  }
  return basename(ctx.paths.installDir);
}

/** Keeps the new and the previous version and removes the rest (spec 11.1). */
async function removeOldVersions(ctx: Context, keep: string[]): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(ctx.paths.opt);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names.filter((n) => !n.startsWith(".")).sort(compareText)) {
    if (keep.includes(name)) continue;
    await rm(join(ctx.paths.opt, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** `self update [--to <ver>] [--yes]` (spec 11.4). The caller holds the lock. */
export async function selfUpdate({ ctx, args }: Invocation): Promise<void> {
  const flags = parseFlags(args, { to: { type: "string" }, yes: { type: "boolean" } });
  if (flags.to !== undefined && !STABLE_VERSION.test(flags.to)) {
    throw refusal(
      `${flags.to} is not a stable DCABSM version.`,
      "Use a version like 1.2.0. Only stable versions are offered.",
    );
  }
  const target = flags.to ?? (await latestVersion(ctx));
  const stored = await storedLayout(ctx);

  // Without --to, never move down: a downgrade has to be asked for by name.
  if (flags.to === undefined && target !== VERSION && parseVersion(VERSION)) {
    if (compareText(target, VERSION) < 0) {
      throw refusal(
        `DCABSM ${VERSION} is ahead of the latest release (${target}).`,
        `To go back to an older version, name it: sudo dcabsm self update --to ${target}`,
      );
    }
  }

  if (target === VERSION) {
    if (stored === undefined || stored >= LAYOUT) {
      ctx.io.out(`DCABSM ${VERSION} is already installed.`);
      return;
    }
    // This version is already on the Host but its state is older: migrate it in place.
    const aside = await migrateAside(
      ctx,
      stored,
      LAYOUT,
      () => migrateLayout(ctx, stored),
      `Nothing else changed.`,
    );
    try {
      await selfRefresh({ ctx, args: [] });
    } catch (err) {
      await aside.restore();
      throw new CliError(
        `Refreshing the owned files failed after the migration: ${errorMessage(err)}`,
        "/etc/dcabsm was put back as it was.",
      );
    }
    await aside.discard();
    return;
  }

  ctx.io.out(`Self-update DCABSM ${VERSION} → ${target}`);
  ctx.io.out("  · Never changes an Instance's Release or restarts an Instance.");
  await confirmOrCancel(ctx, "Continue?", { yes: flags.yes });

  const downloads = join(ctx.paths.opt, `.download-${target}`);
  const stage = join(ctx.paths.opt, `.installing-${target}`);
  const final = join(ctx.paths.opt, target);
  await rm(downloads, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
  await mkdir(downloads, { recursive: true });
  await mkdir(stage, { recursive: true });
  const previous = await currentDir(ctx);
  const oldLink = await readlink(ctx.paths.binLink).catch(() => undefined);
  let placed = false;
  let switched = false;
  // Set once the migration has worked: from then on any failure puts everything back.
  let aside: Aside | undefined;
  let migration = "";
  try {
    const tarball = await downloadVerified(ctx, target, downloads);
    const untar = await ctx.runner.run("tar", [
      "-xzf",
      tarball,
      "-C",
      stage,
      "--strip-components=1",
    ]);
    if (untar.code !== 0) {
      throw new CliError(`Could not unpack the tarball: ${firstLine(untar.stderr, "tar failed")}`);
    }

    const layout = await layoutOf(ctx, stage);
    if (stored !== undefined && layout !== stored) {
      if (layout < stored) {
        throw refusal(
          `DCABSM ${target} uses layout ${layout}; this Host is on layout ${stored}.`,
          "Migrations only go forward. Nothing was changed.",
        );
      }
      if (flags.to !== undefined) {
        throw refusal(
          `DCABSM ${target} uses layout ${layout}; this Host is on layout ${stored}.`,
          "Moving to a new layout is only done to the latest version: sudo dcabsm self update",
        );
      }
    }

    // A new key ships inside an update signed by the old one; without one, the old key carries on.
    const keyInTarball = join(stage, "share", "dcabsm-signing-key.gpg");
    if (!(await exists(keyInTarball))) {
      await mkdir(join(stage, "share"), { recursive: true });
      await cp(ctx.paths.signingKey, keyInTarball);
    }
    await rm(final, { recursive: true, force: true });
    await rename(stage, final);
    placed = true;
    step(ctx, "done", `Extracted to ${LOGICAL_OPT}/${target}/`);

    if (stored !== undefined && layout > stored) {
      aside = await migrateAside(
        ctx,
        stored,
        layout,
        () => runStep(ctx, final, "migrate"),
        `The symlink stays on ${previous}.`,
      );
      migration = `${stored} → ${layout}`;
    }

    await switchLink(ctx, target);
    switched = true;
    step(ctx, "done", `${LOGICAL_LINK} → ${LOGICAL_OPT}/${target}/`);

    if (await readHostConfig(ctx)) {
      try {
        await runStep(ctx, final, "refresh");
      } catch (err) {
        // After a migration the outer handler puts everything back; otherwise the new version stays.
        if (aside) throw err;
        throw new CliError(
          `DCABSM ${target} is installed, but refreshing the owned files failed: ${errorMessage(err)}`,
          "Fix the cause, then run: sudo dcabsm host doctor --fix",
        );
      }
    }
    const removed = await removeOldVersions(ctx, [target, previous]);
    for (const name of removed) {
      step(ctx, "done", `Removed ${LOGICAL_OPT}/${name}/ (keeps current and previous)`);
    }
    await aside?.discard();
  } catch (err) {
    if (aside) {
      // The migration worked but a later step failed: undo the migration, the link and the new version.
      await aside.restore();
      await restoreLink(ctx, oldLink);
      if (placed) await rm(final, { recursive: true, force: true });
      throw new CliError(
        `Updating to ${target} failed after migrating layout ${migration}: ${errorMessage(err)}`,
        `/etc/dcabsm was put back as it was. The symlink stays on ${previous}.`,
      );
    }
    // Once the link points at the new version it must stay.
    if (placed && !switched) await rm(final, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(downloads, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
