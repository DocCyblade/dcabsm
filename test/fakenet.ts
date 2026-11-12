import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  /** Signed DCABSM versions on GitHub: the layout each expects, and the files its tarball holds besides `bin/dcabsm`. */
  dcabsm: Record<
    string,
    {
      layout: number;
      files?: Record<string, string>;
      migrateFails?: boolean;
      refreshFails?: boolean;
    }
  >;
  /** Make the downloaded DCABSM tarball differ from the one SHA256SUMS lists. */
  dcabsmBadChecksum: boolean;
  /** What `self refresh` of a downloaded version prints. */
  refreshOutput: string;
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
  /** Whether a started Instance's `/health` answers UP. */
  serverUp: boolean;
  /** The version a started Instance's `/info` reports. */
  serverVersion: string;
  /** Make `tar` fail when it creates an archive. */
  tarCreateFails: boolean;
  /** Answer every request with a 503. */
  offline: boolean;
  /** What a TLS connection to 127.0.0.1:443 is served for a hostname: PEM chains, or undefined for no answer. */
  served: Record<string, string | undefined>;
  /** Hostname → addresses it resolves to. A hostname missing here does not resolve. */
  dns: Record<string, string[]>;
  /** Everything fetched, in order. */
  fetched: string[];
  fetch(url: string): FetchResult | undefined;
  run(command: string, args: string[]): RunResult | undefined;
}

const fail = (stderr: string): RunResult => ({ code: 2, stdout: "", stderr });

interface FakeArchive {
  members: string[];
  manifest: string;
  /** Every directory and file under the members, so extracting can bring them back. */
  dirs?: string[];
  files?: Record<string, string>;
  /** Extra members a hostile archive would hold, as `tar -tv` shows them: `l` for a link, `p` for a pipe, and so on. */
  extra?: Array<{ name: string; type: string; perms?: string }>;
}

/** Records the tree under `dir/rel` into the archive. */
function snapshot(dir: string, rel: string, into: Required<Pick<FakeArchive, "dirs" | "files">>) {
  const full = join(dir, rel);
  let isDir: boolean;
  try {
    isDir = statSync(full).isDirectory();
  } catch {
    return;
  }
  if (!isDir) {
    // latin1 keeps every byte, so SQLite files survive the JSON round trip.
    into.files[rel] = readFileSync(full, "latin1");
    return;
  }
  into.dirs.push(rel);
  for (const child of readdirSync(full)) snapshot(dir, join(rel, child), into);
}

function readFakeArchive(path: string): FakeArchive | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FakeArchive;
  } catch {
    return undefined;
  }
}

/** `tar -czf <file> [--flag ...] (-C <dir> <member>...)...`: the file holds the member names and the manifest. */
function fakeTarCreate(net: { tarCreateFails: boolean }, args: string[]): RunResult {
  if (net.tarCreateFails) return fail("tar: No space left on device");
  const members: string[] = [];
  const tree = { dirs: [] as string[], files: {} as Record<string, string> };
  let dir = "";
  let manifest = "";
  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-C") dir = args[++i]!;
    else if (!arg.startsWith("-")) {
      members.push(arg);
      if (arg === "manifest.json") manifest = readFileSync(join(dir, arg), "utf8");
      else snapshot(dir, arg, tree);
    }
  }
  writeFileSync(args[1]!, JSON.stringify({ members, manifest, ...tree }));
  return ok();
}

