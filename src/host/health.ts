import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { lineDiff } from "../diff.ts";
import { errorMessage } from "../errors.ts";
import { installedReleases, releaseIntact } from "../release/install.ts";
import { compareText, parseVersion } from "../release/semver.ts";
import type { Check, CheckResult } from "./checks.ts";
import { bannerLine, defaultHostConfig, DEFAULT_BACKUP_DIR, readHostConfig } from "./config.ts";
import {
  hostOwnedFiles,
  inspectOwnedFiles,
  isNginxFile,
  otherDefaultOn443,
  pending,
  writeVerified,
  type InspectedFile,
} from "./owned.ts";
import {
  isInstalled,
  nginxIsActive,
  nginxIsEnabled,
  nginxTestFailure,
  systemctl,
  timerIsEnabled,
} from "./system.ts";

/** Checks of the Host's services and files (spec 10.6). */

const pass = (label: string): CheckResult[] => [{ kind: "pass", label }];

async function unsupportedMark(ctx: Context): Promise<CheckResult[]> {
  const mark = (await readHostConfig(ctx))?.unsupportedHost;
  if (!mark) return pass("Not an Unsupported Host");
  return [{ kind: "problem", severity: "fail", message: bannerLine(mark) }];
}

async function nginxRunning(ctx: Context): Promise<CheckResult[]> {
  if (!(await isInstalled(ctx, "nginx"))) {
    return [
      {
        kind: "problem",
        severity: "fail",
        message: "Nginx is not installed",
        hint: "Run: sudo dcabsm host setup",
      },
    ];
  }
  const running = await nginxIsActive(ctx);
  const enabled = await nginxIsEnabled(ctx);
  if (running && enabled) return pass("Nginx running and enabled");
  const what =
    !running && !enabled
      ? "not running and not enabled at boot"
      : running
        ? "not enabled at boot"
        : "not running";
  return [
    {
      kind: "problem",
      severity: "fail",
      message: `Nginx is ${what}`,
      fix: {
        async apply() {
          const reason = await nginxTestFailure(ctx);
          if (reason !== undefined) throw new Error(`nginx -t fails: ${reason}`);
          await systemctl(ctx, "enable", "--now", "nginx");
        },
      },
    },
  ];
}

async function defaultOn443(ctx: Context): Promise<CheckResult[]> {
  if (!(await otherDefaultOn443(ctx))) return pass("No other default server on 443");
  return [
    {
      kind: "problem",
      severity: "note",
      message: "Another default server on 443; DCABSM's own catch-all does not apply",
    },
  ];
}

const DESCRIBE = {
  new: "is missing",
  refresh: "is an older version of what DCABSM writes",
  drift: "was edited by hand",
} as const;

/** Writes one owned file the way setup does (spec 10.5): old copy saved, `nginx -t` before any reload. */
async function fixOwnedFile(ctx: Context, item: InspectedFile): Promise<void> {
  const stored = await readHostConfig(ctx);
  const result = await writeVerified(
    ctx,
    [item],
    new Set([item.file.path]),
    stored?.ownedFiles ?? {},
    "sudo dcabsm host doctor --fix",
  );
  if (result.written.length === 0) return;
  await systemctl(ctx, "daemon-reload");
  if (isNginxFile(item.file) && (await nginxIsActive(ctx))) await systemctl(ctx, "reload", "nginx");
}

async function ownedFiles(ctx: Context): Promise<CheckResult[]> {
  const stored = await readHostConfig(ctx);
  const nightlyTime =
    stored?.nightlyTime ?? defaultHostConfig(stored?.backupDir ?? DEFAULT_BACKUP_DIR).nightlyTime;
  const inspected = await inspectOwnedFiles(
    ctx,
    await hostOwnedFiles(ctx, nightlyTime),
    stored?.ownedFiles ?? {},
  );
  const work = pending(inspected);
  if (work.length === 0) return pass("Owned files match");
  return work.map((item): CheckResult => {
    const state = item.state as keyof typeof DESCRIBE;
    return {
      kind: "problem",
      severity: "warn",
      message: `${item.file.path} ${DESCRIBE[state]}`,
      fix: {
        diff: state === "drift" ? lineDiff(item.old ?? "", item.file.content) : undefined,
        apply: () => fixOwnedFile(ctx, item),
      },
    };
  });
}

