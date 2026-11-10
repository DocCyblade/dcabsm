import { readFile, readdir } from "node:fs/promises";
import type { Context } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { step } from "../output.ts";
import { installedReleases, latestStable } from "../release/install.ts";
import { linkedPatch } from "../release/node.ts";
import { compareText, parseVersion } from "../release/semver.ts";
import type { Invocation } from "../table.ts";
import { VERSION } from "../version.ts";
import { readHostConfig } from "./config.ts";

export const NODE_INDEX = "https://nodejs.org/dist/index.json";
export const NODE_SCHEDULE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";
export const DCABSM_LATEST = "https://api.github.com/repos/DocCyblade/dcabsm/releases/latest";

/** The last `host check-updates` result, kept at `paths.updateCheck` (spec 2.1). */
interface Stored {
  checkedAt: string;
  /** Newest stable Release on npm. */
  actual?: string;
  /** Newest stable DCABSM. */
  dcabsm?: string;
  /** Per installed Node major: its newest patch and, when it is over, its end-of-life date. */
  node: Record<string, { latest: string; eol?: string }>;
}

export async function fetchJson(ctx: Context, url: string, what: string): Promise<unknown> {
  let res;
  try {
    res = await ctx.fetcher.fetch(url);
  } catch (err) {
    throw new Error(`Could not reach ${what}: ${errorMessage(err)}`);
  }
  if (res.status !== 200) throw new Error(`${what} answered ${res.status}.`);
  return JSON.parse(new TextDecoder().decode(res.body));
}

/** The installed Node majors and the patch each `node/<major>` link points to. */
export async function installedNode(ctx: Context): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  let names: string[];
  try {
    names = await readdir(ctx.paths.node);
  } catch {
    return found;
  }
  for (const name of names.filter((n) => /^\d+$/.test(n))) {
    const patch = await linkedPatch(ctx, Number(name));
    if (patch !== undefined) found.set(Number(name), patch);
  }
  return found;
}

async function readStored(ctx: Context): Promise<Stored | undefined> {
  try {
    return JSON.parse(await readFile(ctx.paths.updateCheck, "utf8")) as Stored;
  } catch {
    return undefined;
  }
}

const newest = (versions: string[]): string | undefined => versions.sort(compareText).reverse()[0];

/** Whether `latest` is newer than `have`. A dev build such as `0.0.0-dev` compares by its number. */
export function isNewer(latest: string, have: string | undefined): boolean {
  if (have === undefined) return false;
  const core = /^\d+\.\d+\.\d+/.exec(have)?.[0] ?? have;
  return compareText(latest, core) > 0;
}

