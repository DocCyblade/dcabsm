import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { CommandRunner, Fetcher, Io } from "./context.ts";

export const realRunner: CommandRunner = {
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      });
    }),
};

export const realFetcher: Fetcher = {
  async fetch(url) {
    const res = await fetch(url);
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  },
};

export function realIo(): Io {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}
