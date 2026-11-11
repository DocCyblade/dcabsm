import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { pathsUnder } from "./paths.ts";
import { realFetcher, realIo, realRunner } from "./real.ts";

const root = process.env["DCABSM_ROOT"] ?? "/";
// The bundle sits in <ver>/bin, so the version's own directory is one level up (spec 3.1).
const installDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const code = await run(process.argv.slice(2), {
  paths: pathsUnder(root, installDir),
  runner: realRunner,
  fetcher: realFetcher,
  io: realIo(),
  uid: process.getuid?.() ?? -1,
  arch: process.arch,
  env: process.env,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

process.exitCode = code;
