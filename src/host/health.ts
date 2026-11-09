import type { Context } from "../context.ts";
import { bannerLine, readHostConfig } from "./config.ts";
import { otherDefaultOn443 } from "./owned.ts";
import type { Check, CheckResult } from "./checks.ts";
import {
  isInstalled,
  nginxIsActive,
  nginxIsEnabled,
  nginxTestFailure,
  systemctl,
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

export const healthChecks: Check[] = [
  { id: "unsupported-mark", run: unsupportedMark },
  { id: "nginx-running", run: nginxRunning },
  { id: "default-443", run: defaultOn443 },
];
