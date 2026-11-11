import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { CertificateInfo } from "../cert.ts";
import type { Context } from "../context.ts";
import { Cancelled, CliError, firstLine, refusal } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { runChecked } from "../host/system.ts";
import { instanceDir, instanceNames, readRecord } from "../instance/record.ts";
import { step } from "../output.ts";

const SELF_SIGNED_DAYS = 397;

/** Hostnames in every `server_name` that Nginx loads. */
async function nginxHostnames(ctx: Context): Promise<Set<string>> {
  const res = await ctx.runner.run("nginx", ["-T"]);
  if (res.code !== 0) {
    throw new CliError(
      `nginx -T failed: ${firstLine(res.stderr, `exit ${res.code}`)}`,
      "Fix the Nginx configuration first, then run again.",
    );
  }
  const names = new Set<string>();
  for (const m of res.stdout.matchAll(/^\s*server_name\s+([^;]+);/gm)) {
    for (const n of m[1]!.trim().split(/\s+/)) names.add(n.toLowerCase());
  }
  return names;
}

/** Another Instance or Nginx already uses the hostname: why, or undefined (spec 4.6). */
export async function hostnameInUse(ctx: Context, hostname: string): Promise<string | undefined> {
  for (const name of await instanceNames(ctx)) {
    if ((await readRecord(ctx, name))?.hostname === hostname) {
      return `Instance ${name} already uses ${hostname}.`;
    }
  }
  if ((await nginxHostnames(ctx)).has(hostname)) {
    return `Nginx already serves ${hostname}. Nginx only warns about duplicate names, so DCABSM refuses.`;
  }
  return undefined;
}

/** Where an Instance's certificate comes from. */
export type CertSource = { kind: "self-signed" } | { kind: "given"; info: CertificateInfo };

/** With no certificate given: asks on a terminal for a self-signed one, or refuses (spec 4.6 step 3). */
export async function askForCertificate(ctx: Context, hostname: string): Promise<CertSource> {
  if (!ctx.io.interactive) {
    throw refusal(
      "No terminal to ask for a certificate on.",
      "Re-run with --cert <f> --key <f>, or --self-signed.",
    );
  }
  ctx.io.out(`No certificate given for ${hostname}. Every Instance must have one.`);
  const answer = (
    await ctx.io.ask("  [1] self-signed now  [2] cancel (re-run with --cert/--key): ")
  ).trim();
  if (answer !== "1") throw new Cancelled();
  return { kind: "self-signed" };
}

/** Puts `cert.pem` and `key.pem` in the Instance's `nginx/`, root-only (spec 5.5). */
export async function writeCertificate(
  ctx: Context,
  name: string,
  hostname: string,
  source: CertSource,
): Promise<void> {
  const nginx = join(instanceDir(ctx, name), "nginx");
  if (source.kind === "given") {
    await writeFileAtomic(join(nginx, "cert.pem"), source.info.certPem, 0o600);
    await writeFileAtomic(join(nginx, "key.pem"), source.info.keyPem, 0o600);
    return;
  }
  await runChecked(ctx, "openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-days",
    String(SELF_SIGNED_DAYS),
    "-subj",
    `/CN=${hostname}`,
    "-addext",
    `subjectAltName=DNS:${hostname}`,
    "-keyout",
    join(nginx, "key.pem"),
    "-out",
    join(nginx, "cert.pem"),
  ]);
  for (const file of ["key.pem", "cert.pem"]) await chmod(join(nginx, file), 0o600);
}

export function reportCertificate(ctx: Context, hostname: string, source: CertSource): void {
  if (source.kind === "given") {
    step(ctx, "done", `Certificate for ${hostname}, ${source.info.daysLeft} days left`);
    for (const warning of source.info.warnings) step(ctx, "warn", warning);
    return;
  }
  step(ctx, "done", `Certificate for ${hostname}, ${SELF_SIGNED_DAYS} days left (self-signed)`);
  ctx.io.out(
    "  Self-signed: browsers warn on each device, and may warn again later. Actual works after you proceed,",
  );
  ctx.io.out(
    "  but offline use and installing as an app need a certificate the device trusts. Bring one later: sudo dcabsm cert update <name> --cert <file> --key <file>",
  );
}