async function timer(ctx: Context): Promise<CheckResult[]> {
  if (await timerIsEnabled(ctx)) return pass("dcabsm-nightly.timer enabled");
  return [
    {
      kind: "problem",
      severity: "warn",
      message: "dcabsm-nightly.timer is not enabled",
      fix: {
        async apply() {
          await systemctl(ctx, "enable", "dcabsm-nightly.timer");
          await systemctl(ctx, "start", "dcabsm-nightly.timer");
        },
      },
    },
  ];
}

async function releasesLoad(ctx: Context): Promise<CheckResult[]> {
  const releases = await installedReleases(ctx);
  if (releases.length === 0) return pass("No Releases installed");
  const problems: CheckResult[] = [];
  for (const version of releases) {
    if (await releaseIntact(ctx, version)) continue;
    problems.push({
      kind: "problem",
      severity: "fail",
      message: `Release ${version} does not load its native modules: run sudo dcabsm instance upgrade`,
    });
  }
  return problems.length > 0
    ? problems
    : pass(
        releases.length > 1
          ? `Releases ${releases.join(", ")} load native modules`
          : `Release ${releases[0]} loads native modules`,
      );
}

const NODE_INDEX = "https://nodejs.org/dist/index.json";
const NODE_SCHEDULE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json";

async function fetchJson(ctx: Context, url: string): Promise<unknown> {
  const res = await ctx.fetcher.fetch(url);
  if (res.status !== 200) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return JSON.parse(new TextDecoder().decode(res.body));
}

/** The installed Node majors and the patch each `node/<major>` link points to. */
async function installedNodes(ctx: Context): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  let entries: string[] = [];
  try {
    entries = await readdir(ctx.paths.node);
  } catch {
    // No runtimes yet.
  }
  for (const name of entries.filter((n) => /^\d+$/.test(n))) {
    try {
      found.set(Number(name), await readlink(join(ctx.paths.node, name)));
    } catch {
      // Not a link: not a runtime DCABSM made.
    }
  }
  return found;
}

/** Spec 3.4: a newer patch for an installed major, and a major that is end of life. This asks nodejs.org. */
async function nodeUpdates(ctx: Context): Promise<CheckResult[]> {
  const nodes = await installedNodes(ctx);
  if (nodes.size === 0) return pass("No Node runtimes installed");
  const newest = new Map<number, string>();
  let schedule: Record<string, { end?: string }>;
  try {
    const index = (await fetchJson(ctx, NODE_INDEX)) as Array<{ version: string }>;
    schedule = (await fetchJson(ctx, NODE_SCHEDULE)) as typeof schedule;
    for (const { version } of index) {
      const v = parseVersion(version);
      if (!v) continue;
      const have = newest.get(v[0]);
      if (!have || compareText(version, have) > 0) newest.set(v[0], version.slice(1));
    }
  } catch (err) {
    return [
      {
        kind: "problem",
        severity: "note",
        message: `Could not look for Node patches or end of life: ${errorMessage(err)}`,
      },
    ];
  }
  const today = ctx.now().toISOString().slice(0, 10);
  const results: CheckResult[] = [];
  for (const [major, patch] of [...nodes].sort((a, b) => a[0] - b[0])) {
    const end = schedule[`v${major}`]?.end;
    if (end !== undefined && end < today) {
      results.push({
        kind: "problem",
        severity: "warn",
        message: `Node ${major} is end of life since ${end}`,
        hint: "Move Instances to a Release that runs on a newer Node: sudo dcabsm instance upgrade --all",
      });
    }
    const latest = newest.get(major);
    if (latest !== undefined && compareText(latest, patch) > 0) {
      results.push({
        kind: "problem",
        severity: "note",
        message: `Node ${latest} is available (runtime on ${patch}): sudo dcabsm release update-node`,
      });
    } else {
      results.push({
        kind: "pass",
        label: `Node runtime ${patch} is the newest patch of ${major}`,
      });
    }
  }
  return results;
}

