import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const node = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/dcabsm.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${node}`,
  banner: { js: "#!/usr/bin/env node" },
  define: { __DCABSM_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
});
