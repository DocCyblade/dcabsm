import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { reportCertificate, writeCertificate, type CertSource } from "../certs/provide.ts";
import type { Context } from "../context.ts";
import { Cancelled, CliError, errorMessage, firstLine } from "../errors.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import { createAccount, makeDirectories, writeConfigFiles } from "./create.ts";
import { writeVhost } from "./files.ts";
import { accountOf, instanceDir, parseRecord, type InstanceRecord } from "./record.ts";
import { DATA_DIRS, regroupData, regroupedLine } from "./restore-data.ts";

/** What `instance restore --from` and `instance clone` read out of an archive before they build. */
export interface Stage {
  /** Where the archive was extracted. */
  dir: string;
  /** The Instance record the archive holds, as written. */
  record: InstanceRecord;
  certPem: string;
  keyPem: string;
  /** Removes the work directory. Safe to call twice. */
  cleanup(): Promise<void>;
}

/** The members a new Instance is built from; the `release` link is never in an archive (spec 7.1). */
const MEMBERS = ["config", "nginx", ...DATA_DIRS];

/**
 * Extracts an archive into a dot-prefixed work directory beside the Instances, so a bad archive
 * leaves nothing behind, and reads its record and certificate. `label` names the work directory.
 */
export async function extractArchive(ctx: Context, archive: string, label: string): Promise<Stage> {
  const dir = join(ctx.paths.instances, `.building-${label}`);
  const cleanup = () => rm(dir, { recursive: true, force: true });
  await cleanup();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const res = await ctx.runner.run("tar", [
      "-xzf",
      archive,
      "--numeric-owner",
      "-p",
      "-C",
      dir,
      ...MEMBERS,
    ]);
    if (res.code !== 0) {
      throw new CliError(
        `tar could not read ${archive}: ${firstLine(res.stderr, `exit ${res.code}`)}`,
      );
    }
    const text = await readFile(join(dir, "config", "instance.json"), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) {
      throw new CliError(`${archive} holds no readable config/instance.json.`);
    }
    const record = parseRecord(text);
    if (!record) {
      throw new CliError(`${archive} holds an Instance record without a port or hostname.`);
    }
    const read = async (file: string) => {
      try {
        return await readFile(join(dir, "nginx", file), "utf8");
      } catch {
        throw new CliError(`${archive} holds no nginx/${file}, so its certificate is missing.`);
      }
    };
    return {
      dir,
      record,
      certPem: await read("cert.pem"),
      keyPem: await read("key.pem"),
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Everything `buildInstance` needs; the caller has already decided and checked all of it. */
export interface BuildPlan {
  name: string;
  stage: Stage;
  /** The record the new Instance gets: its port and hostname are already the final ones. */
  record: InstanceRecord;
  release: string;
  cert: CertSource;
  /** Says what came of the certificate; defaults to `reportCertificate`. */
  reportCert?: () => void;
}

/**
 * Builds an Instance from an extracted archive (spec 7.7, 7.8): account, directories and ownership,
 * the archive's data, Regroup, config files, certificate, `nginx -t` and reload. Starting and
 * Verification are left to the caller (`startAndVerify`). Nothing of it stays on failure: one bad
 * vhost would block every Nginx reload on the Host (spec 5.5).
 */
export async function buildInstance(ctx: Context, plan: BuildPlan): Promise<void> {
  const { name, stage, record, release, cert } = plan;
  const account = await createAccount(ctx, name);
  const dir = instanceDir(ctx, name);
  try {
    await makeDirectories(ctx, name);
    for (const d of DATA_DIRS) {
      await rm(join(dir, d), { recursive: true, force: true });
      await rename(join(stage.dir, d), join(dir, d));
    }
    const count = await regroupData(ctx, name);
    step(
      ctx,
      "done",
      `Data copied, ownership set for ${accountOf(name)}; ${regroupedLine(count).toLowerCase()}`,
    );

    await writeConfigFiles(ctx, name, record, release);
    await writeCertificate(ctx, name, record.hostname, cert);
    await writeVhost(ctx, name, record);
    step(ctx, "done", `Instance on Release ${release}, port ${record.port}`);
    (plan.reportCert ?? (() => reportCertificate(ctx, record.hostname, cert)))();

    const failure = await nginxTestFailure(ctx);
    if (failure) throw new CliError(`nginx -t failed: ${failure}`);
    await systemctl(ctx, "reload", "nginx");
    step(ctx, "done", "Nginx: nginx -t passed, reloaded");
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    await ctx.runner.run("userdel", [account]);
    throw err instanceof CliError || err instanceof Cancelled
      ? err
      : new CliError(`Could not build ${name}: ${errorMessage(err)}`);
  }
}
