import { chmod, lstat, rm, stat } from "node:fs/promises";
import type { Context } from "../context.ts";
import { readTextOr } from "../fsutil.ts";
import type { Check, CheckResult, HostFacts } from "./checks.ts";
import { isInstalled, systemctl } from "./system.ts";

/** TurnKey Linux Hosts (spec 10.7): detection, first boot and the pieces that clash with DCABSM. */

export type Appliance = "core" | "nodejs";

export type TurnkeyState =
  | { kind: "none" }
  | { kind: "supported"; appliance: Appliance; label: string }
  | { kind: "unsupported"; found: string };

const LABELS: Record<Appliance, string> = { core: "TurnKey Core", nodejs: "TurnKey Node.js" };

export const UNSUPPORTED_APPLIANCE =
  "Only TurnKey Core and Node.js are supported. Use one of those, or plain Debian 13.";

/**
 * Reads `/etc/turnkey_version`, for example `turnkey-nodejs-19.0-trixie-amd64`, and confirms the
 * appliance against the matching `turnkey-<name>-<version>` package (spec 10.7), such as
 * `turnkey-nodejs-19.0`.
 */
export async function detectTurnkey(ctx: Context): Promise<TurnkeyState> {
  const raw = await readTextOr(ctx.paths.under("etc/turnkey_version"));
  if (raw === undefined) return { kind: "none" };
  const text = raw.trim();
  const match = /^turnkey-([a-z0-9-]+)-(\d+\.\d+)-[a-z0-9]+-[a-z0-9]+$/.exec(text);
  if (!match) return { kind: "unsupported", found: text || "an empty /etc/turnkey_version" };
  const [, name, version] = match as unknown as [string, string, string];
  if (name !== "core" && name !== "nodejs")
    return { kind: "unsupported", found: `TurnKey ${name}` };
  const pkg = `turnkey-${name}-${version}`;
  if (!(await isInstalled(ctx, pkg)))
    return {
      kind: "unsupported",
      found: `/etc/turnkey_version says ${text}, but ${pkg} is not installed`,
    };
  return { kind: "supported", appliance: name, label: `${LABELS[name]} ${version}` };
}

/**
 * Whether TurnKey's first-boot setup (inithooks) has finished. From TurnKey's sources: the last
 * firstboot.d hook, `98finalize`, sets `RUN_FIRSTBOOT=false` in `/etc/default/inithooks`, and
 * `97turnkey-init-fence-disable` stops the `turnkey-init-fence` service that redirects remote 80
 * and 443. Both must hold: a headless build finishes the first and keeps the fence until the
 * first login. Needs confirming on a real TurnKey VM (spec 14).
 */