/** `host check-updates` (spec 3.5, docs/cli.md). The one command that looks for updates on the network. */
export async function hostCheckUpdates({ ctx }: Invocation): Promise<void> {
  const doc: Stored = { ...(await readStored(ctx)), checkedAt: ctx.now().toISOString(), node: {} };
  const warn = (err: unknown) => step(ctx, "warn", errorMessage(err));

  const releases = await installedReleases(ctx);
  const have = newest(releases);
  try {
    doc.actual = await latestStable(ctx);
    if (isNewer(doc.actual, have)) {
      step(ctx, "done", `Actual ${doc.actual} is available (newest installed: ${have})`);
    } else {
      step(ctx, "done", `Actual ${doc.actual} is the latest stable Release`);
    }
  } catch (err) {
    warn(err);
  }

  try {
    const tag = (await fetchJson(ctx, DCABSM_LATEST, "GitHub")) as { tag_name: string };
    const latest = parseVersion(tag.tag_name) ? tag.tag_name.replace(/^v/, "") : undefined;
    if (!latest) throw new Error(`GitHub named a DCABSM version it can't read: ${tag.tag_name}.`);
    doc.dcabsm = latest;
    if (isNewer(latest, VERSION)) {
      step(
        ctx,
        "done",
        `DCABSM ${latest} is available (this is ${VERSION}): sudo dcabsm self update`,
      );
    } else {
      step(ctx, "done", `DCABSM ${latest} is the latest version`);
    }
  } catch (err) {
    warn(err);
  }

  const majors = await installedNode(ctx);
  if (majors.size > 0) {
    let patches: Map<number, string> | undefined;
    let ends: Record<string, { end?: string }> = {};
    try {
      const index = (await fetchJson(ctx, NODE_INDEX, "nodejs.org")) as Array<{ version: string }>;
      patches = new Map();
      for (const major of majors.keys()) {
        const top = newest(
          index.map((e) => e.version).filter((v) => parseVersion(v)?.[0] === major),
        );
        if (top) patches.set(major, top.replace(/^v/, ""));
      }
    } catch (err) {
      warn(err);
    }
    try {
      ends = (await fetchJson(ctx, NODE_SCHEDULE, "the Node release schedule")) as typeof ends;
    } catch (err) {
      warn(err);
    }
    const today = ctx.now().toISOString().slice(0, 10);
    for (const [major, installed] of [...majors].sort((a, b) => a[0] - b[0])) {
      const latest = patches?.get(major) ?? doc.node[major]?.latest;
      const end = ends[`v${major}`]?.end;
      const eol = end !== undefined && end <= today ? end : undefined;
      if (latest) doc.node[major] = eol ? { latest, eol } : { latest };
      if (latest && isNewer(latest, installed)) {
        step(
          ctx,
          "done",
          `Node ${latest} patch for Node ${major} (installed ${installed}): sudo dcabsm release update-node`,
        );
      } else if (latest) {
        step(ctx, "done", `Node ${major} is on its newest patch (${installed})`);
      }
      if (eol) {
        step(
          ctx,
          "warn",
          `Node ${major} is end of life (since ${eol}): sudo dcabsm release update-node`,
        );
      }
    }
  }

  await writeFileAtomic(ctx.paths.updateCheck, `${JSON.stringify(doc, null, 2)}\n`, 0o644);
  step(
    ctx,
    "info",
    "instance list shows this result until the next check. Ordinary commands never use the network.",
  );
}

export interface UpdateFooter {
  /** "2026-11-07 12:00 UTC", or undefined when no check has run. */
  lastCheck?: string;
  /** The `→` lines for beneath `instance list`'s table. */
  lines: string[];
}

/**
 * What `instance list` shows beneath its table: the last stored check, compared with what is installed
 * now, so an update done since is dropped. Reads files only; never the network (spec 3.5).
 */
export async function updateFooter(ctx: Context): Promise<UpdateFooter> {
  const doc = await readStored(ctx);
  if (!doc) {
    return { lines: ["→ No update check yet: sudo dcabsm host check-updates"] };
  }
  const lines: string[] = [];
  const have = newest(await installedReleases(ctx));
  if (doc.actual && isNewer(doc.actual, have)) {
    lines.push(`→ Actual ${doc.actual} is available: sudo dcabsm instance upgrade <names>|--all`);
  }
  if (doc.dcabsm && isNewer(doc.dcabsm, VERSION)) {
    lines.push(`→ DCABSM ${doc.dcabsm} is available: sudo dcabsm self update`);
  }
  const majors = await installedNode(ctx);
  for (const [major, installed] of [...majors].sort((a, b) => a[0] - b[0])) {
    const seen = doc.node[major];
    if (seen && isNewer(seen.latest, installed)) {
      lines.push(`→ Node ${seen.latest} patch for Node ${major}: sudo dcabsm release update-node`);
    }
    if (seen?.eol) lines.push(`→ Node ${major} is end of life: sudo dcabsm release update-node`);
  }
  return { lastCheck: formatTime(new Date(doc.checkedAt)), lines };
}

/** Everything beneath `instance list`'s table: a blank line, the status line and the `→` lines. */
export async function instanceListFooter(ctx: Context): Promise<string[]> {
  const footer = await updateFooter(ctx);
  const nightly = (await readHostConfig(ctx))?.nightlyTime;
  const parts = [`DCABSM ${VERSION}`];
  if (nightly) parts.push(`Nightly run ${nightly}`);
  if (footer.lastCheck) parts.push(`last check ${footer.lastCheck}`);
  return ["", parts.join(" · "), ...footer.lines];
}

function formatTime(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}
