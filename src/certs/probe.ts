import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectChain } from "../cert.ts";
import type { Context } from "../context.ts";
import { errorMessage } from "../errors.ts";
import { resolveInstanceNames } from "../instance/resolve-names.ts";
import {
  instanceDir,
  instanceNames,
  readRecord,
  requireInstance,
  type InstanceRecord,
} from "../instance/record.ts";

/** How long a reload has to show the new certificate (spec 5.6). */
export const SERVE_SECONDS = 5;
const POLL_MS = 250;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One Instance a certificate command works on. */
export interface CertTarget {
  name: string;
  record: InstanceRecord;
  certPath: string;
  keyPath: string;
}

/** Resolves `<names>|--all` (or, when `allowEmpty`, nothing meaning all) to existing Instances. */
export async function certTargets(
  ctx: Context,
  usage: string,
  names: string[],
  all: boolean | undefined,
  allowEmpty: boolean,
): Promise<CertTarget[]> {
  const list = await resolveInstanceNames(ctx, names, all, {
    usage: `Usage: dcabsm ${usage}`,
    allowEmpty,
    noInstancesHint: "Create one: dcabsm instance create <name> --hostname <host> --self-signed",
  });
  return targetsOf(ctx, list);
}

/** Every Instance with a record, with no complaint when there are none. A folder without one is a leftover for doctor to say. */
export async function allCertTargets(ctx: Context): Promise<CertTarget[]> {
  const named: string[] = [];
  for (const name of await instanceNames(ctx)) if (await readRecord(ctx, name)) named.push(name);
  return targetsOf(ctx, named);
}

async function targetsOf(ctx: Context, list: string[]): Promise<CertTarget[]> {
  const targets: CertTarget[] = [];
  for (const name of list) {
    const nginx = join(instanceDir(ctx, name), "nginx");
    targets.push({
      name,
      record: await requireInstance(ctx, name),
      certPath: join(nginx, "cert.pem"),
      keyPath: join(nginx, "key.pem"),
    });
  }
  return targets;
}

/** The CERT column of `instance list`: days left on the file, `expired`, and `self-signed`; `?` when unreadable. */
export async function certColumn(ctx: Context, name: string, hostname: string): Promise<string> {
  try {
    const pem = await readFile(join(instanceDir(ctx, name), "nginx", "cert.pem"), "utf8");
    const facts = inspectChain(ctx, pem, hostname);
    const days = facts.daysLeft < 0 ? "expired" : `${facts.daysLeft}d`;
    return facts.selfSigned ? `${days} self-signed` : days;
  } catch {
    return "?";
  }
}

/** What Nginx serves on `127.0.0.1:443` for a hostname: the leaf's fingerprint, or why not. */
export async function servedFingerprint(
  ctx: Context,
  hostname: string,
): Promise<{ fingerprint: string } | { error: string }> {
  try {
    const pem = await ctx.fetcher.servedChain("127.0.0.1", 443, hostname);
    return { fingerprint: inspectChain(ctx, pem, hostname).fingerprint };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/** Polls until the hostname serves `fingerprint`; returns the seconds it took, or undefined after 5 seconds. */
export async function confirmServed(
  ctx: Context,
  hostname: string,
  fingerprint: string,
): Promise<number | undefined> {
  const began = ctx.now().getTime();
  do {
    const served = await servedFingerprint(ctx, hostname);
    if ("fingerprint" in served && served.fingerprint === fingerprint) {
      return Math.max(1, Math.round((ctx.now().getTime() - began) / 1000));
    }
    await pause(POLL_MS);
  } while (ctx.now().getTime() - began < SERVE_SECONDS * 1000);
  return undefined;
}