export async function firstBootFinished(ctx: Context): Promise<boolean> {
  const defaults = await readTextOr(ctx.paths.under("etc/default/inithooks"));
  if (defaults === undefined) return false;
  const flag = /^\s*RUN_FIRSTBOOT=["']?(\w+)/m.exec(defaults)?.[1];
  if (flag?.toLowerCase() !== "false") return false;
  const fence = await ctx.runner.run("systemctl", ["is-active", "--quiet", "turnkey-init-fence"]);
  return fence.code !== 0;
}

async function turnkeyCheck(ctx: Context, facts: HostFacts): Promise<CheckResult[]> {
  const state = await facts.turnkey();
  if (state.kind === "none") return [];
  if (state.kind === "unsupported") {
    return [
      {
        kind: "problem",
        severity: "fail",
        message: `${state.found}. ${UNSUPPORTED_APPLIANCE}`,
        hint: "See the README for the supported Hosts.",
      },
    ];
  }
  if (!(await firstBootFinished(ctx))) {
    return [
      {
        kind: "problem",
        severity: "fail",
        message: `${state.label}: TurnKey's first-boot setup has not finished.`,
        hint: "Finish it on the console, or log in as root to start it, then run again: sudo dcabsm host setup",
      },
    ];
  }
  return [{ kind: "pass", label: `${state.label}: first-boot setup has finished` }];
}

/** One thing on TurnKey that clashes with DCABSM (spec 10.7). */
interface Piece {
  /** For setup's plan line. */
  name: string;
  /** For doctor. */
  message: string;
  onlyOn?: Appliance;
  isInPlace(ctx: Context): Promise<boolean>;
  disable(ctx: Context): Promise<void>;
}

const SITE = "etc/nginx/sites-enabled/nodejs";
const JOB = "etc/cron.daily/confconsole-dehydrated";

const PIECES: Piece[] = [
  {
    name: "TurnKey's nodejs Nginx site",
    message: "TurnKey's nodejs Nginx site is enabled (/etc/nginx/sites-enabled/nodejs).",
    onlyOn: "nodejs",
    isInPlace: async (ctx) =>
      lstat(ctx.paths.under(SITE)).then(
        () => true,
        () => false,
      ),
    disable: (ctx) => rm(ctx.paths.under(SITE), { force: true }),
  },
  {
    name: "pm2-node.service",
    message: "pm2-node.service is enabled or running.",
    onlyOn: "nodejs",
    isInPlace: async (ctx) => {
      for (const verb of ["is-enabled", "is-active"])
        if ((await ctx.runner.run("systemctl", [verb, "--quiet", "pm2-node.service"])).code === 0)
          return true;
      return false;
    },
    disable: (ctx) => systemctl(ctx, "disable", "--now", "pm2-node.service"),
  },
  {
    name: "confconsole's Let's Encrypt renewal job",
    message:
      "confconsole's Let's Encrypt renewal job is executable (/etc/cron.daily/confconsole-dehydrated); it stops Nginx.",
    isInPlace: async (ctx) => {
      try {
        return ((await stat(ctx.paths.under(JOB))).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    disable: async (ctx) => {
      const path = ctx.paths.under(JOB);
      await chmod(path, (await stat(path)).mode & 0o7666);
    },
  },
];

/** The pieces that are in place on this appliance; none off TurnKey. */
async function piecesInPlace(
  ctx: Context,
  detect: () => Promise<TurnkeyState> = () => detectTurnkey(ctx),
): Promise<Piece[]> {
  const state = await detect();
  if (state.kind !== "supported") return [];
  const found: Piece[] = [];
  for (const piece of PIECES) {
    if (piece.onlyOn && piece.onlyOn !== state.appliance) continue;
    if (await piece.isInPlace(ctx)) found.push(piece);
  }
  return found;
}

export interface TurnkeyPlan {
  /** Setup's plan line, such as "Disable TurnKey's nodejs Nginx site and pm2-node.service (nothing is deleted)". */
  line: string;
  disable(): Promise<void>;
}

/** What setup will disable, or undefined when there is nothing to ask about. */
export async function turnkeyPlan(ctx: Context): Promise<TurnkeyPlan | undefined> {
  const pieces = await piecesInPlace(ctx);
  if (pieces.length === 0) return undefined;
  const names = pieces.map((p) => p.name);
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return {
    line: `Disable ${list} (nothing is deleted)`,
    disable: async () => {
      for (const piece of pieces) await piece.disable(ctx);
    },
  };
}

async function piecesCheck(ctx: Context, facts: HostFacts): Promise<CheckResult[]> {
  const state = await facts.turnkey();
  if (state.kind !== "supported") return [];
  const results: CheckResult[] = [];
  const back = await piecesInPlace(ctx, () => facts.turnkey());
  for (const piece of back) {
    results.push({
      kind: "problem",
      severity: "warn",
      message: piece.message,
      hint: "It clashes with DCABSM (spec 10.7). Nothing is deleted when it is disabled.",
      fix: { apply: () => piece.disable(ctx) },
    });
  }
  if (back.length === 0)
    results.push({ kind: "pass", label: "TurnKey pieces that clash with DCABSM are disabled" });
  if (await isInstalled(ctx, "webmin-nginx")) {
    results.push({
      kind: "problem",
      severity: "note",
      message: "webmin-nginx is installed. Do not use Webmin to edit Nginx files.",
    });
  }
  return results;
}

/** The TurnKey entries of the Host check list (spec 10.3, 10.6, 10.7). */
export const turnkeyChecks: Check[] = [
  { id: "turnkey", refuses: true, run: turnkeyCheck },
  { id: "turnkey-pieces", run: piecesCheck },
];
