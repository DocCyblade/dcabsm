import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner, Context, Fetcher, Io, RunResult } from "../src/context.ts";
import { makeWritable } from "../src/fsutil.ts";
import { pathsUnder } from "../src/paths.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";

export const DEBIAN_13 = `PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION_CODENAME=trixie
ID=debian
`;

export const UBUNTU_2404 = `PRETTY_NAME="Ubuntu 24.04.2 LTS"
NAME="Ubuntu"
VERSION_ID="24.04"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
`;

export interface Harness {
  ctx: Context;
  out: string[];
  err: string[];
  calls: Array<{ command: string; args: string[] }>;
  answers: string[];
  asked: string[];
  root: string;
  net: FakeNet;
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  uid?: number;
  interactive?: boolean;
  answers?: string[];
  setUp?: boolean;
  arch?: string;
  env?: Record<string, string | undefined>;
  /** The contents of /etc/os-release. Default: Debian 13. Null: no file. */
  osRelease?: string | null;
  /** The faked npm, nodejs.org, gpgv, tar and Node. */
  net?: FakeNet;
  runner?: (command: string, args: string[]) => RunResult;
}

/** A Context on a temporary root with the faked command runner and fetcher (spec 13.1). */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dcabsm-test-"));
  const paths = pathsUnder(root);
  const osRelease = opts.osRelease === undefined ? DEBIAN_13 : opts.osRelease;
  if (osRelease !== null) {
    await mkdir(dirname(paths.osRelease), { recursive: true });
    await writeFile(paths.osRelease, osRelease);
  }
  if (opts.setUp ?? true) {
    await mkdir(dirname(paths.hostConfig), { recursive: true });
    await writeFile(paths.hostConfig, "{}");
  }

  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = [];
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];

  const net = opts.net ?? fakeNet();
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push({ command, args });
      return (
        net.run(command, args) ??
        opts.runner?.(command, args) ?? { code: 0, stdout: "", stderr: "" }
      );
    },
  };
  const fetcher: Fetcher = {
    async fetch(url) {
      const res = net.fetch(url);
      if (res) return res;
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
    ctx: {
      paths,
      runner,
      fetcher,
      io,
      uid: opts.uid ?? 0,
      arch: opts.arch ?? "x64",
      env: opts.env ?? {},
      now: () => new Date("2026-11-09T12:00:00Z"),
    },
    out,
    err,
    calls,
    answers,
    asked,
    root,
    net,
    cleanup: async () => {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}
