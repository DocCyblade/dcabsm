import { isAbsolute } from "node:path";
import { parseFlags } from "../args.ts";
import { CliError, refusal } from "../errors.ts";
import { ensureDir, exists } from "../fsutil.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirmOrCancel } from "../prompt.ts";
import type { Invocation } from "../table.ts";
import { isInstalled, runChecks, type CheckResult, type Override } from "./checks.ts";
import {
  DEFAULT_BACKUP_DIR,
  defaultHostConfig,
  markUnsupported,
  readHostConfig,
  writeHostConfig,
} from "./config.ts";

const PACKAGES = ["nginx", "openssl"];

interface Dir {
  path: string;
  mode: number;
}

/** `host setup` (spec 10.2), up to the Host tree: refusals, plan, apt, `dcabsm.json` and `/srv/dcabsm`. */
export async function hostSetup({ ctx, args }: Invocation): Promise<void> {
  const flags = parseFlags(args, { yes: { type: "boolean" }, "backup-dir": { type: "string" } });
  const requested = flags["backup-dir"];
  if (requested !== undefined && !isAbsolute(requested)) {
    throw refusal(
      `--backup-dir must be an absolute path, not ${requested}.`,
      "Example: --backup-dir /mnt/backups/dcabsm",
    );
  }
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

  if (missingPackages.length === 0 && missingDirs.length === 0 && !needConfig) {
    ctx.io.out("");
    ctx.io.out("Every check passes; nothing to do.");
    return;
  }

  ctx.io.out("");
  ctx.io.out("Plan");
  if (missingPackages.length > 0)
    step(ctx, "info", `Install ${missingPackages.join(" and ")} with apt`);
  if (missingDirs.length > 0) step(ctx, "info", "Create /etc/dcabsm and /srv/dcabsm");
  step(ctx, "info", `Backups in ${backupDir}`);
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
      const reason =
        res.stderr.split("\n").find((l) => l.trim() !== "") ?? `apt-get exited ${res.code}`;
      throw new CliError(
        `apt could not install ${missingPackages.join(" and ")}: ${reason.trim()}`,
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
}
