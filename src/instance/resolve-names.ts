import type { Context } from "../context.ts";
import { refusal } from "../errors.ts";
import { instanceNames } from "./record.ts";

export interface ResolveOptions {
  /** The `Usage:` line shown with each refusal. */
  usage: string;
  /** When no names were given, mean all Instances instead of refusing. */
  allowEmpty?: boolean;
  /** The hint when there are no Instances; defaults to `usage`. */
  noInstancesHint?: string;
}

/** Resolves `<names>|--all` to Instance names, refusing on both, on none, or on an empty Host. */
export async function resolveInstanceNames(
  ctx: Context,
  names: string[],
  all: boolean | undefined,
  { usage, allowEmpty = false, noInstancesHint }: ResolveOptions,
): Promise<string[]> {
  if (all && names.length > 0) throw refusal("Give Instance names or --all, not both.", usage);
  const everyone = all || (allowEmpty && names.length === 0);
  const list = everyone ? await instanceNames(ctx) : [...new Set(names)];
  if (list.length === 0) {
    throw refusal(
      everyone ? "There are no Instances." : "Give at least one Instance name, or --all.",
      everyone ? (noInstancesHint ?? usage) : usage,
    );
  }
  return list;
}
