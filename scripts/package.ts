// Builds dist/release/dcabsm-<ver>-linux-{amd64,arm64}.tar.gz and SHA256SUMS. Run `npm run build` first.
// Usage: node scripts/package.ts [amd64|arm64 ...]   (default: both)
// Signing is never done here: the author signs SHA256SUMS on their own machine (spec 11.2).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleTarball, buildKeyring, fetchNode, writeSums, type Arch } from "./tarball.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
const arches = (
  process.argv.slice(2).length ? process.argv.slice(2) : ["amd64", "arm64"]
) as Arch[];
for (const a of arches) if (a !== "amd64" && a !== "arm64") throw new Error(`Unknown arch ${a}`);

const outDir = join(root, "dist/release");
const cache = join(root, "dist/cache");
mkdirSync(cache, { recursive: true });
const keyring = join(cache, "node-release-keys.gpg");
await buildKeyring({
  armored: join(root, "scripts/node-release-keys.asc"),
  list: join(root, "scripts/node-release-keys.list"),
  out: keyring,
});

const files: string[] = [];
for (const arch of arches) {
  const nodeDir = await fetchNode({ version: nodeVersion, arch, dest: join(cache, arch), keyring });
  const tarball = await assembleTarball({
    version: pkg.version,
    arch,
    dist: join(root, "dist"),
    nodeDir,
    keyring,
    outDir,
  });
  files.push(tarball.split("/").pop()!);
  console.log(`Built ${tarball}`);
}
await writeSums(outDir, files);
console.log(`Wrote ${join(outDir, "SHA256SUMS")}`);
