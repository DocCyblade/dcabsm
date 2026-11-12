import { basename } from "node:path";
import { readManifest, requireArchiveFile } from "../backup/archive.ts";
import { hostnameInUse, type CertSource } from "../certs/provide.ts";
import { inspectChain } from "../cert.ts";
import type { Context } from "../context.ts";
import { refusal } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import { installRelease } from "../release/install.ts";
import { checkHostname, freePort, startAndVerify } from "./create.ts";
import { deviceAdvice } from "./device-advice.ts";
import { buildInstance, extractArchive } from "./from-archive.ts";
import { checkName, instanceDir, type InstanceRecord } from "./record.ts";
import { reportUnusedSettings } from "./setting-table.ts";
import { planIfMissing } from "./upgrade-plan.ts";

/** `instance restore --from <archive>` (spec 7.7): rebuilds an Instance that does not exist here. */
export async function restoreFrom(ctx: Context, given: string): Promise<void> {
  const archive = await requireArchiveFile(given);
  const manifest = await readManifest(ctx, archive);
  const name = manifest.name;
  checkName(name);
  if (await exists(instanceDir(ctx, name))) {
    throw refusal(
      `The archive is of Instance ${name}, and an Instance named ${name} already exists here.`,
      `Restore into it: sudo dcabsm instance restore ${name} ${archive}\n  Or make a new Instance from the archive: sudo dcabsm instance clone --from ${archive} <new-name> --hostname <host>`,
    );
  }

  const stage = await extractArchive(ctx, archive, name);
  try {
    ctx.io.out(`Rebuild Instance ${name} from ${basename(archive)}`);
    const archived = stage.record;
    const hostname = archived.hostname;
    step(
      ctx,
      "done",
      `Archive manifest: format ${manifest.format}, Instance ${name}, hostname ${hostname}, Release ${manifest.release}`,
    );
    checkHostname(hostname);
    const inUse = await hostnameInUse(ctx, hostname);
    if (inUse) {
      throw refusal(
        inUse,
        "Free the hostname first, or make a new Instance from the archive: sudo dcabsm instance clone --from <archive> <new-name> --hostname <host>",
      );
    }
    const port = await freePort(ctx, archived.port);
    const record: InstanceRecord = { ...archived, port };
    step(
      ctx,
      "done",
      port === archived.port
        ? `Port ${port} is free, kept`
        : `Port ${archived.port} is in use here, so ${name} takes ${port}`,
    );
    step(ctx, "done", `Hostname ${hostname} is not used by another site`);

    const facts = inspectChain(ctx, stage.certPem, hostname);
    const cert: CertSource = {
      kind: "given",
      info: {
        certPem: stage.certPem,
        keyPem: stage.keyPem,
        notAfter: facts.notAfter,
        daysLeft: facts.daysLeft,
        warnings: [],
      },
    };
    const plan = await planIfMissing(ctx, manifest.release);
    if (plan) await installRelease(ctx, plan);

    await buildInstance(ctx, {
      name,
      stage,
      record,
      release: manifest.release,
      cert,
      reportCert: () => {
        if (facts.daysLeft < 0) {
          step(
            ctx,
            "warn",
            `Certificate from the archive expired ${-facts.daysLeft} days ago. It is kept so the rebuild goes through. Replace it: sudo dcabsm cert update ${name} --cert <file> --key <file>`,
          );
        } else {
          step(ctx, "done", `Certificate from the archive: ${facts.daysLeft} days left`);
        }
      },
    });
    await startAndVerify(ctx, name, record, manifest.release);
  } catch (err) {
    await logChange(ctx, "instance restore --from", `${name} from ${basename(archive)}: failed`);
    throw err;
  } finally {
    await stage.cleanup();
  }
  await logChange(ctx, "instance restore --from", `${name} from ${basename(archive)}: rebuilt`);

  step(ctx, "info", `Point DNS for ${stage.record.hostname} at this Host.`);
  reportUnusedSettings(ctx, stage.record, manifest.release);
  deviceAdvice(ctx);
}
