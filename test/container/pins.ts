// Fetches the pinned Actual Releases and Node once, for the container layer (spec 13.3).
// Usage: node test/container/pins.ts <dir> <x64|arm64>
//
// It writes <dir>/site/<host>/<path> for the mirror (nodejs.org's signed Node files, the Release
// documents from npm's registry, Node's release schedule) and <dir>/npm-cache, an npm cache holding
// every pinned Release and its dependencies, so the containers' npm installs run offline. Nothing
// here is faked: the Node files are nodejs.org's own and dcabsm still checks them with gpgv.
// Skips whatever is already in <dir>, so a CI cache restore makes it a no-op.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const [dir, arch] = process.argv.slice(2);
if (!dir || (arch !== "x64" && arch !== "arm64")) {
  console.error("Usage: node test/container/pins.ts <dir> <x64|arm64>");
  process.exit(2);
}

const pins = JSON.parse(readFileSync(join(here, "pins.json"), "utf8")) as {
  releases: string[];
  latest: string;
};
const node = readFileSync(join(repo, ".node-version"), "utf8").trim();
const PACKAGE = "@actual-app/sync-server";
const versions = [...new Set([...pins.releases, pins.latest])];

async function get(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function save(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await get(url));
  console.log(`fetched ${url}`);
}

const site = join(dir, "site");

// Node: the signed files for the one patch DCABSM runs, and an index that offers only that patch,
// so the choice of Node does not move under the tests.
const dist = join(site, "nodejs.org", "dist");
const tarball = `node-v${node}-linux-${arch}.tar.xz`;
for (const f of ["SHASUMS256.txt", "SHASUMS256.txt.sig", tarball]) {
  await save(`https://nodejs.org/dist/v${node}/${f}`, join(dist, `v${node}`, f));
}
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.json"), JSON.stringify([{ version: `v${node}`, lts: "Krypton" }]));
await save(
  "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json",
  join(site, "raw.githubusercontent.com", "nodejs", "Release", "main", "schedule.json"),
);

// Actual: each Release's registry document, `latest` as the newest pin, and an npm cache.
const registry = join(site, "registry.npmjs.org", ...PACKAGE.split("/"));
for (const v of versions) {
  await save(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/${v}`, join(registry, v));
}
mkdirSync(registry, { recursive: true });
writeFileSync(join(registry, "latest"), readFileSync(join(registry, pins.latest)));

const cache = join(dir, "npm-cache");
const marker = join(cache, ".pinned");
const want = `${versions.join(",")} node ${node}\n`;
if (!existsSync(marker) || readFileSync(marker, "utf8") !== want) {
  const scratch = mkdtempSync(join(tmpdir(), "dcabsm-pins-"));
  try {
    for (const v of versions) {
      const res = spawnSync(
        "npm",
        [
          "install",
          "--save-exact",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--cache",
          cache,
          "--prefix",
          join(scratch, v),
          `${PACKAGE}@${v}`,
        ],
        { stdio: "inherit" },
      );
      if (res.status !== 0) throw new Error(`npm could not install ${PACKAGE}@${v}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(marker, want);
}
console.log(`Pins are in ${dir}`);
