import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCommand } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, refusal } from "../errors.ts";
import { exists } from "../fsutil.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { accountOf, instanceDir, logicalDir, refuseIfChanging, requireInstance } from "./record.ts";

const accountDbPath = (ctx: Context, name: string): string =>
  join(instanceDir(ctx, name), "server-files", "account.sqlite");

/** The login methods Actual has stored (its `auth` table); empty when the database can't be read. */
function loginMethods(path: string): string[] {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db
        .prepare("SELECT method FROM auth")
        .all()
        .map((row) => String(row.method));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** `instance reset-password <name>` (spec 4.10) */
export async function instanceResetPassword({ ctx, args }: Invocation): Promise<void> {
  const { positionals } = parseCommand(args, {});
  if (positionals.length !== 1) {
    throw refusal("Give one Instance name.", "Usage: dcabsm instance reset-password <name>");
  }
  const name = positionals[0]!;
  const record = await requireInstance(ctx, name);
  await refuseIfChanging(ctx, name);

  if (!ctx.io.interactive || !ctx.runner.inherit) {
    throw refusal(
      "Password reset needs a terminal: you type the new password straight into Actual.",
    );
  }
  // Actual creates account.sqlite when the server first starts, and its reset tool can't run before.
  if (!(await exists(accountDbPath(ctx, name)))) {
    throw refusal(
      `${name} has never started, so Actual has no password to reset yet.`,
      `Start it and set the password in the browser: https://${record.hostname}`,
    );
  }
  const methods = loginMethods(accountDbPath(ctx, name));
  if (methods.includes("openid") && !methods.includes("password")) {
    throw refusal(
      `${name} signs in with OpenID only, so Actual has no password to change.`,
      "Reset passwords with your OpenID provider.",
    );
  }

  const account = accountOf(name);
  const dir = logicalDir(name);
  ctx.io.out(
    `Handing the terminal to Actual's reset tool as ${account}. DCABSM never sees the password.`,
  );
  ctx.io.out("If you paste a password, press Enter separately.");
  // `runuser` keeps the caller's environment, so the unit's own variables are set here (spec 4.5).
  const code = await ctx.runner.inherit("runuser", [
    "-u",
    account,
    "--",
    "env",
    `PATH=${dir}/release/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    `ACTUAL_DATA_DIR=${dir}/data`,
    "NODE_ENV=production",
    `${dir}/release/node_modules/.bin/actual-server`,
    "--config",
    `${dir}/config/config.json`,
    "--reset-password",
  ]);
  if (code !== 0) {
    throw new CliError(
      `Actual's reset tool exited with ${code}. The password was not changed.`,
      `See: dcabsm instance logs ${name}`,
    );
  }
  step(ctx, "done", "Anyone signed in has to sign in again with the new password.");
}
