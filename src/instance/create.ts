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

async function chooseCertificate(ctx: Context, hostname: string, selfSigned: boolean) {
  if (selfSigned) return;
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

/** Creates the files, directories and certificate of one Instance, with spec 2.2 ownership. */
async function layOutInstanceFiles(
  ctx: Context,
  name: string,
  record: InstanceRecord,
  release: string,
) {
  const dir = instanceDir(ctx, name);
  const account = accountOf(name);
  const rootGroup = `root:${account}`;
  const owned = `${account}:${account}`;
  const ipv6 = await hostHasIpv6(ctx);

  const dirs: Array<[string, number, string]> = [
    [dir, 0o750, rootGroup],
    [join(dir, "config"), 0o750, rootGroup],
    [join(dir, "data"), 0o700, owned],
    [join(dir, "server-files"), 0o700, owned],
    [join(dir, "user-files"), 0o700, owned],
    [join(dir, "nginx"), 0o700, "root:root"],
  ];
  for (const [path, mode, owner] of dirs) {
    await ensureDir(path, mode);
    await run(ctx, "chown", [owner, path]);
  }
  await symlink(join(ctx.paths.releases, release), join(dir, "release"));

  const config = join(dir, "config", "config.json");
  await writeFileAtomic(
    join(dir, "config", "instance.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    0o600,
  );
  await writeFileAtomic(config, configJson(name, record), 0o640);
  await run(ctx, "chown", [rootGroup, config]);

  const nginx = join(dir, "nginx");
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
    `/CN=${record.hostname}`,
    "-addext",
    `subjectAltName=DNS:${record.hostname}`,
    "-keyout",
    join(nginx, "key.pem"),
    "-out",
    join(nginx, "cert.pem"),
  ]);
  for (const file of ["key.pem", "cert.pem"]) await chmod(join(nginx, file), 0o600);
  await writeFileAtomic(join(nginx, "vhost.conf"), vhostConf(name, record, ipv6), 0o600);
}

/** `instance create <name> --hostname <host> (--cert <f> --key <f> | --self-signed) [--release <v>]` */
export async function instanceCreate({ ctx, args }: Invocation): Promise<void> {
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
  const hostname = values.hostname;
  checkHostname(hostname);

  if (values.cert !== undefined || values.key !== undefined) {
    if (values["self-signed"]) throw refusal("Use --self-signed or --cert/--key, not both.");
    throw refusal("--cert and --key are not built yet.", "Use --self-signed for now.");
  }
  if (await exists(instanceDir(ctx, name))) {
    throw refusal(
      `An Instance named ${name} already exists.`,
      "See the list: dcabsm instance list",
    );
  }
  const inUse = await hostnameInUse(ctx, hostname);
  if (inUse) throw refusal(inUse);
  await chooseCertificate(ctx, hostname, values["self-signed"] === true);

  ctx.io.out(`Create ${name}`);
  const release = await resolveRelease(ctx, values.release);

  const record: InstanceRecord = {
    port: await freePort(ctx),
    hostname,
    scheduledBackups: true,
  };
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

  const unit = `dcabsm@${name}`;
  try {
    await layOutInstanceFiles(ctx, name, record, release);
    step(ctx, "done", `Instance on Release ${release}, port ${record.port}`);
    step(ctx, "done", `Certificate for ${hostname}, ${SELF_SIGNED_DAYS} days left (self-signed)`);
    ctx.io.out(
      "  Self-signed: browsers warn on each device, and may warn again later. Actual works after you proceed,",
    );
    ctx.io.out(
      "  but offline use and installing as an app need a certificate the device trusts. Bring one later: sudo dcabsm cert update <name> --cert <file> --key <file>",
    );

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

  await systemctl(ctx, "start", unit);
  const seconds = await verifyInstance(ctx, name, record.port, release);
  await systemctl(ctx, "enable", unit);
  step(ctx, "done", `Started and verified: /health UP, /info ${release} (${seconds}s)`);

  ctx.io.out("");
  ctx.io.out(
    `Open https://${hostname} now to set the server password: until it is set, whoever opens it first sets it.`,
  );
  ctx.io.out("Scheduled backups are on.");
}
