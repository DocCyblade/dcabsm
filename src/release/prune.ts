import { readdir, readlink, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseFlags } from "../args.ts";
import type { Context } from "../context.ts";
import { makeWritable, readTextOr } from "../fsutil.ts";
import { instanceNames, changingMarker } from "../instance/record.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirmOrCancel } from "../prompt.ts";
import type { Invocation } from "../table.ts";
import { installedReleases, releaseNodeMajor } from "./install.ts";
import { instancesByRelease } from "./list.ts";

/** Releases named by any Instance's `.changing-release` marker (spec 6.6), from or to. */
async function namedByMarkers(ctx: Context, releases: string[]): Promise<Set<string>> {
  const named = new Set<string>();
  for (const name of await instanceNames(ctx)) {
    const text = await readTextOr(changingMarker(ctx, name));
    if (text === undefined) continue;
    for (const version of releases) {
      // A whole version, not the front of a longer one such as 26.1.0 in 26.10.0.
      if (new RegExp(`(?<![\\d.])${version.replaceAll(".", "\\.")}(?![\\d]|\\.\\d)`).test(text)) {
        named.add(version);
      }
    }
  }
  return named;
}

interface NodeLayout {
  /** Installed patch directories. */
  patches: string[];
  /** `node/<major>` links, by major, to their patch. */
  majors: Map<string, string>;
}

async function nodeLayout(ctx: Context): Promise<NodeLayout> {
  const layout: NodeLayout = { patches: [], majors: new Map() };
  let entries;
  try {
    entries = await readdir(ctx.paths.node, { withFileTypes: true });
  } catch {
    return layout;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isSymbolicLink()) {
      layout.majors.set(e.name, await readlink(join(ctx.paths.node, e.name)));
    } else if (e.isDirectory()) layout.patches.push(e.name);
  }
  layout.patches.sort();
  return layout;
}

/** `release prune [--yes]` (spec 3.2). */
export async function releasePrune({ ctx, args }: Invocation): Promise<void> {
  const flags = parseFlags(args, { yes: { type: "boolean" } });
  const installed = await installedReleases(ctx);
  const linked = await instancesByRelease(ctx);
  const named = await namedByMarkers(ctx, installed);
  const unused = installed.filter((v) => !linked.has(v) && !named.has(v));
  const kept = installed.filter((v) => !unused.includes(v));

  const keptMajors = new Set<string>();
  for (const v of kept) {
    const major = await releaseNodeMajor(ctx, v);
    if (major !== undefined) keptMajors.add(String(major));
  }
  const layout = await nodeLayout(ctx);
  const keptPatches = new Set(
    [...layout.majors].filter(([major]) => keptMajors.has(major)).map(([, patch]) => patch),
  );
  const unusedPatches = layout.patches.filter((p) => !keptPatches.has(p));
  const unusedLinks = [...layout.majors.keys()].filter((m) => !keptMajors.has(m));

  if (unused.length === 0 && unusedPatches.length === 0) {
    ctx.io.out("No unused Releases.");
    return;
  }
  for (const v of unused) step(ctx, "info", `Release ${v}`);
  for (const p of unusedPatches) step(ctx, "info", `Node runtime ${p}`);
  await confirmOrCancel(
    ctx,
    "Remove these unused Releases and any Node runtime no Release uses?",
    flags,
  );

  for (const v of unused) {
    const dir = join(ctx.paths.releases, v);
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true });
    step(ctx, "done", `Removed Release ${v}`);
  }
  for (const m of unusedLinks) await unlink(join(ctx.paths.node, m));
  for (const p of unusedPatches) {
    await rm(join(ctx.paths.node, p), { recursive: true, force: true });
    step(ctx, "done", `Removed Node runtime ${p}`);
  }
  if (unused.length > 0) {
    step(
      ctx,
      "info",
      "A rollback to a removed Release reinstalls it from npm, without its old lockfile.",
    );
  }
  await logChange(
    ctx,
    "release prune",
    `removed Releases ${unused.join(", ") || "-"} and Node runtimes ${unusedPatches.join(", ") || "-"}`,
  );
}
