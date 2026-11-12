import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseCommand } from "../args.ts";
import { backupPath, readManifest, requireArchiveFile } from "../backup/archive.ts";
import { checkSpace, takeBackup } from "../backup/create.ts";
import { validateCertificate, validateCertificateFiles } from "../cert.ts";
import { askForCertificate, hostnameInUse, type CertSource } from "../certs/provide.ts";
import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { confirmOrCancel } from "../prompt.ts";
import { installRelease } from "../release/install.ts";
import type { Invocation } from "../table.ts";
import { checkHostname, freePort, startAndVerify } from "./create.ts";
import { buildInstance, extractArchive } from "./from-archive.ts";
import { checkName, instanceDir, refuseIfChanging, requireInstance } from "./record.ts";
import { planIfMissing } from "./upgrade-plan.ts";

const USAGE =
  "Usage: dcabsm instance clone <source> <new> --hostname <host> [--cert <f> --key <f> | --self-signed] [--yes]\n  or: dcabsm instance clone --from <archive> <new> --hostname <host> [cert options]";

interface CloneRequest {
  /** The source Instance, or undefined when cloning `--from` an archive. */
  source: string | undefined;
  archive: string | undefined;
  name: string;
  hostname: string;
  cert: { cert: string; key: string } | "self-signed" | undefined;
  yes: boolean;
}

function parseClone(args: string[]): CloneRequest {
  const { values, positionals } = parseCommand(args, {
    from: { type: "string" },
    hostname: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    "self-signed": { type: "boolean" },
    yes: { type: "boolean" },
  });
  const fromArchive = values.from !== undefined;
  if (positionals.length !== (fromArchive ? 1 : 2)) {
    throw refusal(
      fromArchive
        ? "Give the name of the new Instance."
        : "Give the source Instance and the name of the new one.",
      USAGE,
    );
  }
  const [source, name] = fromArchive
    ? [undefined, positionals[0]!]
    : [positionals[0]!, positionals[1]!];
  if (source !== undefined) checkName(source);
  checkName(name);
  if (source === name) throw refusal("The new Instance needs a name of its own.", USAGE);
  if (values.hostname === undefined) throw refusal("--hostname is required.", USAGE);
  checkHostname(values.hostname);

  const given = values.cert !== undefined || values.key !== undefined;
  if (given && values["self-signed"]) throw refusal("Use --self-signed or --cert/--key, not both.");
  if (given && (values.cert === undefined || values.key === undefined)) {
    throw refusal("--cert and --key go together.", "Give both: --cert <file> --key <file>");
  }
  return {
    source,
    archive: values.from,
    name,
    hostname: values.hostname,
    cert: given
      ? { cert: values.cert!, key: values.key! }
      : values["self-signed"]
        ? "self-signed"
        : undefined,
    yes: values.yes === true,
  };
}

/**
 * The certificate of the clone (spec 7.8): the one asked for, else the source's if it is valid and
 * covers the new hostname, else a prompt on a terminal, else a refusal that names the options.
 */
async function chooseCertificate(
  ctx: Context,
  req: CloneRequest,
  from: { label: string; certPem: string; keyPem: string },
): Promise<{ source: CertSource; reused: boolean }> {
  if (req.cert === "self-signed") return { source: { kind: "self-signed" }, reused: false };
  if (req.cert) {
    const info = await validateCertificateFiles(ctx, { ...req.cert, hostname: req.hostname });
    return { source: { kind: "given", info }, reused: false };
  }
  try {
    const info = validateCertificate(ctx, {
      certPem: from.certPem,
      keyPem: from.keyPem,
      hostname: req.hostname,
    });
    return { source: { kind: "given", info }, reused: true };
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    ctx.io.out(
      `The certificate of ${from.label} cannot be reused for ${req.hostname}: ${err.message}`,
    );
    return { source: await askForCertificate(ctx, req.hostname), reused: false };
  }
}

/** `instance clone <source> <new> ...` and `instance clone --from <archive> <new> ...` (spec 7.8). */
export async function instanceClone({ ctx, args }: Invocation): Promise<void> {
  const req = parseClone(args);
  const { name, hostname } = req;
  if (await exists(instanceDir(ctx, name))) {
    throw refusal(
      `An Instance named ${name} already exists.`,
      "See the list: dcabsm instance list",
    );
  }
  const inUse = await hostnameInUse(ctx, hostname);
  if (inUse) throw refusal(inUse);

  let archive: string;
  let label: string;
  let chosen: { source: CertSource; reused: boolean } | undefined;
  if (req.source !== undefined) {
    const source = req.source;
    await requireInstance(ctx, source);
    await refuseIfChanging(ctx, source);
    label = source;
    ctx.io.out(`Clone ${source} → ${name}`);
    ctx.io.out(`  · ${source} stops for a few seconds while it is backed up.`);
    // Everything that can refuse comes before the source stops.
    const dir = instanceDir(ctx, source);
    chosen = await chooseCertificate(ctx, req, {
      label: source,
      certPem: await readFile(join(dir, "nginx", "cert.pem"), "utf8"),
      keyPem: await readFile(join(dir, "nginx", "key.pem"), "utf8"),
    });
    await checkSpace(ctx, source);
    await confirmOrCancel(ctx, "Continue?", { yes: req.yes });
    archive = await backupPath(ctx, source, await takeBackup(ctx, source, "pre-clone"));
  } else {
    archive = req.archive!;
    await requireArchiveFile(archive);
    label = basename(archive);
    ctx.io.out(`Clone from ${label} → ${name}`);
  }

  const manifest = await readManifest(ctx, archive);
  const stage = await extractArchive(ctx, archive, name);
  try {
    chosen ??= await chooseCertificate(ctx, req, {
      label: `the archive of ${manifest.name}`,
      certPem: stage.certPem,
      keyPem: stage.keyPem,
    });
    const plan = await planIfMissing(ctx, manifest.release);
    if (plan) await installRelease(ctx, plan);
    const record = { ...stage.record, port: await freePort(ctx), hostname };
    await buildInstance(ctx, {
      name,
      stage,
      record,
      release: manifest.release,
      cert: chosen.source,
      reportCert: chosen.reused
        ? () =>
            step(
              ctx,
              "done",
              `Certificate: copied from ${req.source ?? "the archive"} (it covers ${hostname})`,
            )
        : undefined,
    });
    await startAndVerify(ctx, name, record, manifest.release);
  } catch (err) {
    await logChange(ctx, "instance clone", `${name} from ${label}: failed`);
    throw err;
  } finally {
    await stage.cleanup();
  }
  await logChange(ctx, "instance clone", `${name} from ${label}: cloned`);

  const was = req.source ?? manifest.name;
  ctx.io.out("");
  step(
    ctx,
    "warn",
    `Logins are copied: everyone who can log in to ${was} can log in to ${name}, with the same passwords.`,
  );
  step(
    ctx,
    "info",
    `Everything inside Actual was copied, including users and OpenID settings. If ${was} uses OpenID, its settings name ${stage.record.hostname}: update them in ${name} and add https://${hostname}/openid/callback as a redirect URL at the provider.`,
  );
  step(
    ctx,
    "info",
    `Open https://${hostname} to check ${name}. Point DNS for ${hostname} at this Host.`,
  );
}
