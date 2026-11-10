import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { DEFAULT_BACKUP_DIR, defaultHostConfig, readHostConfig } from "../host/config.ts";
import { hostHasIpv6, hostOwnedFiles, inspectOwnedFiles, writeVerified } from "../host/owned.ts";
import { nginxIsActive, systemctl } from "../host/system.ts";
import { configJson, vhostConf, writeConfigJson } from "../instance/files.ts";
import { stateOf } from "../instance/list.ts";
import { instanceDir, instanceNames, readRecord, runningRelease } from "../instance/record.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { requireUpdateLock } from "./migrations.ts";

async function readOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Brings the generated files of every Instance up to what this version writes. */
async function refreshInstances(
  ctx: Context,
): Promise<{ restart: string[]; vhosts: Array<{ path: string; old: string | undefined }> }> {
  const restart: string[] = [];
  const vhosts: Array<{ path: string; old: string | undefined }> = [];
  const ipv6 = await hostHasIpv6(ctx);
  for (const name of await instanceNames(ctx)) {
    const record = await readRecord(ctx, name);
    if (!record) continue;
    let release: string;
    try {
      release = await runningRelease(ctx, name);
    } catch {
      continue;
    }
    const dir = instanceDir(ctx, name);
    const oldConfig = await readOrUndefined(join(dir, "config", "config.json"));
    if (oldConfig !== configJson(name, record, release)) {
      await writeConfigJson(ctx, name, record, release);
      if (oldConfig !== undefined && (await stateOf(ctx, name)) !== "stopped") restart.push(name);
    }
    const vhostPath = join(dir, "nginx", "vhost.conf");
    const oldVhost = await readOrUndefined(vhostPath);
    const vhost = vhostConf(name, record, ipv6);
    if (oldVhost !== vhost) {
      await writeFileAtomic(vhostPath, vhost, 0o600);
      vhosts.push({ path: vhostPath, old: oldVhost });
    }
  }
  return { restart, vhosts };
}

/**
 * Hidden `self refresh`: brings the owned files (spec 10.5) and every Instance's generated files up to
 * what this version writes. Self-update runs it with the new version's code, after the switch.
 * A file edited by hand is kept. It never restarts an Instance.
 */
export async function selfRefresh({ ctx }: Invocation): Promise<void> {
  await requireUpdateLock(ctx, "refresh");
  const stored = await readHostConfig(ctx);
  if (!stored) return;

  const { restart, vhosts } = await refreshInstances(ctx);
  const nightly =
    stored.nightlyTime ?? defaultHostConfig(stored.backupDir ?? DEFAULT_BACKUP_DIR).nightlyTime;
  const inspected = await inspectOwnedFiles(
    ctx,
    await hostOwnedFiles(ctx, nightly),
    stored.ownedFiles ?? {},
  );
  let result;
  try {
    result = await writeVerified(
      ctx,
      inspected,
      new Set(),
      stored.ownedFiles ?? {},
      "sudo dcabsm host doctor --fix",
    );
  } catch (err) {
    for (const v of vhosts) {
      if (v.old !== undefined) await writeFileAtomic(v.path, v.old, 0o600);
    }
    throw err;
  }

  if (result.written.length > 0) await systemctl(ctx, "daemon-reload");
  const nginxChanged = result.nginxWritten.length > 0 || vhosts.length > 0;
  const reloaded = nginxChanged && (await nginxIsActive(ctx));
  if (reloaded) await systemctl(ctx, "reload", "nginx");

  const parts = result.written.map((p) => p.split("/").pop()!);
  if (vhosts.length > 0) parts.push(`${vhosts.length} vhost.conf`);
  if (parts.length > 0) {
    const test = nginxChanged ? ` (nginx -t passed${reloaded ? ", reloaded" : ""})` : "";
    step(ctx, "done", `Owned files refreshed: ${parts.join(", ")}${test}`);
  } else {
    step(ctx, "done", "Owned files already match");
  }
  if (restart.length > 0) {
    ctx.io.out("");
    for (const name of restart) {
      step(
        ctx,
        "warn",
        `Restart needed: ${name} (its generated config.json changed). Run: sudo dcabsm instance restart ${name}`,
      );
    }
  }
}
