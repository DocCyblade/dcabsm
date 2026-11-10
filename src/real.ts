import { execFile, spawn } from "node:child_process";
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
  inherit: (command, args) =>
    new Promise((resolve) => {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 0));
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