async function bashCompletion(ctx: Context): Promise<CheckResult[]> {
  if (await isInstalled(ctx, "bash-completion")) return pass("bash-completion installed");
  return [
    {
      kind: "problem",
      severity: "note",
      message: "The bash-completion package is not installed, so Tab completion is off",
      hint: "Install it with apt if you want it: sudo apt install bash-completion",
    },
  ];
}

const PROFILES: Record<string, number[]> = {
  "Nginx Full": [80, 443],
  "Nginx HTTP": [80],
  "Nginx HTTPS": [443],
  "WWW Full": [80, 443],
  WWW: [80],
  "WWW Secure": [443],
};

/** The ports among 80 and 443 that one `ufw status` To column opens, such as `80,443/tcp`, `443 (v6)` or `Nginx Full`. */
function portsOf(to: string): number[] {
  const name = to.replace(/ \(v6\)$/, "");
  const profile = PROFILES[name];
  if (profile) return profile;
  if (name.endsWith("/udp")) return [];
  const ports: number[] = [];
  for (const part of name.replace(/\/tcp$/, "").split(",")) {
    const [from, upTo] = part.split(":").map(Number);
    if (from === undefined || Number.isNaN(from)) continue;
    for (const wanted of [80, 443]) {
      if (wanted >= from && wanted <= (upTo ?? from)) ports.push(wanted);
    }
  }
  return ports;
}

interface Gaps {
  tool: "ufw" | "firewalld";
  missing: number[];
}

/** The ports (80, 443) a running firewall does not allow; undefined when no firewall is active. */
async function firewallGaps(ctx: Context): Promise<Gaps | undefined> {
  const ufw = await ctx.runner.run("ufw", ["status"]);
  if (ufw.code === 0 && /^Status: active/m.test(ufw.stdout)) {
    const allowed = new Set<number>();
    for (const line of ufw.stdout.split("\n")) {
      if (!/\bALLOW\b/.test(line) || /\bALLOW OUT\b/.test(line)) continue;
      for (const port of portsOf(line.split(/\s{2,}/)[0]!.trim())) allowed.add(port);
    }
    return { tool: "ufw", missing: [80, 443].filter((p) => !allowed.has(p)) };
  }
  const state = await ctx.runner.run("firewall-cmd", ["--state"]);
  if (state.code === 0 && state.stdout.trim() === "running") {
    const list = async (what: string) =>
      (await ctx.runner.run("firewall-cmd", [what])).stdout.split(/\s+/);
    const services = await list("--list-services");
    const ports = await list("--list-ports");
    const open = (port: number, service: string) =>
      services.includes(service) || ports.includes(`${port}/tcp`);
    return {
      tool: "firewalld",
      missing: [80, 443].filter((p) => !open(p, p === 80 ? "http" : "https")),
    };
  }
  return undefined;
}

/** Reports only. DCABSM never changes firewall rules (spec 10.6). */
async function firewall(ctx: Context): Promise<CheckResult[]> {
  const gaps = await firewallGaps(ctx);
  if (!gaps) return pass("No firewall active");
  if (gaps.missing.length === 0) return pass("Firewall allows 80 and 443");
  const example = gaps.missing
    .map((p) =>
      gaps.tool === "ufw" ? `ufw allow ${p}/tcp` : `firewall-cmd --permanent --add-port=${p}/tcp`,
    )
    .join(" and ");
  return [
    {
      kind: "problem",
      severity: "warn",
      message: `Firewall active without ${gaps.missing.join(" and ")} allowed: manual System Admin task, e.g. ${example}`,
    },
  ];
}

export const healthChecks: Check[] = [
  { id: "unsupported-mark", run: unsupportedMark },
  { id: "nginx-running", run: nginxRunning },
  { id: "owned-files", run: ownedFiles },
  { id: "timer", run: timer },
  { id: "default-443", run: defaultOn443 },
  { id: "releases-load", run: releasesLoad },
  { id: "node-updates", run: nodeUpdates },
  { id: "bash-completion", run: bashCompletion },
  { id: "firewall", run: firewall },
];
