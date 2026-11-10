import type { Context } from "../context.ts";
import { firstLine } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { healthChecks } from "./health.ts";
import { detectOs, supportedNames } from "./os.ts";
import { isInstalled } from "./system.ts";
import { treeChecks } from "./tree.ts";
import { detectTurnkey, turnkeyChecks, type TurnkeyState } from "./turnkey.ts";

export { isInstalled };

export type Override = "DCABSM_ALLOW_CONTAINER" | "DCABSM_ALLOW_NGINX_ORG";

/** How bad a problem is. Doctor's exit code follows the worst one: notes 0, warnings 1, failures 2. */
export type Severity = "note" | "warn" | "fail";

/** What `host doctor --fix` can do about one problem. */
export interface Fix {
  /** Lines shown before asking, such as the diff of an owned file. */
  diff?: string[];
  apply(): Promise<void>;
}

export type CheckResult =
  | { kind: "pass"; label: string }
  | {
      kind: "problem";
      severity: Severity;
      message: string;
      hint?: string;
      override?: Override;
      fix?: Fix;
    };

/** A problem that makes setup refuse (spec 10.3). */
export type Refusal = Extract<CheckResult, { kind: "problem" }>;

/**
 * One entry in the list setup and doctor share (spec 10.1). `run` is the test and gives one result
 * per thing it looked at; a problem's severity says how doctor rates it and its `fix`, if any, is
 * what `doctor --fix` does. A check with `refuses` also stops setup, before anything changes.
 */
export interface Check {
  id: string;
  refuses?: boolean;
  run(ctx: Context, facts: HostFacts): Promise<CheckResult[]>;
}

/** What the checks of one run learn about the Host once and share, so a run looks at each thing a single time. */
export interface HostFacts {
  turnkey(): Promise<TurnkeyState>;
}

export function hostFacts(ctx: Context): HostFacts {
  let turnkey: Promise<TurnkeyState> | undefined;
  return { turnkey: () => (turnkey ??= detectTurnkey(ctx)) };
}

const RERUN = "then run again: sudo dcabsm host setup";

async function osCheck(ctx: Context, facts: HostFacts): Promise<CheckResult> {
  const os = await detectOs(ctx);
  if (!os.supported) {
    return {
      kind: "problem",
      severity: "fail",
      message: `${os.name} on ${os.arch} is not a supported Host.`,
      hint: `Supported: ${supportedNames()}. See the README for architectures.`,
    };
  }
  const turnkey = await facts.turnkey();
  if (turnkey.kind === "supported")
    return { kind: "pass", label: `${turnkey.label} (${os.supported.name}), ${os.arch}` };
  const codename = os.codename ? ` (${os.codename})` : "";
  return { kind: "pass", label: `${os.supported.name}${codename}, ${os.arch}` };
}

async function proxmoxCheck(ctx: Context): Promise<CheckResult> {
  if (await exists(ctx.paths.under("usr/bin/pveversion"))) {
    return {
      kind: "problem",
      severity: "fail",
      message: "This is the Proxmox VE host itself.",
      hint: "Install DCABSM in a virtual machine on it instead.",
    };
  }
  return { kind: "pass", label: "Not the Proxmox VE host" };
}

async function containerCheck(ctx: Context): Promise<CheckResult> {
  const res = await ctx.runner.run("systemd-detect-virt", ["--container"]);
  const type = res.stdout.trim();
  if (res.code === 0 && type !== "" && type !== "none") {
    return {
      kind: "problem",
      severity: "fail",
      message: `This Host is a container (${type}).`,
      hint: "Use a virtual machine or bare metal. LXC, WSL, Docker and Podman are not supported.",
      override: "DCABSM_ALLOW_CONTAINER",
    };
  }
  return { kind: "pass", label: "Not a container" };
}

/** Whether apt's installed or candidate `nginx` comes from nginx.org. */
export function nginxOrgInPolicy(policy: string): boolean {
  const installed = /^\s*Installed:\s*(\S+)/m.exec(policy)?.[1];
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(policy)?.[1];
  let current: string | undefined;
  for (const line of policy.split("\n")) {
    // A version line is indented less than the source lines under it.
    const version = /^ {0,5}(?:\*\*\* )?(\S+) +\d+\s*$/.exec(line)?.[1];
    if (version) current = version;
    else if (line.includes("nginx.org") && (current === installed || current === candidate))
      return true;
  }
  return false;
}

