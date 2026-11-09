import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "../context.ts";
import { lineDiff } from "../diff.ts";
import { refusal } from "../errors.ts";
import { exists, writeFileAtomic } from "../fsutil.ts";
import { step } from "../output.ts";

/** A file DCABSM owns (spec 10.5). `path` is the logical path on the Host. */
export interface OwnedFile {
  path: string;
  content: string;
  mode: number;
}

export type OwnedState = "new" | "current" | "refresh" | "drift";

export interface InspectedFile {
  file: OwnedFile;
  /** new: missing. current: already right. refresh: DCABSM's own older output. drift: edited by hand. */
  state: OwnedState;
  old?: string;
}

export const SERVICE_PATH = "/etc/systemd/system/dcabsm@.service";
export const TIMER_PATH = "/etc/systemd/system/dcabsm-nightly.timer";
export const NIGHTLY_PATH = "/etc/systemd/system/dcabsm-nightly.service";
export const CONF_PATH = "/etc/nginx/conf.d/dcabsm.conf";
export const DEFAULT_CONF_PATH = "/etc/nginx/conf.d/dcabsm-default.conf";

const HEADER = "# Owned by DCABSM. Changes are overwritten; `dcabsm host doctor` flags them.\n";

export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The Instance unit template (spec 4.5). */
export function unitTemplate(): string {
  const dir = "/srv/dcabsm/instances/%i";
  return `${HEADER}[Unit]
Description=Actual Budget server (Instance %i)
After=network-online.target
Wants=network-online.target
ConditionPathExists=!${dir}/.changing-release
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
ExecStart=${dir}/release/node_modules/.bin/actual-server --config ${dir}/config/config.json
WorkingDirectory=${dir}
Environment=ACTUAL_DATA_DIR=${dir}/data
Environment=NODE_ENV=production
Environment=PATH=${dir}/release/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=on-failure
RestartSec=5
User=dcabsm-%i
Group=dcabsm-%i
UMask=0077
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ReadWritePaths=${dir}/data ${dir}/server-files ${dir}/user-files
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
`;
}

/** The Nightly timer (spec 8.1): daily at `nightlyTime`, no random delay. */
export function nightlyTimer(nightlyTime: string): string {
  return `${HEADER}[Unit]
Description=DCABSM Nightly run

[Timer]
OnCalendar=*-*-* ${nightlyTime}:00
Persistent=true
RandomizedDelaySec=0
AccuracySec=1s

[Install]
WantedBy=timers.target
`;
}

export function nightlyService(): string {
  return `${HEADER}[Unit]
Description=DCABSM Nightly run (Backups and Retention)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/dcabsm host nightly
`;
}

export function nginxInclude(): string {
  return `${HEADER}include /srv/dcabsm/instances/*/nginx/vhost.conf;\n`;
}

export function nginxDefaultServer(): string {
  return `${HEADER}server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_reject_handshake on;
}
`;
}

/** Whether a default server on 443 exists that DCABSM didn't write (spec 5.3). */
export async function otherDefaultOn443(ctx: Context): Promise<boolean> {
  const nginx = ctx.paths.under("/etc/nginx");
  const candidates = [join(nginx, "nginx.conf")];
  for (const sub of ["conf.d", "sites-enabled"]) {
    try {
      for (const name of await readdir(join(nginx, sub))) {
        if (name !== "dcabsm-default.conf") candidates.push(join(nginx, sub, name));
      }
    } catch {
      // No such directory.
    }
  }
  for (const path of candidates) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const code = text.replace(/#.*$/gm, "");
    if (/\blisten\b[^;]*\b443\b[^;]*\bdefault_server\b/.test(code)) return true;
  }
  return false;
}

/** The Host-level owned files, for a given `nightlyTime`. */
export async function hostOwnedFiles(ctx: Context, nightlyTime: string): Promise<OwnedFile[]> {
  const files: OwnedFile[] = [
    { path: SERVICE_PATH, content: unitTemplate(), mode: 0o644 },
    { path: TIMER_PATH, content: nightlyTimer(nightlyTime), mode: 0o644 },
    { path: NIGHTLY_PATH, content: nightlyService(), mode: 0o644 },
    { path: CONF_PATH, content: nginxInclude(), mode: 0o644 },
  ];
  // A default server DCABSM wrote earlier stays managed; otherwise another one wins.
  const ours = await exists(ctx.paths.under(DEFAULT_CONF_PATH));
  if (ours || !(await otherDefaultOn443(ctx))) {
    files.push({ path: DEFAULT_CONF_PATH, content: nginxDefaultServer(), mode: 0o644 });
  }
  return files;
}

