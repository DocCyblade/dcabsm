import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Builds the per-architecture tarballs (spec 11.1). The CI step and `scripts/package.ts` call this. */

export type Arch = "amd64" | "arm64";
/** nodejs.org's name for each architecture. */
const NODE_ARCH: Record<Arch, string> = { amd64: "x64", arm64: "arm64" };

export interface RunResult {
  status: number | null;
  stderr?: string;
}
export type Run = (cmd: string, args: string[]) => RunResult;
export type Fetch = (url: string) => Promise<Buffer>;

const realRun: Run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const realFetch: Fetch = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

function must(run: Run, cmd: string, args: string[]): void {
  const r = run(cmd, args);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr ?? ""}`);
}

/**
 * The wrapper at `bin/dcabsm`. `/usr/local/bin/dcabsm` links to it, so it resolves its own real
 * location. The bundle sits beside it, which is how src/main.ts finds the version directory.
 */
export const WRAPPER = `#!/bin/sh
here=$(dirname "$(readlink -f "$0")")
exec "$here/../node/bin/node" "$here/dcabsm.js" "$@"
`;

export interface AssembleOptions {
  version: string;
  arch: Arch;
  /** The output of `npm run build`: `dcabsm.js` and `share/`. */
  dist: string;
  /** An extracted official Node, already verified. */
  nodeDir: string;
  /** Node's release keys as a binary keyring. */
  keyring: string;
  outDir: string;
}

/** Lays out `dcabsm-<ver>-linux-<arch>/` and packs it. Returns the tarball's path. */
export async function assembleTarball(o: AssembleOptions): Promise<string> {
  const name = `dcabsm-${o.version}-linux-${o.arch}`;
  const work = await mkdtemp(join(tmpdir(), "dcabsm-assemble-"));
  try {
    const top = join(work, name);
    for (const d of ["bin", "node/bin", "share/bash-completion/completions"])
      await mkdir(join(top, d), { recursive: true });
    await copyFile(join(o.dist, "dcabsm.js"), join(top, "bin/dcabsm.js"));
    await writeFile(join(top, "bin/dcabsm"), WRAPPER, { mode: 0o755 });
    await chmod(join(top, "bin/dcabsm"), 0o755);
    const completion = "share/bash-completion/completions/dcabsm";
    await copyFile(join(o.dist, completion), join(top, completion));
    await copyFile(o.keyring, join(top, "share/node-release-keys.gpg"));
    await copyFile(join(o.nodeDir, "bin/node"), join(top, "node/bin/node"));
    await chmod(join(top, "node/bin/node"), 0o755);
    await copyFile(join(o.nodeDir, "LICENSE"), join(top, "node/LICENSE"));

    await mkdir(o.outDir, { recursive: true });
    const out = join(o.outDir, `${name}.tar.gz`);
    const gnu = realRun("tar", ["--version"]).status === 0 && isGnuTar();
    must(realRun, "tar", [
      ...(gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : []),
      "-czf",
      out,
      "-C",
      work,
      name,
    ]);
    return out;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function isGnuTar(): boolean {
  return /GNU tar/.test(spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "");
}

/** Writes `SHA256SUMS` next to the tarballs, in `sha256sum` format. Signing is never done here. */
export async function writeSums(dir: string, files: string[]): Promise<void> {
  let text = "";
  for (const file of files) {
    const hash = createHash("sha256")
      .update(await readFile(join(dir, file)))
      .digest("hex");
    text += `${hash}  ${file}\n`;
  }
  await writeFile(join(dir, "SHA256SUMS"), text);
}

export interface FetchNodeOptions {
  version: string;
  arch: Arch;
  dest: string;
  keyring: string;
  fetch?: Fetch;
  run?: Run;
}

/**
 * Downloads the official Node for `arch`, checks `SHASUMS256.txt` with `gpgv` against the keyring
 * and the tarball against that file, and extracts it. Returns the extracted directory.
 */
export async function fetchNode(o: FetchNodeOptions): Promise<string> {
  const get = o.fetch ?? realFetch;
  const run = o.run ?? realRun;
  const base = `https://nodejs.org/dist/v${o.version}`;
  const dir = `node-v${o.version}-linux-${NODE_ARCH[o.arch]}`;
  const file = `${dir}.tar.xz`;
  await mkdir(o.dest, { recursive: true });
  const sumsPath = join(o.dest, "SHASUMS256.txt");
  const sigPath = join(o.dest, "SHASUMS256.txt.sig");
  await writeFile(sumsPath, await get(`${base}/SHASUMS256.txt`));
  await writeFile(sigPath, await get(`${base}/SHASUMS256.txt.sig`));
  const check = run("gpgv", ["--keyring", o.keyring, sigPath, sumsPath]);
  if (check.status !== 0)
    throw new Error(`The signature on Node ${o.version}'s SHASUMS256.txt does not verify.`);

  const archive = await get(`${base}/${file}`);
  const line = (await readFile(sumsPath, "utf8"))
    .split("\n")
    .find((l) => l.trim().endsWith(`  ${file}`));
  const expected = line?.split(/\s+/)[0];
  if (!expected) throw new Error(`SHASUMS256.txt has no entry for ${file}.`);
  if (createHash("sha256").update(archive).digest("hex") !== expected)
    throw new Error(`${file} does not match its SHA-256 in SHASUMS256.txt.`);

  const archivePath = join(o.dest, file);
  await writeFile(archivePath, archive);
  must(run, "tar", ["-xJf", archivePath, "-C", o.dest]);
  return join(o.dest, dir);
}

export interface KeyringOptions {
  /** The checked-in armored keys. */
  armored: string;
  /** The fingerprints reviewed in git; each must be in `armored`. */
  list: string;
  out: string;
}

/** Turns the armored Node release keys into the binary keyring `gpgv` reads. */
export async function buildKeyring(o: KeyringOptions): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "dcabsm-gpg-"));
  try {
    const gpg = (args: string[]) =>
      spawnSync("gpg", ["--homedir", home, "--batch", "--no-tty", ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    const shown = gpg(["--with-colons", "--import-options", "show-only", "--import", o.armored]);
    if (shown.status !== 0) throw new Error(`gpg could not read ${o.armored}: ${shown.stderr}`);
    const have = new Set(
      shown.stdout
        .split("\n")
        .filter((l) => l.startsWith("fpr:"))
        .map((l) => l.split(":")[9]),
    );
    for (const fpr of (await readFile(o.list, "utf8")).split("\n").filter(Boolean)) {
      if (!have.has(fpr.trim())) throw new Error(`No key with fingerprint ${fpr} in ${o.armored}.`);
    }
    const imported = gpg(["--import", o.armored]);
    if (imported.status !== 0) throw new Error(`gpg import failed: ${imported.stderr}`);
    const exported = spawnSync("gpg", ["--homedir", home, "--batch", "--export"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (exported.status !== 0 || exported.stdout.length === 0)
      throw new Error("gpg --export produced no keyring.");
    await writeFile(o.out, exported.stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
