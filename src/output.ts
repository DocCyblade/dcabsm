import type { Context } from "./context.ts";

/** Step marks from docs/cli.md › Output. */
const marks = { done: "✓", failed: "✗", warn: "!", info: "·" } as const;

/** `2026-11-07 03:30 UTC` from a Date or an ISO time such as a manifest's `2026-11-07T03:30:00Z`. */
export function formatTime(time: Date | string): string {
  const iso = typeof time === "string" ? time : time.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function step(ctx: Context, mark: keyof typeof marks, text: string): void {
  ctx.io.out(`  ${marks[mark]} ${text}`);
}
