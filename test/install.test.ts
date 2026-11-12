import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleTarball } from "../scripts/tarball.ts";

// install.sh runs under bash on a temporary root. Only curl, gpgv, uname and id are stubbed on PATH;
// tar, mv, ln and the checksum tool are the real ones. Tests assert on the files left behind.

const SCRIPT = join(import.meta.dirname, "../install.sh");
const FINGERPRINT = "ABCD ABCD ABCD ABCD ABCD  ABCD ABCD ABCD ABCD ABCD";
const KEYRING = "fake-binary-keyring";

let dir: string;
let root: string;
let fixtures: string;
let bin: string;
let log: string;
let script: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dcabsm-install-"));
  root = join(dir, "root");
  fixtures = join(dir, "release");
  bin = join(dir, "bin");
  log = join(dir, "log");
  for (const d of [root, fixtures, bin, log]) await mkdir(d, { recursive: true });
  await mkdir(join(root, "etc"), { recursive: true });
  await writeOsRelease("debian", "13");

  // The script under test, with the release-time placeholders filled in.
  const text = await readFile(SCRIPT, "utf8");
  script = join(dir, "install.sh");
  await writeFile(
    script,
    text
      .replace(/^GITHUB_OWNER=.*$/m, 'GITHUB_OWNER="octo"')
      .replace(/^KEY_FINGERPRINT=.*$/m, `KEY_FINGERPRINT="${FINGERPRINT}"`)
      .replace(
        /^KEY_KEYRING_B64=.*$/m,
        `KEY_KEYRING_B64="${Buffer.from(KEYRING).toString("base64")}"`,
      ),
  );

  await stub(
    "curl",
    `echo "$@" >> "${log}/curl"
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --proto) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
case "$url" in
  */releases/latest) printf '{"tag_name": "v1.2.0"}' > "$out";;
  *) cp "${fixtures}/$(basename "$url")" "$out" || exit 22;;
esac`,
  );
  await stub(
    "gpgv",
    `echo "$@" >> "${log}/gpgv"
cp "$2" "${log}/keyring"
[ ! -e "${dir}/gpgv-fails" ]`,
  );
  await stub("uname", `case "$1" in -s) echo Linux;; -m) echo "$FAKE_MACHINE";; esac`);
  await stub("id", `echo "\${FAKE_UID:-0}"`);
  await stub("apt-get", `echo "$@" >> "${log}/apt"`);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function stub(name: string, body: string) {
  await writeFile(join(bin, name), `#!/bin/bash\n${body}\n`);
  await chmod(join(bin, name), 0o755);
}
const writeOsRelease = (id: string, version: string) =>
  writeFile(join(root, "etc/os-release"), `ID=${id}\nVERSION_ID="${version}"\n`);

/** Puts a tarball and SHA256SUMS in the fake release, the way CI and the author leave them. */
async function release(version: string, arch: "amd64" | "arm64") {
  const src = join(dir, "src", arch);
  await mkdir(join(src, "dist/share/bash-completion/completions"), { recursive: true });
  await writeFile(join(src, "dist/dcabsm.js"), "js");
  await writeFile(join(src, "dist/share/bash-completion/completions/dcabsm"), "complete x\n");
  await mkdir(join(src, "node/bin"), { recursive: true });
  await writeFile(join(src, "node/bin/node"), "node");
  await writeFile(join(src, "node/LICENSE"), "l");
  await writeFile(join(src, "keys.gpg"), "k");
  const tarball = await assembleTarball({
    version,
    arch,
    dist: join(src, "dist"),
    nodeDir: join(src, "node"),
    keyring: join(src, "keys.gpg"),
    outDir: fixtures,
  });
  const name = tarball.split("/").pop()!;
  const hash = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await writeFile(join(fixtures, "SHA256SUMS"), `${hash}  ${name}\n`);
  await writeFile(join(fixtures, "SHA256SUMS.sig"), "sig");
}

