import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner, Context, Fetcher, Io, RunResult } from "../src/context.ts";
import { pathsUnder } from "../src/paths.ts";

export interface Harness {
  ctx: Context;
  out: string[];
  err: string[];
  calls: Array<{ command: string; args: string[] }>;
  answers: string[];
  asked: string[];
  root: string;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  uid?: number;
  interactive?: boolean;
  answers?: string[];
  setUp?: boolean;
  runner?: (command: string, args: string[]) => RunResult;
}

/** A Context on a temporary root with the faked command runner and fetcher (spec 13.1). */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dcabsm-test-"));
  const paths = pathsUnder(root);
  if (opts.setUp ?? true) {
    await mkdir(dirname(paths.hostConfig), { recursive: true });
    await writeFile(paths.hostConfig, "{}");
  }

  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = [];
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];

  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return opts.runner?.(command, args) ?? { code: 0, stdout: "", stderr: "" };
    },
  };
  const fetcher: Fetcher = {
    async fetch(url) {
      throw new Error(`unexpected fetch: ${url}`);
    },
  };
  const io: Io = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    interactive: opts.interactive ?? false,
    async ask(question) {
      asked.push(question);
      return answers.shift() ?? "";
    },
  };

  return {
    ctx: { paths, runner, fetcher, io, uid: opts.uid ?? 0 },
    out,
    err,
    calls,
    answers,
    asked,
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
