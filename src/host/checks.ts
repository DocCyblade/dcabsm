import type { Context } from "../context.ts";
import { exists } from "../fsutil.ts";
import { detectOs, supportedNames } from "./os.ts";

export type Override = "DCABSM_ALLOW_CONTAINER" | "DCABSM_ALLOW_NGINX_ORG";

export type CheckResult =
  | { kind: "pass"; label: string }
  | { kind: "refuse"; message: string; hint?: string; override?: Override };

const RERUN = "then run again: sudo dcabsm host setup";

/** The checks that can refuse, in the order setup runs them (spec 10.3). Nothing here changes the Host. */
export async function runChecks(ctx: Context): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of [
    osCheck,
    proxmoxCheck,
    containerCheck,
    nginxOrgCheck,
    portsCheck,
    nginxConfigCheck,
  ]) {
    results.push(await check(ctx));
  }
  return results;
}

async function osCheck(ctx: Context): Promise<CheckResult> {
  const os = await detectOs(ctx);
  if (!os.supported) {
    return {
      kind: "refuse",
      message: `${os.name} on ${os.arch} is not a supported Host.`,
      hint: `Supported: ${supportedNames()}. See the README for architectures.`,
    };
  }
  const codename = os.codename ? ` (${os.codename})` : "";
  return { kind: "pass", label: `${os.supported.name}${codename}, ${os.arch}` };
}

async function proxmoxCheck(ctx: Context): Promise<CheckResult> {
  if (await exists(ctx.paths.under("usr/bin/pveversion"))) {
    return {
      kind: "refuse",
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
      kind: "refuse",
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
  const res = await ctx.runner.run("apt-cache", ["policy", "nginx"]);
  if (nginxOrgInPolicy(res.stdout)) {
    return {
      kind: "refuse",
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
  if (exe.stdout.trim() !== "/usr/sbin/nginx") return false;
  const owner = await ctx.runner.run("dpkg", ["-S", "/usr/sbin/nginx"]);
  return owner.code === 0 && owner.stdout.startsWith("nginx:");
}

async function portsCheck(ctx: Context): Promise<CheckResult> {
  const res = await ctx.runner.run("ss", ["-H", "-ltnp"]);
  if (res.code !== 0) {
    return {
      kind: "refuse",
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
      kind: "refuse",
      message: `Port ${listener.port} is already in use by ${who}.`,
      hint: `DCABSM needs ports 80 and 443 for the distro's Nginx. Stop or move it, ${RERUN}`,
    };
  }
  return { kind: "pass", label: "Nothing else listening on 80 or 443" };
}

export async function isInstalled(ctx: Context, pkg: string): Promise<boolean> {
  const res = await ctx.runner.run("dpkg-query", ["-W", "-f=${Status}", pkg]);
  return res.code === 0 && res.stdout.includes("install ok installed");
}

async function nginxConfigCheck(ctx: Context): Promise<CheckResult> {
  if (!(await isInstalled(ctx, "nginx")))
    return { kind: "pass", label: "No existing Nginx config" };
  const res = await ctx.runner.run("nginx", ["-t"]);
  if (res.code !== 0) {
    const reason = res.stderr.split("\n").find((l) => l.trim() !== "") ?? "no reason given";
    return {
      kind: "refuse",
      message: `The existing Nginx config fails nginx -t: ${reason.trim()}`,
      hint: `Fixing it is a Manual System Admin task. Fix it, ${RERUN}`,
    };
  }
  return { kind: "pass", label: "The existing Nginx config passes nginx -t" };
}
