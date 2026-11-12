/**
 * The lab (spec 13.4): reads the private VM registry, picks the VM for an OS, plans the journey and
 * talks to Proxmox. Nothing here holds a real hostname, address or token: they all come from the
 * registry file at run time (`~/.config/test-vms.env`, mode 600, outside the repo).
 *
 * Proxmox is only ever asked to roll a VM back to an existing snapshot, to power it on and to read
 * its state (`pveAllowed`). Nothing creates, deletes or reconfigures a VM.
 */

export type JourneyOs = "debian-13" | "ubuntu-24.04" | "ubuntu-26.04" | "turnkey";
export const JOURNEY_OSES: readonly JourneyOs[] = [
  "debian-13",
  "ubuntu-24.04",
  "ubuntu-26.04",
  "turnkey",
];
export const TURNKEY_SNAPSHOTS = ["clean-core", "clean-nodejs"] as const;

export function isJourneyOs(value: string): value is JourneyOs {
  return (JOURNEY_OSES as readonly string[]).includes(value);
}

/** Parses the registry: shell-style `KEY=value` lines, optionally `export`ed and quoted. Nothing is expanded. */
export function parseRegistry(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!match) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    env[match[1]!] = value;
  }
  return env;
}

export interface LabVm {
  name: string;
  purpose: string;
  features: string;
  notes: string;
  os: string;
  pve: string;
  node: string;
  vmid: string;
  sshHost: string;
  sshUser: string;
  snapshots: string[];
  url: string;
  /** `user@realm!token=secret`, ready for the Authorization header. Never printed. */
  token: string;
}

