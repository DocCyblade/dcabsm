import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { parseCommand } from "../args.ts";
import { inspectChain, type ChainFacts } from "../cert.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage } from "../errors.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { certTargets, type CertTarget } from "./probe.ts";

/** One line of a test: the mark `step` prints it with, and whether it counts as a failure. */
export interface Finding {
  mark: "done" | "info" | "warn" | "failed";
  text: string;
}

const USAGE = "cert test [<names>|--all]";
const WARN_DAYS = 30;

/** Whether an address belongs to this Host. */
function isLocal(address: string): boolean {
  if (address === "::1" || address.startsWith("127.")) return true;
  return Object.values(networkInterfaces()).some((list) =>
    list?.some((a) => a.address === address),
  );
}

async function resolution(ctx: Context, hostname: string): Promise<Finding> {
  try {
    const addresses = await ctx.fetcher.resolve(hostname);
    if (addresses.some(isLocal)) return { mark: "done", text: "Hostname resolves to this Host" };
    return {
      mark: "info",
      text: `Hostname resolves to ${addresses[0]}, not an address on this Host`,
    };
  } catch {
    return { mark: "warn", text: "Hostname does not resolve" };
  }
}

/** Tests one Instance and says what it found (spec 5.7). Shared by `cert test` and `host doctor`. */
export async function testInstance(ctx: Context, target: CertTarget): Promise<Finding[]> {
  const hostname = target.record.hostname;
  const found: Finding[] = [];

  let disk: ChainFacts;
  try {
    disk = inspectChain(ctx, await readFile(target.certPath, "utf8"), hostname);
  } catch (err) {
    return [{ mark: "failed", text: `Certificate file: ${errorMessage(err)}` }];
  }

  let served: ChainFacts | undefined;
  try {
    served = inspectChain(ctx, await ctx.fetcher.servedChain("127.0.0.1", 443, hostname), hostname);
  } catch (err) {
    found.push({
      mark: "failed",
      text: `Could not connect to 127.0.0.1:443 as ${hostname}: ${errorMessage(err)}`,
    });
  }

  if (served) {
    if (!served.covers) {
      found.push({
        mark: "failed",
        text: `Served certificate does not cover ${hostname}`,
      });
    } else if (served.fingerprint !== disk.fingerprint) {
      found.push({
        mark: "failed",
        text: "Served certificate differs from the file on disk. Reload Nginx: sudo systemctl reload nginx",
      });
    } else {
      found.push({
        mark: "done",
        text: `Served certificate matches ${hostname} and the file on disk`,
      });
    }
  }

  // When nothing was served to compare with, or something else was, the file itself must be right.
  if (!disk.covers && (!served || served.fingerprint !== disk.fingerprint)) {
    found.push({ mark: "failed", text: `Certificate file does not cover ${hostname}` });
  }

  const facts = served ?? disk;
  if (facts.daysLeft < 0)
    found.push({ mark: "failed", text: `Expired ${-facts.daysLeft} days ago` });
  else if (facts.daysLeft < WARN_DAYS)
    found.push({ mark: "warn", text: `${facts.daysLeft} days left` });
  else found.push({ mark: "done", text: `${facts.daysLeft} days left` });
  if (!facts.trusted) {
    found.push({
      mark: "info",
      text: `Not trusted by system CAs (${facts.selfSigned ? "self-signed" : "private or unknown CA"})`,
    });
  }
  found.push(await resolution(ctx, hostname));
  return found;
}

/** `cert test [<names>|--all]` */
export async function certTest({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, {
    all: { type: "boolean" },
  });
  const targets = await certTargets(ctx, USAGE, positionals, values.all, true);
  let failed = 0;
  for (const target of targets) {
    ctx.io.out(`${target.name}  ${target.record.hostname}`);
    const found = await testInstance(ctx, target);
    for (const f of found) step(ctx, f.mark, f.text);
    if (found.some((f) => f.mark === "failed")) failed++;
  }
  if (failed > 0) throw new CliError(`${failed} of ${targets.length} Instances failed.`);
}