async function nginxOrgCheck(ctx: Context): Promise<CheckResult> {
  const res = await ctx.runner.run("env", ["LC_ALL=C", "apt-cache", "policy", "nginx"]);
  if (nginxOrgInPolicy(res.stdout)) {
    return {
      kind: "problem",
      severity: "fail",
      message: "Nginx comes from nginx.org's package.",
      hint: `Only the distro's nginx package is supported. Remove the nginx.org repository, ${RERUN}`,
      override: "DCABSM_ALLOW_NGINX_ORG",
    };
  }
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(res.stdout)?.[1];
  return {
    kind: "pass",
    label: `Nginx: apt's candidate is the distro's${candidate ? ` ${candidate}` : ""}`,
  };
}

interface Listener {
  port: number;
  process: string | undefined;
  pid: number | undefined;
}

/** Parses `ss -H -ltnp`, keeping the listeners on ports 80 and 443. */
export function parseListeners(output: string): Listener[] {
  const found: Listener[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const port = Number(/:(\d+)$/.exec(fields[3] ?? "")?.[1]);
    if (port !== 80 && port !== 443) continue;
    const who = /\(\("([^"]+)",pid=(\d+)/.exec(line);
    found.push({ port, process: who?.[1], pid: who ? Number(who[2]) : undefined });
  }
  return found;
}

/** The distro's own Nginx is the one binary at /usr/sbin/nginx that the `nginx` package owns. */
async function isDistroNginx(ctx: Context, pid: number): Promise<boolean> {
  const exe = await ctx.runner.run("readlink", ["-f", `/proc/${pid}/exe`]);
  // After an upgrade the kernel reports the replaced binary as "<path> (deleted)".
  if (exe.stdout.trim().replace(/ \(deleted\)$/, "") !== "/usr/sbin/nginx") return false;
  const owner = await ctx.runner.run("env", ["LC_ALL=C", "dpkg", "-S", "/usr/sbin/nginx"]);
  const packages = owner.stdout.split(":")[0]?.split(", ") ?? [];
  return owner.code === 0 && packages.some((p) => p === "nginx" || p === "nginx-core");
}

async function portsCheck(ctx: Context): Promise<CheckResult> {
  const res = await ctx.runner.run("ss", ["-H", "-ltnp"]);
  if (res.code !== 0) {
    return {
      kind: "problem",
      severity: "fail",
      message: "Could not check what is listening on ports 80 and 443.",
      hint: `Make sure the ss command works (package iproute2), ${RERUN}`,
    };
  }
  for (const listener of parseListeners(res.stdout)) {
    if (
      listener.process === "nginx" &&
      listener.pid !== undefined &&
      (await isDistroNginx(ctx, listener.pid))
    ) {
      continue;
    }
    const who = listener.process
      ? `${listener.process}${listener.pid === undefined ? "" : ` (pid ${listener.pid})`}`
      : "another process";
    return {
      kind: "problem",
      severity: "fail",
      message: `Port ${listener.port} is already in use by ${who}.`,
      hint: `DCABSM needs ports 80 and 443 for the distro's Nginx. Stop or move it, ${RERUN}`,
    };
  }
  return { kind: "pass", label: "Nothing else listening on 80 or 443" };
}

async function nginxConfigCheck(ctx: Context): Promise<CheckResult> {
  if (!(await isInstalled(ctx, "nginx")))
    return { kind: "pass", label: "No existing Nginx config" };
  const res = await ctx.runner.run("nginx", ["-t"]);
  if (res.code !== 0) {
    const reason = firstLine(res.stderr, "no reason given");
    return {
      kind: "problem",
      severity: "fail",
      message: `The existing Nginx config fails nginx -t: ${reason}`,
      hint: `Fixing it is a Manual System Admin task. Fix it, ${RERUN}`,
    };
  }
  return { kind: "pass", label: "The existing Nginx config passes nginx -t" };
}

const refusing = (
  id: string,
  test: (ctx: Context, facts: HostFacts) => Promise<CheckResult>,
): Check => ({
  id,
  refuses: true,
  run: async (ctx, facts) => [await test(ctx, facts)],
});

/** Every Host check, in the order doctor reports them (spec 10.6). The refusing ones also refuse in setup (spec 10.3). */
export const hostChecks: Check[] = [
  refusing("os", osCheck),
  ...turnkeyChecks,
  refusing("proxmox", proxmoxCheck),
  refusing("container", containerCheck),
  refusing("nginx-origin", nginxOrgCheck),
  refusing("ports", portsCheck),
  refusing("nginx-config", nginxConfigCheck),
  ...healthChecks,
  ...treeChecks,
];

/** Setup runs the checks that refuse. Nothing here changes the Host. */
export async function runChecks(ctx: Context): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const facts = hostFacts(ctx);
  for (const check of hostChecks) {
    if (check.refuses) results.push(...(await check.run(ctx, facts)));
  }
  return results;
}
