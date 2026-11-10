import type { Paths } from "./paths.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Seam one: every external program (`systemctl`, `nginx`, `logger`, ...). */
export interface CommandRunner {
  run(command: string, args: string[]): Promise<RunResult>;
  /** Runs with the terminal attached (`instance logs -f`); resolves to the exit code. Tests leave it out. */
  inherit?(command: string, args: string[]): Promise<number>;
}

export interface FetchResult {
  status: number;
  body: Uint8Array;
}

/** Seam two: every network request. */
export interface Fetcher {
  fetch(url: string): Promise<FetchResult>;
  /** The certificate chain, as PEM and leaf first, that a TLS server hands out for `servername`. */
  servedChain(address: string, port: number, servername: string): Promise<string>;
  /** The addresses a hostname resolves to; throws when it does not resolve. */
  resolve(hostname: string): Promise<string[]>;
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
  /** The CPU architecture in Node's spelling: `x64` or `arm64`. */
  arch: string;
  /** Environment variables, such as the `DCABSM_ALLOW_*` overrides. */
  env: Record<string, string | undefined>;
  now(): Date;
}
