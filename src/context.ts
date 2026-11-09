import type { Paths } from "./paths.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Seam one: every external program (`systemctl`, `nginx`, `logger`, ...). */
export interface CommandRunner {
  run(command: string, args: string[]): Promise<RunResult>;
}

export interface FetchResult {
  status: number;
  body: Uint8Array;
}

/** Seam two: every network request. */
export interface Fetcher {
  fetch(url: string): Promise<FetchResult>;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Whether a person can answer a prompt. */
  interactive: boolean;
  ask(question: string): Promise<string>;
}

export interface Context {
  paths: Paths;
  runner: CommandRunner;
  fetcher: Fetcher;
  io: Io;
  /** The effective user id; 0 is root. */
  uid: number;
}
