import type { Context } from "../context.ts";
import { step } from "../output.ts";

/** What to do before a planned restore (spec 7.6). Shown before the System Admin confirms. */
export function beforeRestoreAdvice(ctx: Context, since: string): void {
  step(
    ctx,
    "warn",
    `Everything changed since ${since} is lost, on the server and on every device.`,
  );
  step(
    ctx,
    "warn",
    "Here be dragons: Actual doesn't document restoring a server from its files. This is DCABSM's own approach.",
  );
  step(ctx, "info", "Open Actual on every device and let it sync before you go on.");
}

/** What to do on every device afterwards (spec 7.6). Shown after every restore that regrouped. */
export function deviceAdvice(ctx: Context): void {
  ctx.io.out("");
  ctx.io.out("On every device");
  step(ctx, "info", 'Actual shows "Syncing has been reset on this cloud file". Click Revert.');
  step(
    ctx,
    "info",
    'Never click "upload this file to be the latest version": it undoes the restore.',
  );
  step(
    ctx,
    "info",
    "Unsynced changes on a device are lost. A budget created after the backup comes back if a device registers it.",
  );
  step(
    ctx,
    "info",
    "Here be dragons: tested in Chromium only. Firefox, Safari and mobile are untested. See docs/cli.md#restore.",
  );
}
