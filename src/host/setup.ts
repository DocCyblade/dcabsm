import { isAbsolute } from "node:path";
import { parseFlags } from "../args.ts";
import type { Context } from "../context.ts";
import { Cancelled, CliError, firstLine, refusal } from "../errors.ts";
import { ensureDir, exists } from "../fsutil.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirm, confirmOrCancel } from "../prompt.ts";
import {
  anyReleaseLoads,
  checkReleaseVersion,
  installRelease,
  latestStable,
  planRelease,
} from "../release/install.ts";
import type { Invocation } from "../table.ts";
import type { InspectedFile } from "./owned.ts";
import { isInstalled, runChecks, type CheckResult, type Override } from "./checks.ts";
import {
  DEFAULT_BACKUP_DIR,
  defaultHostConfig,
  markUnsupported,
  readHostConfig,
  writeHostConfig,
} from "./config.ts";
import {
  hostOwnedFiles,
  inspectOwnedFiles,
  isNginxFile,
  pending,
  resolveDrift,
  restoreNginxFiles,
  writeOwnedFiles,
} from "./owned.ts";

const PACKAGES = ["nginx", "openssl"];

interface Dir {
  path: string;
  mode: number;
}

/** `host setup` (spec 10.2), up to the Host tree: refusals, plan, apt, `dcabsm.json` and `/srv/dcabsm`. */
export async function hostSetup({ ctx, args }: Invocation): Promise<void> {
  const flags = parseFlags(args, {
    yes: { type: "boolean" },
    "backup-dir": { type: "string" },
    release: { type: "string" },
  });
  const requested = flags["backup-dir"];
  if (requested !== undefined && !isAbsolute(requested)) {
    throw refusal(
      `--backup-dir must be an absolute path, not ${requested}.`,
      "Example: --backup-dir /mnt/backups/dcabsm",
    );
  }
  if (flags.release !== undefined) checkReleaseVersion(flags.release);
  const stored = await readHostConfig(ctx);

  ctx.io.out("Setup checks (nothing changes yet)");
  const results = await runChecks(ctx);
  const overrides: Override[] = [];
  const blocked: Array<Extract<CheckResult, { kind: "refuse" }>> = [];
  for (const result of results) {
    if (result.kind === "pass") {
      step(ctx, "done", result.label);
    } else if (result.override && ctx.env[result.override] === "1") {
      overrides.push(result.override);
      step(
        ctx,
        "warn",
        `UNSUPPORTED: ${result.message} ${result.override}=1 lets setup go on. You are on your own.`,
      );
    } else {
      blocked.push(result);
    }
  }
  if (
    stored?.backupDir !== undefined &&
    requested !== undefined &&
    requested !== stored.backupDir
  ) {
    blocked.push({
      kind: "refuse",
      message: `Backups are already in ${stored.backupDir}, not ${requested}.`,
      hint: "Moving Backups is a Manual System Admin task. Run again without --backup-dir: sudo dcabsm host setup",
    });
  }
  const [first, ...others] = blocked;
  if (first) {
    for (const result of others) step(ctx, "failed", result.message);
    throw refusal(first.message, first.hint);
  }
  for (const override of overrides)
    await logChange(ctx, "host setup", `override ${override}=1 used`);

  const backupDir = stored?.backupDir ?? requested ?? DEFAULT_BACKUP_DIR;
  const missingPackages: string[] = [];
  for (const pkg of PACKAGES) if (!(await isInstalled(ctx, pkg))) missingPackages.push(pkg);
  const dirs: Dir[] = [
    { path: ctx.paths.etc, mode: 0o700 },
    { path: ctx.paths.srv, mode: 0o755 },
    { path: ctx.paths.node, mode: 0o755 },
    { path: ctx.paths.releases, mode: 0o755 },
    { path: ctx.paths.instances, mode: 0o755 },
    { path: ctx.paths.acme, mode: 0o755 },
    { path: ctx.paths.under(backupDir), mode: 0o700 },
  ];
  const missingDirs: Dir[] = [];
  for (const dir of dirs) if (!(await exists(dir.path))) missingDirs.push(dir);
  const newOverrides = overrides.filter((o) => !stored?.unsupportedHost?.overrides.includes(o));
  const needConfig = stored === undefined || newOverrides.length > 0;
  const nightlyTime = stored?.nightlyTime ?? defaultHostConfig(backupDir).nightlyTime;
  const inspected = await inspectOwnedFiles(
    ctx,
    await hostOwnedFiles(ctx, nightlyTime),
    stored?.ownedFiles ?? {},
  );
  const ownedWork = pending(inspected);

  // Step 8 passes once any Release loads, so a re-run never pulls a newer one (spec 10.2).
  const releasePlan = (await anyReleaseLoads(ctx))
    ? undefined
    : await planRelease(ctx, flags.release ?? (await latestStable(ctx)));

  if (
    missingPackages.length === 0 &&
    missingDirs.length === 0 &&
    !needConfig &&
    ownedWork.length === 0 &&
    !releasePlan
  ) {
    // Nothing else to do, but Nginx must still be up and enabled (spec 10.2 step 7).
    if (await keepNginxUp(ctx, flags.yes)) return;
    ctx.io.out("");
    ctx.io.out("Every check passes; nothing to do.");
    return;
  }

  // Edited files are decided before anything changes (spec 10.5).
  const replace = await resolveDrift(ctx, inspected, flags);

  ctx.io.out("");
  ctx.io.out("Plan");
  if (missingPackages.length > 0)
    step(ctx, "info", `Install ${missingPackages.join(" and ")} with apt`);
  if (missingDirs.length > 0) step(ctx, "info", "Create /etc/dcabsm and /srv/dcabsm");
  step(ctx, "info", `Backups in ${backupDir}`);
  if (ownedWork.length > 0)
    step(
      ctx,
      "info",
      `Write dcabsm@.service, dcabsm-nightly.timer (${nightlyTime}), Nginx conf.d files`,
    );
  if (releasePlan)
    step(ctx, "info", `Install Release ${releasePlan.version} with its Node runtime`);
  await confirmOrCancel(ctx, "Go ahead?", { yes: flags.yes });

  if (missingPackages.length > 0) {
    const res = await ctx.runner.run("env", [
      "DEBIAN_FRONTEND=noninteractive",
      "apt-get",
      "install",
      "-y",
      ...missingPackages,
    ]);
    if (res.code !== 0) {
      throw new CliError(
        `apt could not install ${missingPackages.join(" and ")}: ${firstLine(res.stderr, `apt-get exited ${res.code}`)}`,
        "Fix the problem, then run again: sudo dcabsm host setup",
      );
    }
    step(ctx, "done", `apt: ${missingPackages.join(", ")}`);
  }

  for (const dir of missingDirs) await ensureDir(dir.path, dir.mode);
  if (missingDirs.length > 0) step(ctx, "done", "Created /etc/dcabsm and /srv/dcabsm");

  if (needConfig) {
    const today = ctx.now().toISOString().slice(0, 10);
    const base = stored ?? defaultHostConfig(backupDir);
    await writeHostConfig(ctx, markUnsupported(base, newOverrides, today));
    step(ctx, "done", `${stored ? "Updated" : "Created"} /etc/dcabsm/dcabsm.json`);
  }

  if (ownedWork.length > 0 || missingPackages.length > 0) {
    await installOwnedFiles(ctx, inspected, replace, {
      hashes: stored?.ownedFiles ?? {},
      nginxWasInstalled: !missingPackages.includes("nginx"),
      yes: flags.yes,
    });
  }
  if (releasePlan) await installRelease(ctx, releasePlan);
}

