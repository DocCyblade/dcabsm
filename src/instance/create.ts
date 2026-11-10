import { chmod, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { Cancelled, CliError, errorMessage, firstLine, refusal } from "../errors.ts";
import { ensureDir, exists, writeFileAtomic } from "../fsutil.ts";
import { hostHasIpv6 } from "../host/owned.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import {
  installedReleases,
  installRelease,
  latestStable,
  planRelease,
} from "../release/install.ts";
import { validateCertificateFiles, type CertificateInfo } from "../cert.ts";
import { configJson, vhostConf } from "./files.ts";
import {
  accountOf,
  checkName,
  FIRST_PORT,
  instanceDir,
  instanceNames,
  readRecord,
  type InstanceRecord,
} from "./record.ts";
import { verifyInstance } from "./verify.ts";
import type { Invocation } from "../table.ts";

const SELF_SIGNED_DAYS = 397;

/** A lowercase DNS name: dot-separated labels, no wildcard, no trailing dot, not an IP address. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function checkHostname(hostname: string): void {
  const labels = hostname.split(".");
  const valid =
    hostname.length > 0 &&
    hostname.length <= 253 &&
    labels.every((l) => LABEL.test(l)) &&
    !/^\d+$/.test(labels[labels.length - 1]!);
  if (!valid) {
    throw refusal(
      `${JSON.stringify(hostname)} is not a valid hostname.`,
      "Use a lowercase DNS name, with no wildcard and no trailing dot, such as shop.example.org.",
    );
  }
}

async function run(ctx: Context, command: string, args: string[]) {
  const res = await ctx.runner.run(command, args);
  if (res.code !== 0) {
    throw new CliError(
      `${[command, ...args.slice(0, 1)].join(" ")} failed: ${firstLine(res.stderr, `exit ${res.code}`)}`,
    );
  }
  return res;
}

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

async function hostnameInUse(ctx: Context, hostname: string): Promise<string | undefined> {
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

/** The first port from 15127 that is in no Instance record and not listening (spec 4.3). */
async function freePort(ctx: Context): Promise<number> {
  const taken = new Set<number>();
  for (const name of await instanceNames(ctx)) {
    const record = await readRecord(ctx, name);
    if (record) taken.add(record.port);
  }
  const ss = await ctx.runner.run("ss", ["-H", "-ltn"]);
  for (const line of ss.stdout.split("\n")) {
    const port = Number(/:(\d+)$/.exec(line.trim().split(/\s+/)[3] ?? "")?.[1]);
    if (port) taken.add(port);
  }
  let port = FIRST_PORT;
  while (taken.has(port)) port++;
  return port;
}

/** Where an Instance's certificate comes from. */
type CertSource = { kind: "self-signed" } | { kind: "given"; info: CertificateInfo };

/** The certificate files named on the command line. */
interface CertFiles {
  cert: string;
  key: string;
}

interface CreateRequest {
  name: string;
  hostname: string;
  release: string | undefined;
  /** What was asked for; `undefined` means ask (spec 4.6 step 3). */
  cert: CertFiles | "self-signed" | undefined;
}

function parseCreate(args: string[]): CreateRequest {
  const { values, positionals } = parseCommand(args, {
    hostname: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    "self-signed": { type: "boolean" },
    release: { type: "string" },
  });
  const usage = "Usage: dcabsm instance create <name> --hostname <host> --self-signed";
  if (positionals.length !== 1) throw refusal("Give one Instance name.", usage);
  const name = positionals[0]!;
  checkName(name);
  if (values.hostname === undefined) throw refusal("--hostname is required.", usage);
  checkHostname(values.hostname);

  const given = values.cert !== undefined || values.key !== undefined;
  if (given && values["self-signed"]) throw refusal("Use --self-signed or --cert/--key, not both.");
  if (given && (values.cert === undefined || values.key === undefined)) {
    throw refusal("--cert and --key go together.", "Give both: --cert <file> --key <file>");
  }
  const cert: CreateRequest["cert"] = given
    ? { cert: values.cert!, key: values.key! }
    : values["self-signed"]
      ? "self-signed"
      : undefined;
  return { name, hostname: values.hostname, release: values.release, cert };
}

