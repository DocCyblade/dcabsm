import { parseCommand } from "../args.ts";
import { inspectChain, validateCertificate } from "../cert.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { readOrRefuse, writeFileAtomic } from "../fsutil.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { refuseIfChanging } from "../instance/record.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { certTargets, confirmServed, SERVE_SECONDS, type CertTarget } from "./probe.ts";

const USAGE = "cert update <names>|--all --cert <f> [--key <f>]";

interface Swap {
  target: CertTarget;
  newCert: string;
  newKey: string;
  oldCert: string;
  oldKey: string;
  /** The new leaf's fingerprint, to confirm what is served. */
  fingerprint: string;
}

/** Spec 5.6 step 1 and 2: every Instance is checked before anything changes. */
async function validateAll(
  ctx: Context,
  targets: CertTarget[],
  certPem: string,
  keyPem: string | undefined,
): Promise<Swap[]> {
  const swaps: Swap[] = [];
  for (const target of targets) {
    const { name, record } = target;
    await refuseIfChanging(ctx, name);
    const oldCert = await readOrRefuse(target.certPath, "current certificate");
    const oldKey = await readOrRefuse(target.keyPath, "current key");
    try {
      const info = validateCertificate(ctx, {
        certPem,
        keyPem: keyPem ?? oldKey,
        hostname: record.hostname,
      });
      step(
        ctx,
        "done",
        `${name}: valid, covers ${record.hostname}, matches ${keyPem ? "the new" : "the current"} key`,
      );
      for (const w of info.warnings) step(ctx, "warn", `${name}: ${w}`);
      swaps.push({
        target,
        newCert: info.certPem,
        newKey: info.keyPem,
        oldCert,
        oldKey,
        fingerprint: inspectChain(ctx, info.certPem, record.hostname).fingerprint,
      });
    } catch (err) {
      if (err instanceof CliError)
        throw new CliError(`${name}: ${err.message}`, err.hint, err.code);
      throw err;
    }
  }
  return swaps;
}

async function restore(ctx: Context, swaps: Swap[], reloaded: boolean): Promise<void> {
  for (const s of swaps) {
    await writeFileAtomic(s.target.certPath, s.oldCert, 0o600);
    await writeFileAtomic(s.target.keyPath, s.oldKey, 0o600);
  }
  if (reloaded) await systemctl(ctx, "reload", "nginx");
}

/** `cert update <names>|--all --cert <f> [--key <f>]` (spec 5.6) */
export async function certUpdate({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    all: { type: "boolean" },
    cert: { type: "string" },
    key: { type: "string" },
  });
  if (values.cert === undefined) {
    throw refusal("--cert is required.", `Usage: dcabsm ${USAGE}`);
  }
  const targets = await certTargets(ctx, USAGE, positionals, values.all, false);
  ctx.io.out(`Update certificate for ${targets.map((t) => t.name).join(", ")}`);

  const certPem = await readOrRefuse(values.cert, "certificate");
  const keyPem = values.key === undefined ? undefined : await readOrRefuse(values.key, "key");
  const swaps = await validateAll(ctx, targets, certPem, keyPem);

  let reloaded = false;
  try {
    for (const s of swaps) {
      await writeFileAtomic(s.target.certPath, s.newCert, 0o600);
      await writeFileAtomic(s.target.keyPath, s.newKey, 0o600);
    }
    const failure = await nginxTestFailure(ctx);
    if (failure) throw new CliError(`nginx -t failed: ${failure}`);
    await systemctl(ctx, "reload", "nginx");
    reloaded = true;
    step(ctx, "done", "Swapped files, nginx -t passed, reloaded");
    for (const s of swaps) {
      const seconds = await confirmServed(ctx, s.target.record.hostname, s.fingerprint);
      if (seconds === undefined) {
        throw new CliError(
          `${s.target.name}: Nginx is not serving the new certificate within ${SERVE_SECONDS} seconds.`,
        );
      }
      step(
        ctx,
        "done",
        `${s.target.name}: now serving the new certificate (confirmed in ${seconds}s)`,
      );
    }
  } catch (err) {
    try {
      await restore(ctx, swaps, reloaded);
    } catch (again) {
      throw new CliError(
        `${errorMessage(err)} Restoring the old files also failed: ${errorMessage(again)}`,
        "Check the files in each Instance's nginx/ directory, then run: sudo dcabsm host doctor",
      );
    }
    step(ctx, "failed", "The old certificate files were put back.");
    throw err;
  }
  step(ctx, "info", "Actual was not restarted.");
}
