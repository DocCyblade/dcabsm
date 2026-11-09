import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFlags } from "../args.ts";
import type { Context } from "../context.ts";
import { CliError, errorMessage, firstLine, refusal } from "../errors.ts";
import { exists, makeReadOnly, makeWritable } from "../fsutil.ts";
import { logChange } from "../log.ts";
import { step } from "../output.ts";
import type { Invocation } from "../table.ts";
import { ACTUAL_PACKAGE, NODE_MAJOR_FILE, RELEASE_FLOOR, STABLE_VERSION } from "./constants.ts";
import { chooseNode, ensureNode, type NodeChoice } from "./node.ts";
import { compareText } from "./semver.ts";

const REGISTRY = `https://registry.npmjs.org/${ACTUAL_PACKAGE.replace("/", "%2f")}`;
const NATIVE_MODULES = ["bcrypt", "argon2", "better-sqlite3"];

/** Refuses anything that is not a stable version at or above the floor (spec 1.5). */
export function checkReleaseVersion(version: string): void {
  if (!STABLE_VERSION.test(version)) {
    throw refusal(
      `${version} is not a stable Release version.`,
      "Use a version like 26.11.0. Pre-releases and nightly builds are not supported.",
    );
  }
  if (compareText(version, RELEASE_FLOOR) < 0) {
    throw refusal(`${version} is older than ${RELEASE_FLOOR}, the oldest Release DCABSM supports.`);
  }
}

/** Release directory names, in order. Dot-prefixed work directories are ignored. */
export async function installedReleases(ctx: Context): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(ctx.paths.releases);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith(".")).sort(compareText);
}

async function registryDoc(
  ctx: Context,
  what: string,
): Promise<{ version: string; engines?: { node?: string } }> {
  let res;
  try {
    res = await ctx.fetcher.fetch(`${REGISTRY}/${what}`);
  } catch (err) {
    throw new CliError(
      `Could not reach the npm registry: ${errorMessage(err)}`,
      "Check the network, then run again.",
    );
  }
  if (res.status === 404) {
    throw refusal(
      `Release ${what} does not exist on npm.`,
      `Look for it: npm view ${ACTUAL_PACKAGE} versions`,
    );
  }
  if (res.status !== 200) throw new CliError(`The npm registry answered ${res.status}.`);
  return JSON.parse(new TextDecoder().decode(res.body));
}

/** The latest stable Release on npm. */
export async function latestStable(ctx: Context): Promise<string> {
  const { version } = await registryDoc(ctx, "latest");
  checkReleaseVersion(version);
  return version;
}

export interface Plan {
  version: string;
  node: NodeChoice;
}

/** Validates the version and picks its Node (spec 3.1 steps 2 and 3). Changes nothing. */
export async function planRelease(ctx: Context, version: string): Promise<Plan> {
  checkReleaseVersion(version);
  const doc = await registryDoc(ctx, version);
  return { version, node: await chooseNode(ctx, version, doc.engines?.node) };
}

function nodeBin(ctx: Context, patch: string, tool: string): string {
  return join(ctx.paths.node, patch, "bin", tool);
}

/** Whether a Release's native modules load with its own Node. */
export async function releaseLoads(ctx: Context, dir: string, nodePath: string): Promise<boolean> {
  const code =
    "const m=require('node:module');const r=m.createRequire(process.argv[1]);" +
    `for(const n of ${JSON.stringify(NATIVE_MODULES)})r(n)`;
  const pkg = join(dir, "node_modules", ACTUAL_PACKAGE, "package.json");
  const res = await ctx.runner.run(nodePath, ["-e", code, pkg]);
  return res.code === 0;
}

/** Installs a Release with its Node runtime (spec 3.1). The caller holds the lock. */
export async function installRelease(ctx: Context, plan: Plan): Promise<void> {
  const { version } = plan;
  const patch = await ensureNode(ctx, plan.node);
  const major = plan.node.major;

  const work = join(ctx.paths.releases, `.installing-${version}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const bin = nodeBin(ctx, patch, "npm");
    const path = `PATH=${join(ctx.paths.node, patch, "bin")}:/usr/local/bin:/usr/bin:/bin`;
    const res = await ctx.runner.run("env", [
      path,
      bin,
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      work,
      `${ACTUAL_PACKAGE}@${version}`,
    ]);
    if (res.code !== 0) {
      throw new CliError(
        `npm could not install ${version}: ${firstLine(res.stderr, `npm exited ${res.code}`)}`,
      );
    }
    step(
      ctx,
      "done",
      `Installed Release ${version} with npm --ignore-scripts, tied to Node runtime ${patch}`,
    );

    if (!(await releaseLoads(ctx, work, nodeBin(ctx, patch, "node")))) {
      throw new CliError(
        `Release ${version} is refused: ${NATIVE_MODULES.join(", ")} must all load on Node runtime ${patch}, and they do not.`,
        "Nothing was installed.",
      );
    }
    step(ctx, "done", `Native modules load: ${NATIVE_MODULES.join(", ")}`);

    await writeFile(join(work, NODE_MAJOR_FILE), `${major}\n`);
    // The unit's PATH starts at release/node/bin (spec 4.5); the link follows node/<major> across patches.
    await symlink(join(ctx.paths.node, String(major)), join(work, "node"));
    const final = join(ctx.paths.releases, version);
    if (await exists(final)) {
      // A Release dir whose native modules do not load is repaired by replacing it.
      step(ctx, "warn", `Replacing Release ${version}: its native modules did not load`);
      await makeWritable(final);
      await rm(final, { recursive: true, force: true });
    }
    await rename(work, final);
    await makeReadOnly(final);
  } catch (err) {
    await rm(work, { recursive: true, force: true });
    throw err;
  }
  await logChange(ctx, "release install", `installed ${version} on Node runtime ${patch}`);
}

/** The Node major recorded with a Release. */
export async function releaseNodeMajor(ctx: Context, version: string): Promise<number | undefined> {
  try {
    const text = await readFile(join(ctx.paths.releases, version, NODE_MAJOR_FILE), "utf8");
    const major = Number(text.trim());
    return Number.isInteger(major) ? major : undefined;
  } catch {
    return undefined;
  }
}

/** True once any installed Release loads its native modules (spec 10.2 step 8). */
export async function anyReleaseLoads(ctx: Context): Promise<boolean> {
  for (const version of await installedReleases(ctx)) {
    if (await releaseIntact(ctx, version)) return true;
  }
  return false;
}

/** Whether an installed Release's native modules load with its recorded Node runtime. */
async function releaseIntact(ctx: Context, version: string): Promise<boolean> {
  const major = await releaseNodeMajor(ctx, version);
  if (major === undefined) return false;
  const bin = join(ctx.paths.node, String(major), "bin", "node");
  if (!(await exists(bin))) return false;
  return releaseLoads(ctx, join(ctx.paths.releases, version), bin);
}

/** `release install <v>` */
export async function releaseInstall({ ctx, args }: Invocation): Promise<void> {
  parseFlags(
    args.filter((a) => a.startsWith("-")),
    {},
  );
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length !== 1) {
    throw refusal("Give one version.", "Usage: dcabsm release install <v>");
  }
  const version = positional[0]!;
  checkReleaseVersion(version);
  if (await releaseIntact(ctx, version)) {
    ctx.io.out(`Release ${version} is already installed.`);
    return;
  }
  const plan = await planRelease(ctx, version);
  await installRelease(ctx, plan);
}
