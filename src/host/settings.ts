import { parseCommand } from "../args.ts";
import { COUNTED_KINDS } from "../backup/retention.ts";
import { formatColumns } from "../columns.ts";
import { refusal } from "../errors.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import {
  DEFAULT_BACKUP_DIR,
  defaultHostConfig,
  readHostConfig,
  writeHostConfig,
} from "./config.ts";
import {
  hostOwnedFiles,
  inspectOwnedFiles,
  resolveDrift,
  TIMER_PATH,
  writeOwnedFiles,
} from "./owned.ts";
import { systemctl } from "./system.ts";

/** `host settings` */
export async function hostSettings({ ctx, args }: Invocation): Promise<void> {
  parseCommand(args, {});
  const stored = (await readHostConfig(ctx)) ?? {};
  const defaults = defaultHostConfig(stored.backupDir ?? DEFAULT_BACKUP_DIR);
  const rows = [
    ["backup-dir", `${defaults.backupDir}  (set at setup)`],
    ["nightly-time", stored.nightlyTime ?? defaults.nightlyTime],
    ...COUNTED_KINDS.map((k) => [`keep-${k}`, String(stored.keep?.[k] ?? defaults.keep[k])]),
  ];
  for (const line of formatColumns(rows)) ctx.io.out(`  ${line}`);
}

const KEYS = ["nightly-time", ...COUNTED_KINDS.map((k) => `keep-${k}`)];

/** `host set <key> <value>` */
export async function hostSet({ ctx, args }: Invocation): Promise<void> {
  const { values, positionals } = parseCommand(args, { yes: { type: "boolean" } });
  const [key, value, ...extra] = positionals;
  if (key === undefined || value === undefined || extra.length > 0) {
    throw refusal("Usage: dcabsm host set <key> <value>", "See the keys: dcabsm host settings");
  }
  if (key === "backup-dir") {
    throw refusal(
      "backup-dir can't be changed here.",
      "Set it at setup: sudo dcabsm host setup --backup-dir <path>",
    );
  }
  if (!KEYS.includes(key)) {
    throw refusal(`${key}: unknown setting.`, "See the keys: dcabsm host settings");
  }
  const stored = (await readHostConfig(ctx)) ?? {};

  if (key === "nightly-time") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw refusal(`${value} is not a time.`, "Use HH:MM, 24 hours, such as 03:30");
    }
    const timer = (await hostOwnedFiles(ctx, value)).filter((f) => f.path === TIMER_PATH);
    const hashes = stored.ownedFiles ?? {};
    const inspected = await inspectOwnedFiles(ctx, timer, hashes);
    const replace = await resolveDrift(ctx, inspected, values);
    const written = await writeOwnedFiles(ctx, inspected, replace, hashes);
    await writeHostConfig(ctx, { ...stored, nightlyTime: value, ownedFiles: written.hashes });
    if (written.written.length > 0) {
      await systemctl(ctx, "daemon-reload");
      await systemctl(ctx, "restart", "dcabsm-nightly.timer");
    }
    step(ctx, "done", `nightly-time is ${value}; the timer was regenerated`);
    return;
  }

  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw refusal(
      `${key} must be a whole number, 1 or more.`,
      "Retention never keeps fewer than 1",
    );
  }
  const kind = key.slice("keep-".length);
  const keep = { ...defaultHostConfig("").keep, ...stored.keep, [kind]: Number(value) };
  await writeHostConfig(ctx, { ...stored, keep });
  step(ctx, "done", `${key} is ${value}`);
}
