import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectChain } from "../cert.ts";
import type { Context } from "../context.ts";
import { errorMessage, refusal } from "../errors.ts";
import {
  instanceDir,
  instanceNames,
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
  if (all && names.length > 0) {
    throw refusal("Give Instance names or --all, not both.", `Usage: dcabsm ${usage}`);
  }
  const everyone = all || (allowEmpty && names.length === 0);
  const list = everyone ? await instanceNames(ctx) : [...new Set(names)];
  if (list.length === 0) {
    throw refusal(
      everyone ? "There are no Instances." : "Give at least one Instance name, or --all.",
      everyone
        ? "Create one: dcabsm instance create <name> --hostname <host> --self-signed"
        : `Usage: dcabsm ${usage}`,
    );
  }
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
