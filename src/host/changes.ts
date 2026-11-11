import type { Context } from "../context.ts";
import { changeDetail, instanceNames, isChanging } from "../instance/record.ts";
import type { Check, CheckResult } from "./checks.ts";

/** Instances with a `.changing-release` marker (spec 6.6, 10.6). Rolling back is how they are finished. */
async function unfinishedChanges(ctx: Context): Promise<CheckResult[]> {
  const found: CheckResult[] = [];
  for (const name of await instanceNames(ctx)) {
    if (!(await isChanging(ctx, name))) continue;
    found.push({
      kind: "problem",
      severity: "fail",
      message: `${name} has an unfinished Release change${await changeDetail(ctx, name)}: run sudo dcabsm instance rollback ${name}`,
    });
  }
  return found.length > 0
    ? found
    : [{ kind: "pass", label: "No Instance has an unfinished Release change" }];
}

export const changeChecks: Check[] = [{ id: "unfinished-changes", run: unfinishedChanges }];
