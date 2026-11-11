import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../args.ts";
import { inspectChain, validateCertificate, type CertificateInfo } from "../cert.ts";
import { confirmServed, SERVE_SECONDS } from "../certs/probe.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, refusal } from "../errors.ts";
import { readOrRefuse, writeFileAtomic } from "../fsutil.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import {
  askForCertificate,
  checkHostname,
  hostnameInUse,
  reportCertificate,
  writeCertificate,
} from "./create.ts";
import { vhostPath, writeVhost } from "./files.ts";
import {
  instanceDir,
  recordPath,
  refuseIfChanging,
  requireInstance,
  writeRecord,
  type InstanceRecord,
} from "./record.ts";

const USAGE =
  "Usage: dcabsm instance set-hostname <name> <host> [--cert <f> [--key <f>] | --self-signed]";

/** The files a hostname change can touch, as they were, so a failure puts them back. */
interface Saved {
  record: string;
  vhost: string;
  cert: string;
  key: string;
}

/** Where the new hostname's certificate comes from. */
type Choice =
  | { kind: "current" }
  | { kind: "given"; info: CertificateInfo }
  | { kind: "self-signed" };

/**
 * Spec 4.9: the current certificate if it covers the new name, else the one given, else a
 * self-signed one (asked for on a terminal).
 */
async function chooseCertificate(
  ctx: Context,
  hostname: string,
  saved: Saved,
  given: { cert?: string; key?: string; selfSigned?: boolean },
): Promise<Choice> {
  if (given.selfSigned) return { kind: "self-signed" };
  if (given.cert !== undefined) {
    const certPem = await readOrRefuse(given.cert, "certificate");
    const keyPem = given.key === undefined ? saved.key : await readOrRefuse(given.key, "key");
    return { kind: "given", info: validateCertificate(ctx, { certPem, keyPem, hostname }) };
  }
  try {
    validateCertificate(ctx, { certPem: saved.cert, keyPem: saved.key, hostname });
    return { kind: "current" };
  } catch {
    // Not covered (or no longer valid): the same prompt as create.
    return askForCertificate(ctx, hostname);
  }
}

/** `instance set-hostname <name> <host> [--cert <f> [--key <f>] | --self-signed]` (spec 4.9) */
export async function instanceSetHostname({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    cert: { type: "string" },
    key: { type: "string" },
    "self-signed": { type: "boolean" },
  });
  if (positionals.length !== 2) {
    throw refusal("Give an Instance name and the new hostname.", USAGE);
  }
  const [name, hostname] = positionals as [string, string];
  if (values.key !== undefined && values.cert === undefined) {
    throw refusal("--key goes with --cert.", USAGE);
  }
  if (values["self-signed"] && values.cert !== undefined) {
    throw refusal("Use --self-signed or --cert/--key, not both.");
  }

  const before = await requireInstance(ctx, name);
  await refuseIfChanging(ctx, name);
  checkHostname(hostname);
  if (before.hostname === hostname) {
    step(ctx, "info", `${name} already uses ${hostname}. Nothing changed.`);
    return;
  }
  const inUse = await hostnameInUse(ctx, hostname);
  if (inUse) throw refusal(inUse);

  const dir = instanceDir(ctx, name);
  const path = {
    record: recordPath(ctx, name),
    vhost: vhostPath(ctx, name),
    cert: join(dir, "nginx", "cert.pem"),
    key: join(dir, "nginx", "key.pem"),
  };
  const saved: Saved = {
    record: await readOrRefuse(path.record, "Instance record"),
    vhost: await readOrRefuse(path.vhost, "vhost"),
    cert: await readOrRefuse(path.cert, "current certificate"),
    key: await readOrRefuse(path.key, "current key"),
  };
  const choice = await chooseCertificate(ctx, hostname, saved, {
    cert: values.cert,
    key: values.key,
    selfSigned: values["self-signed"],
  });

  ctx.io.out(`Move ${name} to ${hostname}`);
  const after: InstanceRecord = { ...before, hostname };
  let reloaded = false;
  try {
    if (choice.kind === "given") {
      await writeFileAtomic(path.cert, choice.info.certPem, 0o600);
      await writeFileAtomic(path.key, choice.info.keyPem, 0o600);
    } else if (choice.kind === "self-signed") {
      await writeCertificate(ctx, name, hostname, { kind: "self-signed" });
    }
    await writeRecord(ctx, name, after);
    await writeVhost(ctx, name, after);
    if (choice.kind === "current") {
      step(ctx, "done", `Certificate covers ${hostname}`);
    } else {
      reportCertificate(ctx, hostname, choice.kind === "given" ? choice : { kind: "self-signed" });
    }

    const failure = await nginxTestFailure(ctx);
    if (failure) throw new CliError(`nginx -t failed: ${failure}`);
    await systemctl(ctx, "reload", "nginx");
    reloaded = true;
    step(ctx, "done", "Nginx: nginx -t passed, reloaded");

    const fingerprint = inspectChain(ctx, await readFile(path.cert, "utf8"), hostname).fingerprint;
    if ((await confirmServed(ctx, hostname, fingerprint)) === undefined) {
      throw new CliError(
        `Nginx is not serving the certificate for ${hostname} within ${SERVE_SECONDS} seconds.`,
      );
    }
    step(ctx, "done", `Served certificate for ${hostname} confirmed`);
  } catch (err) {
    try {
      await writeFileAtomic(path.cert, saved.cert, 0o600);
      await writeFileAtomic(path.key, saved.key, 0o600);
      await writeFileAtomic(path.record, saved.record, 0o600);
      await writeFileAtomic(path.vhost, saved.vhost, 0o600);
      if (reloaded) await systemctl(ctx, "reload", "nginx");
    } catch (again) {
      throw new CliError(
        `${errorMessage(err)} Restoring the old files also failed: ${errorMessage(again)}`,
        "Check the files in the Instance's config/ and nginx/ directories, then run: sudo dcabsm host doctor",
      );
    }
    step(ctx, "failed", "The old hostname and certificate files were put back.");
    throw err;
  }
  step(ctx, "info", "Actual was not restarted.");
  step(
    ctx,
    "info",
    `Devices must use https://${hostname} now. Budgets on the old hostname stay in those browsers until removed.`,
  );
  step(
    ctx,
    "warn",
    "OpenID login fails on the new name until Actual's OpenID settings and the provider's redirect URL are updated. Password login keeps working.",
  );
}