function install(args: string[] = [], input = "", env: Record<string, string> = {}) {
  const r = spawnSync("bash", [script, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env["PATH"]}`,
      DCABSM_ROOT: root,
      FAKE_MACHINE: "x86_64",
      ...env,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );
const logged = (name: string) => readFile(join(log, name), "utf8").catch(() => "");

describe("install.sh", () => {
  it("installs a verified tarball, links the command and installs the completion script", async () => {
    await release("1.2.0", "amd64");
    const r = install([], "y\n");
    expect(r.code, r.out).toBe(0);

    const ver = join(root, "opt/dcabsm/1.2.0");
    expect(await readFile(join(ver, "bin/dcabsm.js"), "utf8")).toBe("js");
    expect(await exists(join(ver, "bin/dcabsm"))).toBe(true);
    expect(await readlink(join(root, "usr/local/bin/dcabsm"))).toBe("/opt/dcabsm/1.2.0/bin/dcabsm");
    expect(await readFile(join(root, "usr/share/bash-completion/completions/dcabsm"), "utf8")).toBe(
      "complete x\n",
    );
    expect(await readdir(join(root, "opt/dcabsm"))).toEqual(["1.2.0"]);

    expect(r.out).toContain(FINGERPRINT);
    expect(r.out).toContain("Next: sudo dcabsm host setup");
    // The signature is checked against the key inside the script, not one from the download.
    expect(await readFile(join(log, "keyring"), "utf8")).toBe(KEYRING);
    // Self-update trusts this installed key from now on (spec 11.2).
    expect(await readFile(join(ver, "share/dcabsm-signing-key.gpg"), "utf8")).toBe(KEYRING);
    expect(await logged("gpgv")).toMatch(/--keyring \S+ \S*SHA256SUMS\.sig \S*SHA256SUMS/);
    expect(await logged("curl")).toContain(
      "https://github.com/octo/dcabsm/releases/download/v1.2.0/dcabsm-1.2.0-linux-amd64.tar.gz",
    );
    expect(await logged("apt")).toBe("");
    // Every download is HTTPS-only, redirects included, and TLS 1.2 at least.
    const calls = (await logged("curl")).trim().split("\n");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("--proto =https --tlsv1.2");
  });

  it("downloads the arm64 tarball on an arm64 Host", async () => {
    await release("1.2.0", "arm64");
    const r = install(["--yes"], "", { FAKE_MACHINE: "aarch64" });
    expect(r.code, r.out).toBe(0);
    expect(await logged("curl")).toContain("dcabsm-1.2.0-linux-arm64.tar.gz");
    expect(await exists(join(root, "opt/dcabsm/1.2.0/bin/dcabsm"))).toBe(true);
  });

  it("--yes skips the fingerprint question, and --version skips the lookup", async () => {
    await release("1.1.0", "amd64");
    const r = install(["--yes", "--version", "1.1.0"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("Does it match?");
    expect(await logged("curl")).not.toContain("releases/latest");
    expect(await exists(join(root, "opt/dcabsm/1.1.0"))).toBe(true);
  });

  it("stops at the fingerprint question unless the answer is yes, with nothing downloaded", async () => {
    await release("1.2.0", "amd64");
    const r = install([], "n\n");
    expect(r.code).not.toBe(0);
    expect(await logged("curl")).not.toContain("tar.gz");
    expect(await exists(join(root, "opt"))).toBe(false);
    expect(await exists(join(root, "usr"))).toBe(false);
  });

  it("leaves nothing behind when the signature does not verify", async () => {
    await release("1.2.0", "amd64");
    await writeFile(join(dir, "gpgv-fails"), "");
    const r = install(["--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/signature/i);
    expect(await exists(join(root, "opt/dcabsm"))).toBe(false);
    expect(await exists(join(root, "usr/local/bin/dcabsm"))).toBe(false);
  });

  it("leaves nothing behind when the checksum does not match", async () => {
    await release("1.2.0", "amd64");
    await writeFile(
      join(fixtures, "SHA256SUMS"),
      `${"0".repeat(64)}  dcabsm-1.2.0-linux-amd64.tar.gz\n`,
    );
    const r = install(["--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/checksum/i);
    expect(await exists(join(root, "opt/dcabsm"))).toBe(false);
  });

  it("points to self update and changes nothing when DCABSM is already installed", async () => {
    await release("1.2.0", "amd64");
    await mkdir(join(root, "opt/dcabsm/1.0.0"), { recursive: true });
    const r = install(["--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sudo dcabsm self update");
    expect(await readdir(join(root, "opt/dcabsm"))).toEqual(["1.0.0"]);
    expect(await logged("curl")).toBe("");
  });

  it("refuses an unsupported OS or architecture before downloading anything", async () => {
    await release("1.2.0", "amd64");
    await writeOsRelease("fedora", "41");
    let r = install(["--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Debian 13|Ubuntu/);
    await writeOsRelease("ubuntu", "24.04");
    r = install(["--yes"], "", { FAKE_MACHINE: "armv7l" });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/architecture/i);
    expect(await logged("curl")).toBe("");
  });

  it("accepts Ubuntu 24.04", async () => {
    await release("1.2.0", "amd64");
    await writeOsRelease("ubuntu", "24.04");
    expect(install(["--yes"]).code).toBe(0);
  });

  it("refuses to run without root", async () => {
    await release("1.2.0", "amd64");
    const r = install(["--yes"], "", { FAKE_UID: "1000" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("sudo bash install.sh");
    expect(await logged("curl")).toBe("");
  });

  it("refuses while the release-time placeholders are unfilled", async () => {
    await release("1.2.0", "amd64");
    const r = spawnSync("bash", [SCRIPT, "--yes"], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env["PATH"]}`, DCABSM_ROOT: root, FAKE_MACHINE: "x86_64" },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/placeholder/i);
    expect(await logged("curl")).toBe("");
  });
});
