import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleTarball, buildKeyring, fetchNode, writeSums } from "../scripts/tarball.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dcabsm-tarball-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });
const have = (cmd: string) => sh("which", [cmd]).status === 0;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** A stand-in for the output of `npm run build` and for an extracted official Node. */
async function fixtures() {
  const dist = join(dir, "dist");
  await mkdir(join(dist, "share/bash-completion/completions"), { recursive: true });
  await writeFile(join(dist, "dcabsm.js"), "console.log('hi');\n");
  await writeFile(join(dist, "share/bash-completion/completions/dcabsm"), "complete -F x dcabsm\n");
  const node = join(dir, "node-v24.22.2-linux-x64");
  await mkdir(join(node, "bin"), { recursive: true });
  await writeFile(join(node, "bin/node"), "#!/bin/sh\necho node\n", { mode: 0o755 });
  await writeFile(join(node, "LICENSE"), "node licence\n");
  await writeFile(join(node, "README.md"), "not shipped\n");
  const keyring = join(dir, "keys.gpg");
  await writeFile(keyring, "binary keyring");
  return { dist, node, keyring };
}

describe("assembleTarball", () => {
  it("leaves one top-level folder with the layout spec 11.1 promises", async () => {
    const f = await fixtures();
    const out = join(dir, "out");
    const file = await assembleTarball({
      version: "1.2.0",
      arch: "amd64",
      dist: f.dist,
      nodeDir: f.node,
      keyring: f.keyring,
      outDir: out,
    });
    expect(file).toBe(join(out, "dcabsm-1.2.0-linux-amd64.tar.gz"));

    const listing = sh("tar", ["-tzf", file]).stdout.split("\n").filter(Boolean);
    expect(new Set(listing.map((l) => l.split("/")[0]))).toEqual(
      new Set(["dcabsm-1.2.0-linux-amd64"]),
    );

    const x = join(dir, "x");
    await mkdir(x);
    sh("tar", ["-xzf", file, "-C", x]);
    const top = join(x, "dcabsm-1.2.0-linux-amd64");
    expect(await readFile(join(top, "bin/dcabsm.js"), "utf8")).toBe("console.log('hi');\n");
    expect(await readFile(join(top, "share/bash-completion/completions/dcabsm"), "utf8")).toBe(
      "complete -F x dcabsm\n",
    );
    expect(await readFile(join(top, "share/node-release-keys.gpg"), "utf8")).toBe("binary keyring");
    expect((await stat(join(top, "node/bin/node"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(top, "bin/dcabsm"))).mode & 0o111).not.toBe(0);
    await expect(stat(join(top, "node/README.md"))).rejects.toThrow();
  });

  it("ships a wrapper that runs the pinned Node on the bundle, even through a symlink", async () => {
    const f = await fixtures();
    const file = await assembleTarball({
      version: "1.2.0",
      arch: "arm64",
      dist: f.dist,
      nodeDir: f.node,
      keyring: f.keyring,
      outDir: join(dir, "out"),
    });
    const x = join(dir, "x");
    await mkdir(x);
    sh("tar", ["-xzf", file, "-C", x]);
    const wrapper = await readFile(join(x, "dcabsm-1.2.0-linux-arm64/bin/dcabsm"), "utf8");
    expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);
    expect(wrapper).toContain("readlink -f");
    expect(wrapper).toContain("node/bin/node");
    expect(wrapper).toContain("dcabsm.js");
  });
});

describe("writeSums", () => {
  it("writes SHA256SUMS in sha256sum format for the tarballs given", async () => {
    await writeFile(join(dir, "a.tar.gz"), "aaa");
    await writeFile(join(dir, "b.tar.gz"), "bbb");
    await writeSums(dir, ["a.tar.gz", "b.tar.gz"]);
    expect(await readFile(join(dir, "SHA256SUMS"), "utf8")).toBe(
      `${sha("aaa")}  a.tar.gz\n${sha("bbb")}  b.tar.gz\n`,
    );
  });
});

