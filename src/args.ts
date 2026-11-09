import { parseArgs } from "node:util";
import { errorMessage, refusal } from "./errors.ts";

type Spec = Record<string, { type: "boolean" | "string" }>;

type Parsed<S extends Spec> = {
  [K in keyof S]?: S[K]["type"] extends "boolean" ? boolean : string;
};

/** Parses a verb's flags. An unknown flag or extra argument is a usage error (exit 2). */
export function parseFlags<S extends Spec>(args: string[], spec: S): Parsed<S> {
  try {
    const { values } = parseArgs({ args, options: spec, allowPositionals: false, strict: true });
    return values as Parsed<S>;
  } catch (err) {
    throw refusal(errorMessage(err), "See the list: dcabsm help");
  }
}
