import { run } from "./cli.ts";
import { pathsUnder } from "./paths.ts";
import { realFetcher, realIo, realRunner } from "./real.ts";

const root = process.env["DCABSM_ROOT"] ?? "/";

const code = await run(process.argv.slice(2), {
  paths: pathsUnder(root),
  runner: realRunner,
  fetcher: realFetcher,
  io: realIo(),
  uid: process.getuid?.() ?? -1,
  arch: process.arch,
  env: process.env,
  now: () => new Date(),
});

process.exitCode = code;
