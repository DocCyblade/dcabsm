import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { parseCommand } from "../args.ts";
import { inspectChain, type ChainFacts } from "../cert.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage } from "../errors.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { certTargets, type CertTarget } from "./probe.ts";

const USAGE = "cert test [<names>|--all]";
const WARN_DAYS = 30;

/** Whether an address belongs to this Host. */
function isLocal(address: string): boolean {
  if (address === "::1" || address.startsWith("127.")) return true;
  return Object.values(networkInterfaces()).some((list) =>
    list?.some((a) => a.address === address),
  );
}

async function resolution(ctx: Context, hostname: string): Promise<void> {
  try {
    const addresses = await ctx.fetcher.resolve(hostname);
    if (addresses.some(isLocal)) step(ctx, "done", "Hostname resolves to this Host");
    else step(ctx, "info", `Hostname resolves to ${addresses[0]}, not an address on this Host`);
  } catch {
    step(ctx, "warn", "Hostname does not resolve");
  }
}

/** Tests one Instance; returns whether it failed (spec 5.7). */
async function testOne(ctx: Context, target: CertTarget): Promise<boolean> {
  const { name, record } = target;
  const hostname = record.hostname;
  ctx.io.out(`${name}  ${hostname}`);

  let disk: ChainFacts;
  try {
    disk = inspectChain(ctx, await readFile(target.certPath, "utf8"), hostname);
  } catch (err) {
    step(ctx, "failed", `Certificate file: ${errorMessage(err)}`);
    return true;
  }

  let failed = false;
  let served: ChainFacts | undefined;
  try {
    served = inspectChain(ctx, await ctx.fetcher.servedChain("127.0.0.1", 443, hostname), hostname);
  } catch (err) {
    step(ctx, "failed", `Could not connect to 127.0.0.1:443 as ${hostname}: ${errorMessage(err)}`);
    failed = true;
  }

  if (served) {
    if (!served.covers) {
      step(ctx, "failed", `Served certificate does not cover ${hostname}`);
      failed = true;
    } else if (served.fingerprint !== disk.fingerprint) {
      step(
        ctx,
        "failed",
        "Served certificate differs from the file on disk. Reload Nginx: sudo systemctl reload nginx",
      );
      failed = true;
    } else {
      step(ctx, "done", `Served certificate matches ${hostname} and the file on disk`);
    }
  }

  const facts = served ?? disk;
  if (facts.daysLeft < 0) {
    step(ctx, "failed", `Expired ${-facts.daysLeft} days ago`);
    failed = true;
  } else if (facts.daysLeft < WARN_DAYS) {
    step(ctx, "warn", `${facts.daysLeft} days left`);
  } else {
    step(ctx, "done", `${facts.daysLeft} days left`);
  }
  if (!facts.trusted) {
    step(
      ctx,
      "info",
      `Not trusted by system CAs (${facts.selfSigned ? "self-signed" : "private or unknown CA"})`,
    );
  }
  await resolution(ctx, hostname);
  return failed;
}

/** `cert test [<names>|--all]` */
export async function certTest({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, { all: { type: "boolean" } });
  const targets = await certTargets(ctx, USAGE, positionals, values.all, true);
  let failed = 0;
  for (const target of targets) if (await testOne(ctx, target)) failed++;
  if (failed > 0) throw new CliError(`${failed} of ${targets.length} Instances failed.`);
}
