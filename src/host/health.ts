import type { Context } from "../context.ts";
import { lineDiff } from "../diff.ts";
import { bannerLine, defaultHostConfig, readHostConfig, DEFAULT_BACKUP_DIR } from "./config.ts";
import {
  hostOwnedFiles,
  inspectOwnedFiles,
  isNginxFile,
  otherDefaultOn443,
  pending,
  writeVerified,
  type InspectedFile,
} from "./owned.ts";
import type { Check, CheckResult } from "./checks.ts";
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
  const what = !running && !enabled ? "not running and not enabled at boot" : running ? "not enabled at boot" : "not running";
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
  const path = item.file.path;
  const result = await writeVerified(
    ctx,
    [item],
    new Set([path]),
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

export const healthChecks: Check[] = [
  { id: "unsupported-mark", run: unsupportedMark },
  { id: "nginx-running", run: nginxRunning },
  { id: "owned-files", run: ownedFiles },
  { id: "timer", run: timer },
  { id: "default-443", run: defaultOn443 },
];
