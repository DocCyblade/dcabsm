import { execFile, spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { connect } from "node:tls";
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
  servedChain: (address, port, servername) =>
    new Promise((resolve, reject) => {
      // Trust is judged by `cert test`, so the handshake accepts whatever is served.
      const socket = connect({ host: address, port, servername, rejectUnauthorized: false });
      socket.setTimeout(5000, () => socket.destroy(new Error("timed out")));
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        const pems: string[] = [];
        let cert = socket.getPeerCertificate(true);
        while (cert?.raw && pems.length < 10) {
          const b64 = cert.raw
            .toString("base64")
            .match(/.{1,64}/g)!
            .join("\n");
          pems.push(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`);
          if (cert.issuerCertificate === cert) break;
          cert = cert.issuerCertificate;
        }
        socket.end();
        if (pems.length === 0) reject(new Error("no certificate was served"));
        else resolve(pems.join(""));
      });
    }),
  async resolve(hostname) {
    return (await lookup(hostname, { all: true })).map((a) => a.address);
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