async function systemctl(ctx: Context, ...args: string[]): Promise<void> {
  const res = await ctx.runner.run("systemctl", args);
  if (res.code !== 0) {
    throw new CliError(
      `systemctl ${args.join(" ")} failed: ${firstLine(res.stderr, `exit ${res.code}`)}`,
      "Fix the problem, then run again: sudo dcabsm host setup",
    );
  }
}

const nginxIsActive = async (ctx: Context): Promise<boolean> =>
  (await ctx.runner.run("systemctl", ["is-active", "--quiet", "nginx"])).code === 0;

/** Whether Nginx is both running and enabled at boot. */
async function nginxUp(ctx: Context): Promise<boolean> {
  return (
    (await nginxIsActive(ctx)) &&
    (await ctx.runner.run("systemctl", ["is-enabled", "--quiet", "nginx"])).code === 0
  );
}

/** The reason `nginx -t` fails, or undefined when it passes. */
async function nginxTestFailure(ctx: Context): Promise<string | undefined> {
  const test = await ctx.runner.run("nginx", ["-t"]);
  return test.code === 0 ? undefined : firstLine(test.stderr, "no reason given");
}

/** Starts and enables a stopped Nginx, asking first if it was installed before setup ran. */
async function startNginx(
  ctx: Context,
  opts: { wasInstalled: boolean; yes?: boolean },
): Promise<void> {
  if (opts.wasInstalled) {
    const start = await confirm(ctx, "Nginx is installed but stopped. Start and enable it?", {
      yes: opts.yes,
      defaultYes: true,
    });
    if (!start) throw new Cancelled("Nginx left stopped. Run setup again to start it.");
  }
  await systemctl(ctx, "enable", "--now", "nginx");
  step(ctx, "done", "Nginx: nginx -t passed, started, enabled");
}