describe("fetchNode", () => {
  const FILE = "node-v24.22.2-linux-x64.tar.xz";

  async function nodeArchive(): Promise<Buffer> {
    const src = join(dir, "src");
    await mkdir(join(src, "node-v24.22.2-linux-x64/bin"), { recursive: true });
    await writeFile(join(src, "node-v24.22.2-linux-x64/bin/node"), "node");
    const out = join(dir, "n.tar.xz");
    sh("tar", ["-cJf", out, "-C", src, "node-v24.22.2-linux-x64"]);
    return readFile(out);
  }

  function fake(archive: Buffer, sums: string, gpgvStatus = 0) {
    const gpgv: string[][] = [];
    return {
      gpgv,
      fetch: async (url: string) => {
        if (url.endsWith("SHASUMS256.txt")) return Buffer.from(sums);
        if (url.endsWith("SHASUMS256.txt.sig")) return Buffer.from("sig");
        if (url.endsWith(FILE)) return archive;
        throw new Error(`unexpected ${url}`);
      },
      run: (cmd: string, args: string[]) => {
        if (cmd === "gpgv") {
          gpgv.push(args);
          return { status: gpgvStatus, stderr: "bad" };
        }
        return spawnSync(cmd, args, { encoding: "utf8" });
      },
    };
  }

  it.skipIf(!have("xz"))("checks the signature and sum, then extracts the Node", async () => {
    const archive = await nodeArchive();
    const f = fake(archive, `${sha(archive)}  ${FILE}\n`);
    const dest = join(dir, "dl");
    const nodeDir = await fetchNode({
      version: "24.22.2",
      arch: "amd64",
      dest,
      keyring: "/k.gpg",
      ...f,
    });
    expect(nodeDir).toBe(join(dest, "node-v24.22.2-linux-x64"));
    expect(await readFile(join(nodeDir, "bin/node"), "utf8")).toBe("node");
    expect(f.gpgv[0]).toEqual([
      "--keyring",
      "/k.gpg",
      join(dest, "SHASUMS256.txt.sig"),
      join(dest, "SHASUMS256.txt"),
    ]);
  });

  it("refuses a tarball whose sum is not the signed one", async () => {
    const archive = await nodeArchive();
    const f = fake(archive, `${sha("other")}  ${FILE}\n`);
    await expect(
      fetchNode({ version: "24.22.2", arch: "amd64", dest: join(dir, "dl"), keyring: "/k", ...f }),
    ).rejects.toThrow(/does not match/);
    await expect(stat(join(dir, "dl/node-v24.22.2-linux-x64"))).rejects.toThrow();
  });

  it("refuses when the signature does not verify", async () => {
    const archive = await nodeArchive();
    const f = fake(archive, `${sha(archive)}  ${FILE}\n`, 1);
    await expect(
      fetchNode({ version: "24.22.2", arch: "arm64", dest: join(dir, "dl"), keyring: "/k", ...f }),
    ).rejects.toThrow(/signature/i);
  });
});

describe.skipIf(!have("gpg"))("buildKeyring", () => {
  it("turns the checked-in armored keys into a binary keyring", async () => {
    const out = join(dir, "ring.gpg");
    await buildKeyring({
      armored: join(import.meta.dirname, "../scripts/node-release-keys.asc"),
      list: join(import.meta.dirname, "../scripts/node-release-keys.list"),
      out,
    });
    expect((await stat(out)).size).toBeGreaterThan(1000);
    const shown = sh("gpg", ["--show-keys", "--with-colons", out]).stdout;
    expect(shown.match(/^fpr:/gm)?.length).toBeGreaterThanOrEqual(8);
  });

  it("refuses when a listed fingerprint is not in the armored file", async () => {
    const list = join(dir, "list");
    await writeFile(list, `${"A".repeat(40)}\n`);
    await expect(
      buildKeyring({
        armored: join(import.meta.dirname, "../scripts/node-release-keys.asc"),
        list,
        out: join(dir, "ring.gpg"),
      }),
    ).rejects.toThrow(/fingerprint/i);
  });
});
