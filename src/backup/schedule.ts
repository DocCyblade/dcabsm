import { refusal } from "../errors.ts";
import { checkName, refuseIfChanging, requireInstance, writeRecord } from "../instance/record.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";

/** `backup schedule <name> on|off` (spec 8.2) */
export async function backupSchedule({ ctx, args }: Invocation): Promise<void> {
  const usage = "Usage: dcabsm backup schedule <name> on|off";
  const [name, state, ...extra] = args;
  if (name === undefined || (state !== "on" && state !== "off") || extra.length > 0) {
    throw refusal("Give an Instance name and on or off.", usage);
  }
  checkName(name);
  const record = await requireInstance(ctx, name);
  await refuseIfChanging(ctx, name);
  await writeRecord(ctx, name, { ...record, scheduledBackups: state === "on" });
  step(
    ctx,
    "done",
    state === "on"
      ? `Scheduled backups on for ${name}.`
      : `Scheduled backups off for ${name}. Retention still prunes its old backups.`,
  );
}