function readFakeJson(path: string): { dcabsmFiles?: Record<string, string> } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A downloaded `bin/dcabsm`: it knows its version from where it sits, and its layout from the fake. */
function fakeDcabsm(net: FakeNet, command: string, args: string[]): RunResult {
  const m = /^(.*)\/opt\/dcabsm\/(?:\.installing-)?([^/]+)\/bin\/dcabsm$/.exec(command);
  const spec = m ? net.dcabsm[m[2]!] : undefined;
  if (!m || !spec) return fail("no such DCABSM");
  const [, root, version] = m as unknown as [string, string, string];
  if (args[0] === "--version") return ok(`DCABSM ${version} (layout ${spec.layout})\n`);
  const etc = join(root || "/", "etc/dcabsm/dcabsm.json");
  if (args.join(" ") === "self migrate") {
    if (spec.migrateFails) {
      writeFileSync(etc, JSON.stringify({ layout: spec.layout, half: "migrated" }));
      writeFileSync(join(dirname(etc), "new-file"), "half-written");
      return fail("error: migration to layout failed: disk on fire");
    }
    const config = JSON.parse(readFileSync(etc, "utf8"));
    writeFileSync(etc, JSON.stringify({ ...config, layout: spec.layout, layoutSince: version }));
    return ok();
  }
  if (args.join(" ") === "self refresh") {
    return spec.refreshFails ? fail("error: refresh broke: nginx on fire") : ok(net.refreshOutput);
  }
  return fail("unexpected");
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
    dcabsm: { "1.1.0": { layout: 1 }, "1.3.0": { layout: 1 }, "2.0.0": { layout: 2 } },
    dcabsmBadChecksum: false,
    refreshOutput: "",
    nodeEnd: { v20: "2026-04-30", v22: "2027-04-30", v24: "2028-04-30" },
    down: [],
    badSignature: false,
    badChecksum: false,
    nativeFails: false,
    brokenDirs: [],
    serverUp: true,
    serverVersion: "26.11.1",
    offline: false,
    tarCreateFails: false,
    served: {},
    dns: {},
    fetched: [],
    ...overrides,
    fetch(url) {
      net.fetched.push(url);
      if (net.offline) return { status: 503, body: enc("offline") };
      if (net.down.includes(new URL(url).host)) return undefined;
      if (url === "https://api.github.com/repos/DocCyblade/dcabsm/releases/latest") {
        return json({ tag_name: `v${net.dcabsmLatest}` });
      }
      const gh =
        /^https:\/\/github\.com\/DocCyblade\/dcabsm\/releases\/download\/v([^/]+)\/(.+)$/.exec(url);
      if (gh) {
        const [, v, file] = gh as unknown as [string, string, string];
        const spec = net.dcabsm[v];
        if (!spec) return missing;
        const tarName = `dcabsm-${v}-linux-amd64.tar.gz`;
        const tarball = enc(JSON.stringify({ dcabsmFiles: spec.files ?? {} }));
        if (file === tarName)
          return { status: 200, body: net.dcabsmBadChecksum ? enc("tampered") : tarball };
        if (file === "SHA256SUMS") {
          const sum = createHash("sha256").update(tarball).digest("hex");
          return { status: 200, body: enc(`${sum}  ${tarName}\n`) };
        }
        if (file === "SHA256SUMS.sig") return { status: 200, body: enc("signature") };
        return missing;
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
      const local = /^http:\/\/127\.0\.0\.1:\d+\/(health|info)$/.exec(url);
      if (local) {
        if (!net.serverUp) return { status: 502, body: enc("down") };
        return local[1] === "health"
          ? json({ status: "UP" })
          : json({ build: { name: "@actual-app/sync-server", version: net.serverVersion } });
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
      if (command.endsWith("/bin/dcabsm")) return fakeDcabsm(net, command, args);
      if (command === "tar" && args[0] === "-xzf") {
        const body = readFakeJson(args[1]!);
        if (body?.dcabsmFiles) {
          const dest = args[args.indexOf("-C") + 1]!;
          const files = { "bin/dcabsm": "wrapper", ...body.dcabsmFiles };
          for (const [rel, text] of Object.entries(files)) {
            mkdirSync(dirname(join(dest, rel)), { recursive: true });
            writeFileSync(join(dest, rel), text, { mode: 0o755 });
          }
          return ok();
        }
      }
      if (command === "tar" && args[0] === "-czf") return fakeTarCreate(net, args);
      if (command === "tar" && args[0] === "-xzf" && readFakeArchive(args[1]!)?.members) {
        const archive = readFakeArchive(args[1]!)!;
        const dest = args[args.indexOf("-C") + 1]!;
        const wanted = args.slice(args.indexOf("-C") + 2);
        const under = (p: string) => wanted.some((w) => p === w || p.startsWith(`${w}/`));
        for (const d of archive.dirs ?? [])
          if (under(d)) mkdirSync(join(dest, d), { recursive: true });
        for (const [rel, text] of Object.entries(archive.files ?? {})) {
          if (under(rel)) writeFileSync(join(dest, rel), text, "latin1");
        }
        return wanted.every((w) => archive.members.includes(w))
          ? ok()
          : fail("tar: not found in archive");
      }
      if (command === "tar" && (args[0] === "-tzf" || args[0] === "-tvzf")) {
        const archive = readFakeArchive(args[1]!);
        if (!archive) return fail("not a gzip file");
        const entries = [
          ...archive.members.map((name) => ({
            name,
            type: "-",
            perms: undefined as string | undefined,
          })),
          ...(archive.extra ?? []),
        ];
        const verbose = args[0] === "-tvzf";
        const lines = entries.map((e) =>
          verbose ? `${e.type}${e.perms ?? "rw-r--r--"} 0/0 0 2026-11-09 12:00 ${e.name}` : e.name,
        );
        return ok(lines.join("\n") + "\n");
      }
      if (command === "tar" && args[0] === "-xzOf") {
        const archive = readFakeArchive(args[1]!);
        return archive?.members.includes(args[2]!) ? ok(archive.manifest) : fail("not found");
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
