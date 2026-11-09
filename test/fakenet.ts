import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchResult, RunResult } from "../src/context.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

export interface NodeEntry {
  version: string;
  lts: string | false;
}

/** npm, nodejs.org, `gpgv`, `tar` and the Node runtime, as the two faked seams see them. */
export interface FakeNet {
  /** Version → `engines.node` ("" for none). A version missing here is not on npm. */
  actual: Record<string, string>;
  latest: string;
  index: NodeEntry[];
  /** The newest stable DCABSM on GitHub, without the `v`. */
  dcabsmLatest: string;
  /** Node's release schedule: `v<major>` → end-of-life date. */
  nodeEnd: Record<string, string>;
  /** Hosts that cannot be reached: a fetch to them throws. */
  down: string[];
  /** Make `gpgv` reject the signature. */
  badSignature: boolean;
  /** Serve a tarball that does not match SHASUMS256.txt. */
  badChecksum: boolean;
  /** Make the native-module check fail. */
  nativeFails: boolean;
  /** Directories whose native-module check fails, whatever `nativeFails` says. */
  brokenDirs: string[];
  /** Everything fetched, in order. */
  fetched: string[];
  fetch(url: string): FetchResult | undefined;
  run(command: string, args: string[]): RunResult | undefined;
}

const enc = (text: string) => new TextEncoder().encode(text);
const json = (value: unknown): FetchResult => ({ status: 200, body: enc(JSON.stringify(value)) });
const missing: FetchResult = { status: 404, body: enc("not found") };

export function tarballName(version: string, arch = "x64"): string {
  return `node-v${version}-linux-${arch}.tar.xz`;
}

export function fakeNet(overrides: Partial<FakeNet> = {}): FakeNet {
  const net: FakeNet = {
    actual: { "26.10.0": ">=20", "26.11.0": ">=22", "26.11.1": ">=22" },
    latest: "26.11.1",
    index: [
      { version: "v25.1.0", lts: false },
      { version: "v24.11.1", lts: "Krypton" },
      { version: "v24.11.0", lts: "Krypton" },
      { version: "v22.21.0", lts: "Jod" },
      { version: "v20.19.5", lts: "Iron" },
    ],
    dcabsmLatest: "1.3.0",
    nodeEnd: { v20: "2026-04-30", v22: "2027-04-30", v24: "2028-04-30" },
    down: [],
    badSignature: false,
    badChecksum: false,
    nativeFails: false,
    brokenDirs: [],
    fetched: [],
    ...overrides,
    fetch(url) {
      net.fetched.push(url);
      if (net.down.includes(new URL(url).host)) return undefined;
      if (url === "https://api.github.com/repos/DocCyblade/dcabsm/releases/latest") {
        return json({ tag_name: `v${net.dcabsmLatest}` });
      }
      if (url === "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json") {
        return json(
          Object.fromEntries(Object.entries(net.nodeEnd).map(([k, end]) => [k, { end }])),
        );
      }
      const reg = /^https:\/\/registry\.npmjs\.org\/@actual-app%2fsync-server\/(.+)$/.exec(url);
      if (reg) {
        const v = reg[1] === "latest" ? net.latest : reg[1]!;
        const engines = net.actual[v];
        if (engines === undefined) return missing;
        return json({
          name: "@actual-app/sync-server",
          version: v,
          engines: engines ? { node: engines } : {},
        });
      }
      if (url === "https://nodejs.org/dist/index.json") return json(net.index);
      const dist = /^https:\/\/nodejs\.org\/dist\/v([\d.]+)\/(.+)$/.exec(url);
      if (dist) {
        const [, v, file] = dist as unknown as [string, string, string];
        if (!net.index.some((e) => e.version === `v${v}`)) return missing;
        const tar = (arch: string) =>
          net.badChecksum ? enc("tampered") : enc(`tarball ${tarballName(v, arch)}`);
        if (file === "SHASUMS256.txt") {
          const lines = ["x64", "arm64"].map(
            (a) =>
              `${createHash("sha256")
                .update(enc(`tarball ${tarballName(v, a)}`))
                .digest("hex")}  ${tarballName(v, a)}`,
          );
          return { status: 200, body: enc(`${lines.join("\n")}\n`) };
        }
        if (file === "SHASUMS256.txt.sig") return { status: 200, body: enc("signature") };
        for (const a of ["x64", "arm64"])
          if (file === tarballName(v, a)) return { status: 200, body: tar(a) };
        return missing;
      }
      return undefined;
    },
    run(command, args) {
      if (command === "gpgv") {
        return net.badSignature ? { code: 2, stdout: "", stderr: "gpgv: BAD signature" } : ok();
      }
      if (command === "tar") {
        const dest = args[args.indexOf("-C") + 1]!;
        mkdirSync(join(dest, "bin"), { recursive: true });
        writeFileSync(join(dest, "bin", "node"), "node", { mode: 0o755 });
        writeFileSync(join(dest, "bin", "npm"), "npm", { mode: 0o755 });
        return ok();
      }
      if (command === "env" && args[0]?.startsWith("PATH=") && args[1]?.endsWith("/bin/npm")) {
        const prefix = args[args.indexOf("--prefix") + 1]!;
        const spec = args[args.length - 1]!;
        const version = spec.slice(spec.lastIndexOf("@") + 1);
        const pkg = join(prefix, "node_modules", "@actual-app", "sync-server");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ version }));
        writeFileSync(
          join(prefix, "package.json"),
          JSON.stringify({ dependencies: { "@actual-app/sync-server": version } }),
        );
        writeFileSync(join(prefix, "package-lock.json"), "{}");
        return ok();
      }
      if (command.endsWith("/bin/node") && args[0] === "-e") {
        return net.nativeFails || net.brokenDirs.some((d) => args[2]!.startsWith(d))
          ? { code: 1, stdout: "", stderr: "Error: Cannot find module 'better-sqlite3'" }
          : ok();
      }
      return undefined;
    },
  };
  return net;
}