/** Spec 10.2 step 7 on a re-run with nothing else to do: Nginx must still be up and enabled. */
async function keepNginxUp(ctx: Context, yes?: boolean): Promise<boolean> {
  if (await nginxUp(ctx)) return false;
  const reason = await nginxTestFailure(ctx);
  if (reason !== undefined) {
    throw new CliError(
      `nginx -t failed: ${reason}`,
      "Nginx was not started. Fix the config, then run again: sudo dcabsm host setup",
    );
  }
  await startNginx(ctx, { wasInstalled: true, yes });
  return true;
}

/** Step 7 of spec 10.2: units, `conf.d` files, `nginx -t`, Nginx up and enabled, timer enabled. */
async function installOwnedFiles(
  ctx: Context,
  inspected: InspectedFile[],
  replace: Set<string>,
  opts: { hashes: Record<string, string>; nginxWasInstalled: boolean; yes?: boolean },
): Promise<void> {
  const result = await writeOwnedFiles(ctx, inspected, replace, opts.hashes);
  const config = (await readHostConfig(ctx)) ?? {};
  const nginxWritten = result.written.filter((p) =>
    isNginxFile(inspected.find((i) => i.file.path === p)!.file),
  );

  // Nginx files count only once `nginx -t` passes; until then no hash is recorded (spec 10.5).
  const reason = await nginxTestFailure(ctx);
  if (reason !== undefined) {
    const hashes = await restoreNginxFiles(
      ctx,
      inspected,
      nginxWritten,
      opts.hashes,
      result.hashes,
    );
    await writeHostConfig(ctx, { ...config, ownedFiles: hashes });
    throw new CliError(
      `nginx -t failed after the change: ${reason}`,
      nginxWritten.length > 0
        ? "The previous Nginx files were put back and Nginx was not reloaded. Fix the problem, then run again: sudo dcabsm host setup"
        : "Nginx was not reloaded. Fix the config, then run again: sudo dcabsm host setup",
    );
  }
  await writeHostConfig(ctx, { ...config, ownedFiles: result.hashes });
  if (result.written.length > 0) {
    step(ctx, "done", `Wrote ${result.written.map((p) => p.split("/").pop()).join(", ")}`);
  }

  await systemctl(ctx, "daemon-reload");
  await systemctl(ctx, "enable", "dcabsm-nightly.timer");
  await systemctl(ctx, "start", "dcabsm-nightly.timer");
  step(ctx, "done", "dcabsm-nightly.timer enabled");

  const nginxChanged = nginxWritten.length > 0;
  if (await nginxIsActive(ctx)) {
    if (nginxChanged) await systemctl(ctx, "reload", "nginx");
    step(ctx, "done", `Nginx: nginx -t passed${nginxChanged ? ", reloaded" : ""}`);
    await systemctl(ctx, "enable", "nginx");
    return;
  }
  await startNginx(ctx, { wasInstalled: opts.nginxWasInstalled, yes: opts.yes });
}
