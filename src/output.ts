import type { Context } from "./context.ts";

/** Step marks from docs/cli.md › Output. */
const marks = { done: "✓", failed: "✗", warn: "!", info: "·" } as const;

export function step(ctx: Context, mark: keyof typeof marks, text: string): void {
  ctx.io.out(`  ${marks[mark]} ${text}`);
}
