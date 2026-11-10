import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { exists, writeFileAtomic } from "../fsutil.ts";
import { hostHasIpv6 } from "../host/owned.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import { confirm } from "../prompt.ts";
import type { Invocation } from "../table.ts";
import { instanceRestart, runningRelease } from "./controls.ts";
import { configJson, vhostConf } from "./files.ts";
import { stateOf } from "./list.ts";
import {
  accountOf,
  instanceDir,
  recordPath,
  requireInstance,
  type InstanceRecord,
} from "./record.ts";
import {
  bodyLimitMb,
  findSetting,
  neverSettable,
  SETTINGS,
  UPLOAD_KEYS,
  usedBy,
  type SettingDef,
  type SettingValue,
} from "./setting-table.ts";

/** The Instance's record, refusing while a Release change is unfinished. */
async function requireSettable(ctx: Context, name: string): Promise<InstanceRecord> {
  const record = await requireInstance(ctx, name);
  if (await exists(join(instanceDir(ctx, name), ".changing-release"))) {
    throw refusal(
      `${name} has an unfinished Release change.`,
      "Finish it first: dcabsm instance upgrade or dcabsm instance rollback",
    );
  }
  return record;
}

function lookup(key: string): SettingDef {
  const def = findSetting(key);
  if (def) return def;
  const why = neverSettable(key);
  if (why) throw refusal(`${key} can't be set: ${why}.`);
  throw refusal(`${key}: unknown setting.`, `See the list: dcabsm instance settings <name>`);
}

const show = (value: SettingValue): string => String(value);

/** Writes `config.json` for the Release (spec 4.4), root-owned and readable by the Instance account. */
async function writeConfig(
  ctx: Context,
  name: string,
  record: InstanceRecord,
  release: string,
): Promise<void> {
  const path = join(instanceDir(ctx, name), "config", "config.json");
  await writeFileAtomic(path, configJson(name, record, release), 0o640);
  await ctx.runner.run("chown", [`root:${accountOf(name)}`, path]);
}

/**
 * Regenerates `vhost.conf` for a new body limit, tests and reloads Nginx.
 * If `nginx -t` fails, the old file goes back.
 */
async function reloadVhost(ctx: Context, name: string, record: InstanceRecord): Promise<string> {
  const path = join(instanceDir(ctx, name), "nginx", "vhost.conf");
  const old = await readFile(path, "utf8");
  await writeFileAtomic(path, vhostConf(name, record, await hostHasIpv6(ctx)), 0o600);
  try {
    const failure = await nginxTestFailure(ctx);
    if (failure) throw new CliError(`nginx -t failed: ${failure}`, "Nothing was changed.");
    await systemctl(ctx, "reload", "nginx");
  } catch (err) {
    await writeFileAtomic(path, old, 0o600);
    throw err;
  }
  return `Nginx: client_max_body_size ${bodyLimitMb(record.settings)}m, nginx -t passed, reloaded`;
}

/** Saves the new record, then handles Nginx and the restart (spec 4.11). */
async function apply(
  ctx: Context,
  name: string,
  key: string,
  next: InstanceRecord,
  yes: boolean | undefined,
  line: string,
): Promise<void> {
  const release = await runningRelease(ctx, name);
  // Nginx first, so a failed `nginx -t` leaves the record and config.json as they were.
  const nginx = UPLOAD_KEYS.includes(key) ? await reloadVhost(ctx, name, next) : undefined;
  await writeFileAtomic(recordPath(ctx, name), `${JSON.stringify(next, null, 2)}\n`, 0o600);
  await writeConfig(ctx, name, next, release);
  step(ctx, "done", line);
  if (nginx) step(ctx, "done", nginx);

  if ((await stateOf(ctx, name)) === "stopped") {
    step(ctx, "info", `${name} is stopped. The change applies on the next start.`);
    return;
  }
  const restart =
    ctx.io.interactive || yes
      ? await confirm(ctx, `Restart ${name} now?`, { yes, defaultYes: true })
      : false;
  if (restart) {
    await instanceRestart({ ctx, args: [name] });
  } else {
    step(
      ctx,
      "warn",
      `restart needed: sudo dcabsm instance restart ${name} (Actual reads its config only at startup)`,
    );
  }
}

/** `instance set <name> <key> <value> [--yes]` */
export async function instanceSet({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, { yes: { type: "boolean" } });
  if (positionals.length !== 3) {
    throw refusal(
      "Give an Instance name, a key and a value.",
      "Usage: dcabsm instance set <name> <key> <value> [--yes]",
    );
  }
  const [name, key, text] = positionals as [string, string, string];
  const record = await requireSettable(ctx, name);
  const def = lookup(key);
  const release = await runningRelease(ctx, name);
  if (!usedBy(def, release)) {
    throw refusal(
      `${key} needs ${def.firstRelease}, ${name} runs ${release}.`,
      `Upgrade first: sudo dcabsm instance upgrade ${name}`,
    );
  }
  const value = def.parse(text);
  if (value === undefined) {
    throw refusal(`${text} is not a valid value for ${key}.`, `Use ${def.expects}.`);
  }
  const next: InstanceRecord = { ...record, settings: { ...record.settings, [key]: value } };
  await apply(ctx, name, key, next, values.yes, `${key} = ${show(value)} for ${name}`);
}

/** `instance unset <name> <key> [--yes]` */
export async function instanceUnset({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, { yes: { type: "boolean" } });
  if (positionals.length !== 2) {
    throw refusal(
      "Give an Instance name and a key.",
      "Usage: dcabsm instance unset <name> <key> [--yes]",
    );
  }
  const [name, key] = positionals as [string, string];
  const record = await requireSettable(ctx, name);
  const def = lookup(key);
  const rest = { ...record.settings };
  delete rest[key];
  const next: InstanceRecord = { ...record, settings: rest };
  await apply(
    ctx,
    name,
    key,
    next,
    values.yes,
    `${key} back to default (${def.defaultText}) for ${name}`,
  );
}

/** `instance settings <name>` */
export async function instanceSettings({ ctx, args }: Invocation): Promise<void> {
  const { positionals } = parseCommand(args, {});
  if (positionals.length !== 1) {
    throw refusal("Give one Instance name.", "Usage: dcabsm instance settings <name>");
  }
  const name = positionals[0]!;
  const record = await requireInstance(ctx, name);
  const release = await runningRelease(ctx, name);
  const rows = [
    ["KEY", "ACTUAL KEY", "VALUE", "SOURCE", "USED"],
    ...SETTINGS.map((def) => {
      const value = record.settings?.[def.key];
      return [
        def.key,
        def.actualKey,
        value === undefined ? def.defaultText : show(value),
        value === undefined ? "default" : "set",
        usedBy(def, release) ? "yes" : `not used by ${release}`,
      ];
    }),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const row of rows) {
    ctx.io.out(
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]! + 2)))
        .join("")
        .trimEnd(),
    );
  }
}