/** Refuses an existing name or a hostname already in use, before anything changes. */
async function checkFree(ctx: Context, name: string, hostname: string): Promise<void> {
  if (await exists(instanceDir(ctx, name))) {
    throw refusal(
      `An Instance named ${name} already exists.`,
      "See the list: dcabsm instance list",
    );
  }
  const inUse = await hostnameInUse(ctx, hostname);
  if (inUse) throw refusal(inUse);
}

/** Validates a given certificate, or asks on a terminal, or refuses (spec 4.6 step 3, 5.5). */
async function chooseCertificate(ctx: Context, req: CreateRequest): Promise<CertSource> {
  if (req.cert === "self-signed") return { kind: "self-signed" };
  if (req.cert) {
    const info = await validateCertificateFiles(ctx, { ...req.cert, hostname: req.hostname });
    return { kind: "given", info };
  }
  if (!ctx.io.interactive) {
    throw refusal(
      "No terminal to ask for a certificate on.",
      "Re-run with --cert <f> --key <f>, or --self-signed.",
    );
  }
  ctx.io.out(`No certificate given for ${req.hostname}. Every Instance must have one.`);
  const answer = (
    await ctx.io.ask("  [1] self-signed now  [2] cancel (re-run with --cert/--key): ")
  ).trim();
  if (answer !== "1") throw new Cancelled();
  return { kind: "self-signed" };
}

/** The newest installed Release, or `--release`; installs it first if it is missing. */
async function resolveRelease(ctx: Context, wanted: string | undefined): Promise<string> {
  const installed = await installedReleases(ctx);
  const version = wanted ?? installed.at(-1) ?? (await latestStable(ctx));
  if (!installed.includes(version)) {
    await installRelease(ctx, await planRelease(ctx, version));
  }
  return version;
}

interface DirSpec {
  path: string;
  mode: number;
  /** `user:group` as `chown` takes it. */
  owner: string;
}

/** Every Instance directory, with spec 2.2 ownership, before the first start. */
async function makeDirectories(ctx: Context, name: string): Promise<void> {
  const dir = instanceDir(ctx, name);
  const account = accountOf(name);
  const rootGroup = `root:${account}`;
  const owned = `${account}:${account}`;
  const dirs: DirSpec[] = [
    { path: dir, mode: 0o750, owner: rootGroup },
    { path: join(dir, "config"), mode: 0o750, owner: rootGroup },
    { path: join(dir, "data"), mode: 0o700, owner: owned },
    { path: join(dir, "server-files"), mode: 0o700, owner: owned },
    { path: join(dir, "user-files"), mode: 0o700, owner: owned },
    { path: join(dir, "nginx"), mode: 0o700, owner: "root:root" },
  ];
  for (const { path, mode, owner } of dirs) {
    await ensureDir(path, mode);
    await run(ctx, "chown", [owner, path]);
  }
}

