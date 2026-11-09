export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** A failure with an exit code. `hint` prints indented under the one-line message. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly code: number = EXIT_FAILURE,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A refusal before anything changed: exit 2. */
export function refusal(message: string, hint?: string): CliError {
  return new CliError(message, hint, EXIT_USAGE);
}

/** A command stopped at a prompt: printed as a plain line, exit 1. */
export class Cancelled extends Error {
  constructor(message = "Cancelled. Nothing changed.") {
    super(message);
    this.name = "Cancelled";
  }
}

export function formatError(err: CliError): string[] {
  const lines = [`error: ${err.message}`];
  if (err.hint) lines.push(`  ${err.hint}`);
  return lines;
}