const words = (value: string | undefined): string[] =>
  (value ?? "")
    .replace(/[()"']/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);

/** Every VM named in `VMS`, with what the registry holds for it. Incomplete VMs are still returned. */
export function loadVms(env: Record<string, string>): LabVm[] {
  return words(env.VMS).map((name) => {
    const get = (key: string): string => env[`TVM_${name}_${key}`] ?? "";
    const pve = get("PVE");
    const viaPve = (key: string): string => env[`PVE_${pve}_${key}`] ?? "";
    const id = get("TOKEN_ID") || viaPve("TOKEN_ID");
    const secret = get("TOKEN_SECRET") || viaPve("TOKEN_SECRET");
    const full = get("TOKEN") || viaPve("TOKEN");
    return {
      name,
      purpose: get("PURPOSE"),
      features: get("FEATURES"),
      notes: get("NOTES"),
      os: get("OS"),
      pve,
      node: get("NODE"),
      vmid: get("VMID"),
      sshHost: get("SSH_HOST"),
      sshUser: get("SSH_USER"),
      snapshots: words(get("SNAPSHOT")),
      url: viaPve("URL").replace(/\/+$/, ""),
      token: full || (id && secret ? `${id}=${secret}` : ""),
    };
  });
}

const flatten = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How the Ubuntu LTS releases are also written in PURPOSE and NOTES, such as "Ubuntu LTS 24". */
const LTS_WORDING: Partial<Record<JourneyOs, RegExp>> = {
  "ubuntu-24.04": /\blts\s*24\b/i,
  "ubuntu-26.04": /\blts\s*26\b/i,
};

function mentions(text: string, os: JourneyOs): boolean {
  const flat = flatten(text);
  if (os === "turnkey") return flat.includes("turnkey");
  return flat.includes(flatten(os)) || (LTS_WORDING[os]?.test(text) ?? false);
}

/** The `OS` key names the OS outright, so it must be the OS and not merely contain it (`ubuntu-24.04-ci`). */
const isOsKey = (value: string, os: JourneyOs): boolean => flatten(value) === flatten(os);

/**
 * The VM for an OS, or undefined. An `OS` key (`TVM_<NAME>_OS`) decides first; then PURPOSE and
 * FEATURES; NOTES only when nothing else matches. A TurnKey VM never counts as a plain Debian VM.
 * `pick` names a VM to use when several fit.
 */
export function selectVm(vms: LabVm[], os: JourneyOs, pick?: string): LabVm | undefined {
  const isTurnkey = (vm: LabVm): boolean =>
    mentions(`${vm.os} ${vm.purpose} ${vm.features}`, "turnkey");
  const eligible = vms.filter((vm) => (os === "turnkey" ? true : !isTurnkey(vm)));
  const matchers: Array<(vm: LabVm) => boolean> = [
    (vm) => isOsKey(vm.os, os),
    (vm) => mentions(`${vm.purpose} ${vm.features}`, os),
    (vm) => mentions(vm.notes, os),
  ];
  for (const matches of matchers) {
    const found = eligible.filter(matches);
    if (pick) {
      const named = found.find((vm) => vm.name === pick);
      if (named) return named;
    } else if (found[0]) {
      return found[0];
    }
  }
  return undefined;
}

/** The snapshots to run from: TurnKey runs from the clean-core/clean-nodejs snapshots it has, any other VM from its first. */
export function snapshotsFor(vm: LabVm, os: JourneyOs): string[] {
  if (os === "turnkey") {
    const named = vm.snapshots.filter((s) => (TURNKEY_SNAPSHOTS as readonly string[]).includes(s));
    if (named.length > 0) return named;
  }
  // Any other VM, and a TurnKey VM registered with a single snapshot (one VM per flavour), runs from its first.
  return [vm.snapshots[0] ?? "clean"];
}

/** What is missing before a VM can be driven; empty when it is complete. Names keys, never values. */
export function missingKeys(vm: LabVm): string[] {
  const need: Array<[string, string]> = [
    ["NODE", vm.node],
    ["VMID", vm.vmid],
    ["SSH_HOST", vm.sshHost],
    ["PVE", vm.url],
    ["TOKEN_ID/TOKEN_SECRET", vm.token],
  ];
  return need.filter(([, v]) => !v).map(([k]) => k);
}

export interface Selection {
  os: JourneyOs;
  skipped?: string;
  vm?: LabVm;
  snapshots: string[];
}

export function resolveOs(env: Record<string, string>, os: JourneyOs, pick?: string): Selection {
  const vm = selectVm(loadVms(env), os, pick);
  if (!vm) return { os, snapshots: [], skipped: `skipped: no VM for ${os}` };
  const missing = missingKeys(vm);
  if (missing.length > 0)
    return {
      os,
      snapshots: [],
      skipped: `skipped: the VM for ${os} is not fully described (missing ${missing.join(", ")})`,
    };
  return { os, vm, snapshots: snapshotsFor(vm, os) };
}

// ---- The journey, as an ordered list of step ids that journey-remote.sh implements ----

export type StepId =
  | "install"
  | "install-prev"
  | "tk-setup-prompt"
  | "setup"
  | "tk-pieces"
  | "create-alpha"
  | "create-beta"
  | "tk-vhost"
  | "upgrade"
  | "rollback"
  | "backup"
  | "restore"
  | "clone"
  | "reboot"
  | "doctor"
  | "tk-doctor"
  | "self-update";

export interface JourneyOptions {
  os: JourneyOs;
  /** Run the `self update` step (spec 13.5 step 3) instead of the main journey. */
  selfUpdate?: boolean;
}

export function planSteps(opts: JourneyOptions): StepId[] {
  const tk = opts.os === "turnkey";
  const turnkeyOnly = <T extends StepId>(...ids: T[]): T[] => (tk ? ids : []);
  if (opts.selfUpdate)
    return [
      "install-prev",
      ...turnkeyOnly("tk-setup-prompt" as const),
      "setup",
      "create-alpha",
      "self-update",
      "reboot",
      "doctor",
    ];
  return [
    "install",
    ...turnkeyOnly("tk-setup-prompt" as const),
    "setup",
    ...turnkeyOnly("tk-pieces" as const),
    "create-alpha",
    "create-beta",
    ...turnkeyOnly("tk-vhost" as const),
    "upgrade",
    "rollback",
    "backup",
    "restore",
    "clone",
    "reboot",
    "doctor",
    ...turnkeyOnly("tk-doctor" as const),
  ];
}

// ---- Proxmox, through one narrow door ----

export interface PveRequest {
  method: "GET" | "POST";
  /** Path under /api2/json, such as `nodes/<node>/qemu/<vmid>/status/current`. */
  path: string;
}
export interface PveResponse {
  status: number;
  /** The `data` member of the answer. */
  data: unknown;
}
export type PveTransport = (req: PveRequest) => Promise<PveResponse>;

/** The only calls the lab makes: read state and tasks, roll back to a snapshot, power on. */
export function pveAllowed(req: PveRequest): boolean {
  if (req.path.includes("..")) return false;
  if (req.method === "GET")
    return /^nodes\/[\w.-]+\/(qemu\/\d+\/status\/current|tasks\/[^/]+\/status)$/.test(req.path);
  return /^nodes\/[\w.-]+\/qemu\/\d+\/(snapshot\/[\w-]+\/rollback|status\/start)$/.test(req.path);
}

export function guardedPve(transport: PveTransport): PveTransport {
  return async (req) => {
    if (!pveAllowed(req)) throw new Error(`refused: ${req.method} is not a call the lab makes`);
    return transport(req);
  };
}

export interface RollbackDeps {
  pve: PveTransport;
  sleep(ms: number): Promise<void>;
  /** Waits until the VM answers over SSH; throws when it does not. */
  waitForSsh(): Promise<void>;
}

async function waitTask(deps: RollbackDeps, node: string, upid: unknown): Promise<void> {
  if (typeof upid !== "string") throw new Error("Proxmox gave no task id");
  for (let i = 0; i < 120; i++) {
    const res = await deps.pve({
      method: "GET",
      path: `nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
    });
    const task = res.data as { status?: string; exitstatus?: string } | null;
    if (task?.status === "stopped") {
      if (task.exitstatus && task.exitstatus !== "OK")
        throw new Error(`Proxmox task failed: ${task.exitstatus}`);
      return;
    }
    await deps.sleep(2000);
  }
  throw new Error("Proxmox task did not finish");
}

/** Rolls the VM back to its snapshot, makes sure it is running and waits for SSH. */
export async function rollbackVm(vm: LabVm, snapshot: string, deps: RollbackDeps): Promise<void> {
  const base = `nodes/${vm.node}/qemu/${vm.vmid}`;
  const rolled = await deps.pve({ method: "POST", path: `${base}/snapshot/${snapshot}/rollback` });
  if (rolled.status >= 300)
    throw new Error(`rollback to ${snapshot} was refused (HTTP ${rolled.status})`);
  await waitTask(deps, vm.node, rolled.data);
  const state = await deps.pve({ method: "GET", path: `${base}/status/current` });
  if ((state.data as { status?: string } | null)?.status !== "running") {
    const started = await deps.pve({ method: "POST", path: `${base}/status/start` });
    await waitTask(deps, vm.node, started.data);
  }
  await deps.waitForSsh();
}

// ---- Output that may be shared ----

/** Hides IPv4 and IPv6 addresses and every secret or lab detail given, longest first. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  const sorted = [...new Set(secrets.filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of sorted) out = out.split(secret).join("<redacted>");
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
  out = out.replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, (m) =>
    m.includes("::") || m.split(":").length === 8 ? "<ip>" : m,
  );
  return out;
}

/** Everything in a VM's description that must not reach a log. */
export function secretsOf(vm: LabVm): string[] {
  const secret = vm.token.split("=").slice(-1)[0] ?? "";
  return [vm.token, secret, vm.sshHost, vm.node, vm.vmid, vm.url, vm.pve].filter(Boolean);
}