async function writeConfigFiles(
  ctx: Context,
  name: string,
  record: InstanceRecord,
  release: string,
): Promise<void> {
  const dir = instanceDir(ctx, name);
  await symlink(join(ctx.paths.releases, release), join(dir, "release"));
  const config = join(dir, "config", "config.json");
  await writeFileAtomic(
    join(dir, "config", "instance.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    0o600,
  );
  await writeFileAtomic(config, configJson(name, record, release), 0o640);
  await run(ctx, "chown", [`root:${accountOf(name)}`, config]);
}

/** Puts `cert.pem` and `key.pem` in the Instance's `nginx/`, root-only (spec 5.5). */
async function writeCertificate(
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
  await run(ctx, "openssl", [
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

function reportCertificate(ctx: Context, hostname: string, source: CertSource): void {
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

/** Steps 5 and 6 of spec 4.6: account, files, `nginx -t` and reload. Nothing of it stays on failure. */
async function createFiles(
  ctx: Context,
  req: CreateRequest,
  source: CertSource,
  record: InstanceRecord,
  release: string,
): Promise<void> {
  const { name, hostname } = req;
  const account = accountOf(name);
  await run(ctx, "useradd", [
    "--system",
    "--user-group",
    "--no-create-home",
    "--home-dir",
    "/nonexistent",
    "--shell",
    "/usr/sbin/nologin",
    account,
  ]);
  step(ctx, "done", `Account ${account}`);

  try {
    await makeDirectories(ctx, name);
    await writeConfigFiles(ctx, name, record, release);
    await writeCertificate(ctx, name, hostname, source);
    await writeFileAtomic(
      join(instanceDir(ctx, name), "nginx", "vhost.conf"),
      vhostConf(name, record, await hostHasIpv6(ctx)),
      0o600,
    );
    step(ctx, "done", `Instance on Release ${release}, port ${record.port}`);
    reportCertificate(ctx, hostname, source);

    const failure = await nginxTestFailure(ctx);
    if (failure) throw new CliError(`nginx -t failed: ${failure}`);
    await systemctl(ctx, "reload", "nginx");
    step(ctx, "done", "Nginx: nginx -t passed, reloaded");
  } catch (err) {
    // One bad vhost would block every reload on the Host, so nothing of it may stay (spec 5.5).
    await rm(instanceDir(ctx, name), { recursive: true, force: true });
    await ctx.runner.run("userdel", [account]);
    throw err instanceof CliError || err instanceof Cancelled
      ? err
      : new CliError(`Could not create ${name}: ${errorMessage(err)}`);
  }
}

/** Step 7 of spec 4.6. Nginx is fine by now, so a failed start keeps the Instance for `instance logs`. */
async function startAndVerify(
  ctx: Context,
  name: string,
  record: InstanceRecord,
  release: string,
): Promise<void> {
  const unit = `dcabsm@${name}`;
  let seconds: number;
  try {
    await systemctl(ctx, "start", unit);
    seconds = await verifyInstance(ctx, name, record.port, release);
    await systemctl(ctx, "enable", unit);
  } catch (err) {
    const nodeBin = join(instanceDir(ctx, name), "release", "node", "bin", "node");
    const why = (await exists(nodeBin))
      ? errorMessage(err)
      : `the Node for Release ${release} is missing on disk (${nodeBin}), so the unit cannot start`;
    throw new CliError(
      `${name} was created but did not start: ${why}`,
      `Run sudo dcabsm instance logs ${name}. Then fix it and run sudo dcabsm instance start ${name}, or run sudo dcabsm instance remove ${name}.`,
    );
  }
  step(ctx, "done", `Started and verified: /health UP, /info ${release} (${seconds}s)`);
}

/** `instance create <name> --hostname <host> (--cert <f> --key <f> | --self-signed) [--release <v>]` */
export async function instanceCreate({ ctx, args }: Invocation): Promise<void> {
  const req = parseCreate(args);
  await checkFree(ctx, req.name, req.hostname);
  const source = await chooseCertificate(ctx, req);

  ctx.io.out(`Create ${req.name}`);
  const release = await resolveRelease(ctx, req.release);
  const record: InstanceRecord = {
    port: await freePort(ctx),
    hostname: req.hostname,
    scheduledBackups: true,
  };
  await createFiles(ctx, req, source, record, release);
  await startAndVerify(ctx, req.name, record, release);

  ctx.io.out("");
  ctx.io.out(
    `Open https://${req.hostname} now to set the server password: until it is set, whoever opens it first sets it.`,
  );
  ctx.io.out("Scheduled backups are on.");
}
