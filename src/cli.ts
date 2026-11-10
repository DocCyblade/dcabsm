import { exists } from "./fsutil.ts";
import type { Context } from "./context.ts";
import {
  Cancelled,
  CliError,
  EXIT_FAILURE,
  EXIT_OK,
  errorMessage,
  formatError,
  refusal,
} from "./errors.ts";
import { helpLines } from "./help.ts";
import { acquireLock } from "./lock.ts";
import { logChange } from "./log.ts";
import { hostNotices } from "./host/notices.ts";
import { checkLayout } from "./self/layout.ts";
import { findNoun, findVerb, type Verb } from "./table.ts";
import { versionLine } from "./version.ts";

function isChanging(verb: Verb, args: string[]): boolean {
  return typeof verb.changes === "function" ? verb.changes(args) : verb.changes === true;
}

/** Runs one command line and returns the exit code. */
export async function run(argv: string[], ctx: Context): Promise<number> {
  try {
    return await dispatch(argv, ctx);
  } catch (err) {
    if (err instanceof Cancelled) {
      ctx.io.out(err.message);
      return EXIT_FAILURE;
    }
    if (err instanceof CliError) {
      for (const line of formatError(err)) ctx.io.err(line);
      return err.code;
    }
    ctx.io.err(`error: ${errorMessage(err)}`);
    return EXIT_FAILURE;
  }
}

async function dispatch(argv: string[], ctx: Context): Promise<number> {
  const [first, second, ...rest] = argv;

  if (first === undefined || first === "help" || first === "--help") {
    for (const line of helpLines()) ctx.io.out(line);
    return EXIT_OK;
  }
  if (first === "--version") {
    ctx.io.out(versionLine());
    return EXIT_OK;
  }

  const noun = findNoun(first);
  if (!noun) throw refusal(`Unknown command: ${first}.`, "See the list: dcabsm help");
  const verb = second === undefined ? undefined : findVerb(noun, second);
  if (!verb) {
    const names = noun.verbs
      .filter((v) => !v.hidden)
      .map((v) => v.name)
      .join(", ");
    throw refusal(
      second === undefined
        ? `Say what to do with ${noun.name}.`
        : `Unknown command: ${noun.name} ${second}.`,
      `The ${noun.name} commands are: ${names}. See the list: dcabsm help`,
    );
  }

  const commandLine = `dcabsm ${argv.join(" ")}`;
  if (!verb.noRoot && ctx.uid !== 0) {
    throw refusal("dcabsm must run as root.", `Try: sudo ${commandLine}`);
  }
  if (!verb.beforeSetup && !(await exists(ctx.paths.hostConfig))) {
    throw refusal("This Host is not set up yet.", "Run: sudo dcabsm host setup");
  }

  // Self-update's own steps and `self version` pass a Host on another layout (spec 11.4).
  const selfStep = noun.name === "self" && ["update", "migrate", "version"].includes(verb.name);
  if (!selfStep) await checkLayout(ctx);

  const args = rest;
  if (!(noun.name === "host" && verb.name === "setup"))
    await hostNotices(ctx, noun.name === "host" && verb.name === "doctor");
  const handler = verb.run;
  if (!handler) {
    throw new CliError(`${noun.name} ${verb.name} is not built yet.`, "See: dcabsm help");
  }

  if (!isChanging(verb, args)) {
    return (await handler({ ctx, args })) ?? EXIT_OK;
  }

  const name = `${noun.name} ${verb.name}`;
  const release = await acquireLock(ctx, commandLine).catch((err: unknown) => {
    // Doctor's exit 1 also means warnings, so say this one is only the lock.
    if (name !== "host doctor" || !(err instanceof CliError)) throw err;
    throw new CliError(
      `${err.message} host doctor --fix did not run: this is the lock, not a problem on the Host.`,
      err.hint,
      err.code,
    );
  });
  let code: void | number;
  try {
    code = await handler({ ctx, args });
  } catch (err) {
    await logChange(ctx, name, err instanceof Cancelled ? "cancelled" : "failed");
    throw err;
  } finally {
    await release();
  }
  await logChange(ctx, name, "ok");
  return code ?? EXIT_OK;
}