export const isNginxFile = (file: OwnedFile): boolean => file.path.startsWith("/etc/nginx/");

/** Compares each file on disk with what DCABSM would write and the hash it last recorded. */
export async function inspectOwnedFiles(
  ctx: Context,
  files: OwnedFile[],
  hashes: Record<string, string>,
): Promise<InspectedFile[]> {
  const result: InspectedFile[] = [];
  for (const file of files) {
    let old: string;
    try {
      old = await readFile(ctx.paths.under(file.path), "utf8");
    } catch {
      result.push({ file, state: "new" });
      continue;
    }
    if (old === file.content) result.push({ file, state: "current", old });
    else if (hashes[file.path] === hashOf(old)) result.push({ file, state: "refresh", old });
    else result.push({ file, state: "drift", old });
  }
  return result;
}

/** The files `writeOwnedFiles` has work for: everything not already right. */
export const pending = (inspected: InspectedFile[]): InspectedFile[] =>
  inspected.filter((i) => i.state !== "current");

/**
 * Decides every drifted file before anything changes: the diff, then replace or keep.
 * With no terminal, `--yes` replaces and its absence refuses, listing the files.
 */
export async function resolveDrift(
  ctx: Context,
  inspected: InspectedFile[],
  flags: { yes?: boolean },
): Promise<Set<string>> {
  const replace = new Set<string>();
  const drifted = inspected.filter((i) => i.state === "drift");
  if (drifted.length === 0) return replace;
  if (!flags.yes && !ctx.io.interactive) {
    throw refusal(
      `These files were edited by hand: ${drifted.map((d) => d.file.path).join(", ")}`,
      "Nothing changed. Re-run with --yes to replace them (old copies are saved to /etc/dcabsm/replaced/).",
    );
  }
  for (const { file, old } of drifted) {
    if (flags.yes) {
      replace.add(file.path);
      continue;
    }
    ctx.io.out(`${file.path} was edited by hand. DCABSM would change it like this:`);
    for (const line of lineDiff(old ?? "", file.content)) ctx.io.out(`    ${line}`);
    for (;;) {
      const answer = (
        await ctx.io.ask("replace (old copy saved to /etc/dcabsm/replaced/) or keep? [r/k] ")
      )
        .trim()
        .toLowerCase();
      if (answer === "r" || answer === "replace") {
        replace.add(file.path);
        break;
      }
      if (answer === "k" || answer === "keep") break;
    }
  }
  return replace;
}

export interface WriteResult {
  written: string[];
  kept: string[];
  /** The hashes to store: the old ones, plus every file now matching what DCABSM wrote. */
  hashes: Record<string, string>;
}

/** The reusable owned-file writer (setup, doctor, Self-update). */
export async function writeOwnedFiles(
  ctx: Context,
  inspected: InspectedFile[],
  replace: Set<string>,
  hashes: Record<string, string>,
): Promise<WriteResult> {
  const result: WriteResult = { written: [], kept: [], hashes: { ...hashes } };
  const stamp = ctx.now().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  for (const { file, state, old } of inspected) {
    if (state === "current") {
      result.hashes[file.path] = hashOf(file.content);
      continue;
    }
    if (state === "drift" && !replace.has(file.path)) {
      result.kept.push(file.path);
      continue;
    }
    if (state === "drift") {
      const saved = join(ctx.paths.etc, "replaced", stamp, file.path);
      await mkdir(dirname(saved), { recursive: true, mode: 0o700 });
      await writeFile(saved, old ?? "", { mode: 0o600 });
    }
    const target = ctx.paths.under(file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFileAtomic(target, file.content, file.mode);
    result.hashes[file.path] = hashOf(file.content);
    result.written.push(file.path);
  }
  for (const path of result.kept)
    step(ctx, "warn", `Kept your edited ${path}; host doctor keeps raising it`);
  return result;
}
