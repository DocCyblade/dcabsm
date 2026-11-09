import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// The bash completion script is generated from the command table (spec 9.1). It sits where the
// tarball keeps it: share/bash-completion/completions/dcabsm.
const gen = await build({
  entryPoints: ["src/completion.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { completionScript } = await import(
  `data:text/javascript;base64,${Buffer.from(gen.outputFiles[0].text).toString("base64")}`
);
mkdirSync("dist/share/bash-completion/completions", { recursive: true });
writeFileSync("dist/share/bash-completion/completions/dcabsm", completionScript());
