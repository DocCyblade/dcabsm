import { readFile } from "node:fs/promises";
import { parseCommand } from "../args.ts";
import { formatColumns } from "../columns.ts";
import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import { nginxTestFailure, systemctl } from "../host/system.ts";
import { step } from "../output.ts";
import { confirm } from "../prompt.ts";
import type { Invocation } from "../table.ts";
import { instanceRestart } from "./controls.ts";
import { vhostPath, writeConfigJson, writeVhost } from "./files.ts";
import { stateOf } from "./list.ts";
import {
  recordPath,
  refuseIfChanging,
  requireInstance,
  runningRelease,
  writeRecord,
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
} from "./setting-table.ts";

/** The Instance's record, refusing while a Release change is unfinished. */
async function requireSettable(ctx: Context, name: string): Promise<InstanceRecord> {
  const record = await requireInstance(ctx, name);
  await refuseIfChanging(ctx, name);
  return record;
}

function lookup(key: string): SettingDef {
  const def = findSetting(key);
  if (def) return def;
  const why = neverSettable(key);
  if (why) throw refusal(`${key} can't be set: ${why}.`);
  throw refusal(`${key}: unknown setting.`, `See the list: dcabsm instance settings <name>`);
}

/**
 * Regenerates `vhost.conf` for a new body limit, tests and reloads Nginx.
 * If `nginx -t` fails, the old file goes back.
 */
async function reloadVhost(ctx: Context, name: string, record: InstanceRecord): Promise<string> {
  const path = vhostPath(ctx, name);
  const old = await readFile(path, "utf8");
  await writeVhost(ctx, name, record);
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

/** What a `set` or `unset` is about to do. */
interface Change {
  name: string;
  key: string;
  before: InstanceRecord;
  after: InstanceRecord;
  /** The line that confirms it. */
  line: string;
  yes: boolean | undefined;
}

/** Saves the new record and `config.json`, then handles Nginx and the restart (spec 4.11). */
async function apply(ctx: Context, change: Change): Promise<void> {
  const { name, key, before, after, line, yes } = change;
  const release = await runningRelease(ctx, name);
  const path = recordPath(ctx, name);
  const oldText = await readFile(path, "utf8");
  // Files first: if a write fails, Nginx has not moved ahead of the record.
  await writeRecord(ctx, name, after);
  await writeConfigJson(ctx, name, after, release);
  let nginx: string | undefined;
  if (UPLOAD_KEYS.includes(key)) {
    try {
      nginx = await reloadVhost(ctx, name, after);
    } catch (err) {
      // A refused Nginx change leaves nothing changed.
      await writeFileAtomic(path, oldText, 0o600);
      await writeConfigJson(ctx, name, before, release);
      throw err;
    }
  }
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
  if (record.settings?.[key] === value) {
    step(ctx, "info", `${key} is already ${value} for ${name}. Nothing changed.`);
    return;
  }
  const after: InstanceRecord = { ...record, settings: { ...record.settings, [key]: value } };
  await apply(ctx, {
    name,
    key,
    before: record,
    after,
    line: `${key} = ${value} for ${name}`,
    yes: values.yes,
  });
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
  if (record.settings?.[key] === undefined) {
    step(
      ctx,
      "info",
      `${key} is already at its default (${def.defaultText}) for ${name}. Nothing changed.`,
    );
    return;
  }
  const rest = { ...record.settings };
  delete rest[key];
  await apply(ctx, {
    name,
    key,
    before: record,
    after: { ...record, settings: rest },
    line: `${key} back to default (${def.defaultText}) for ${name}`,
    yes: values.yes,
  });
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
        value === undefined ? def.defaultText : String(value),
        value === undefined ? "default" : "set",
        usedBy(def, release) ? "yes" : `not used by ${release}`,
      ];
    }),
  ];
  for (const line of formatColumns(rows)) ctx.io.out(line);
}
