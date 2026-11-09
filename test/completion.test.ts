import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import {
  completionModel,
  completionPath,
  completionScript,
  installCompletion,
} from "../src/completion.ts";
import { helpLines } from "../src/help.ts";
import { table } from "../src/table.ts";
import { harness } from "./helpers.ts";

const script = completionScript();

describe("the completion script and the command table", () => {
  it("covers exactly the verbs help shows plus the hidden ones routing accepts", () => {
    const fromTable = table.flatMap((n) => n.verbs.map((v) => `${n.name} ${v.name}`));
    const fromModel = completionModel().map((v) => `${v.noun} ${v.verb}`);
    expect(fromModel.sort()).toEqual(fromTable.sort());
  });

  it("offers every command help prints, and leaves hidden ones out of the lists", () => {
    const shown = helpLines()
      .filter((l) => l.startsWith("  ") && !l.startsWith("      "))
      .map((l) => l.trim().split(" ").slice(0, 2).join(" "))
      .filter((p) => table.some((n) => p.startsWith(`${n.name} `)));
    for (const path of shown) {
      const [noun, verb] = path.split(" ");
      expect(completionModel().some((v) => v.noun === noun && v.verb === verb)).toBe(true);
    }
    expect(script).not.toMatch(/\bnightly\b/);
  });

  it("is installed as a world-readable file under the root, and the CLI is untouched", async () => {
    const h = await harness();
    try {
      await installCompletion(h.ctx.paths, script);
      const path = completionPath(h.ctx.paths);
      expect(path).toBe(join(h.root, "usr/share/bash-completion/completions/dcabsm"));
      expect(await readFile(path, "utf8")).toBe(script);
      expect(h.calls).toEqual([]);
      expect(await run(["help"], h.ctx)).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

// --- Behaviour in real bash -------------------------------------------------

let root: string;
let scriptFile: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dcabsm-comp-"));
  const srv = join(root, "srv/dcabsm");
  for (const d of ["instances/alpha", "instances/beta", "instances/.installing-x"]) {
    mkdirSync(join(srv, d), { recursive: true });
  }
  for (const d of ["releases/26.10.0", "releases/26.11.0", "releases/.installing-26.12.0"]) {
    mkdirSync(join(srv, d), { recursive: true });
  }
  mkdirSync(join(root, "var/backups/dcabsm"), { recursive: true });
  writeFileSync(join(root, "var/backups/dcabsm/alpha-2026-11-01.tar.zst"), "");
  scriptFile = join(root, "dcabsm.bash");
  writeFileSync(scriptFile, script);
});
afterAll(() => rm(root, { recursive: true, force: true }));

const DIRECT = `source "$1"; shift
COMP_WORDS=("$@"); COMP_CWORD=$(($#-1)); COMP_LINE="$*"; COMP_POINT=\${#COMP_LINE}
_dcabsm dcabsm "\${!#}" "\${COMP_WORDS[COMP_CWORD-1]}"
printf '%s\\n' "\${COMPREPLY[@]}"`;

function lines(out: string): string[] {
  return out.split("\n").filter(Boolean).sort();
}

function direct(...words: string[]): string[] {
  const out = execFileSync("bash", ["-c", DIRECT, "bash", scriptFile, "dcabsm", ...words], {
    cwd: root,
    env: { PATH: process.env.PATH, DCABSM_ROOT: root },
    encoding: "utf8",
  });
  return lines(out);
}

describe("the completion function", () => {
  it("completes nouns, then each noun's verbs", () => {
    expect(direct("")).toEqual([...table.map((n) => n.name), "help"].sort());
    expect(direct("ho")).toEqual(["host"]);
    expect(direct("backup", "")).toEqual(["create", "list", "prune", "schedule"]);
    expect(direct("host", "")).not.toContain("nightly");
  });

  it("completes every verb's flags", () => {
    for (const v of completionModel()) {
      if (v.hidden) continue;
      expect(direct(v.noun, v.verb, "-")).toEqual([...v.flags].sort());
    }
    expect(direct("instance", "logs", "-")).toEqual(["--since", "-f"]);
    expect(direct("clone", "")).toEqual([]);
  });

  it("completes Instance names and Release versions from the root without root", () => {
    expect(direct("instance", "show", "")).toEqual(["alpha", "beta"]);
    expect(direct("instance", "show", "a")).toEqual(["alpha"]);
    expect(direct("instance", "start", "alpha", "")).toEqual(["alpha", "beta"]);
    expect(direct("instance", "clone", "")).toEqual(["alpha", "beta"]);
    expect(direct("instance", "clone", "alpha", "")).toEqual([]);
    expect(direct("instance", "upgrade", "alpha", "--to", "")).toEqual(["26.10.0", "26.11.0"]);
    expect(direct("host", "setup", "--release", "26.1")).toEqual(["26.10.0", "26.11.0"]);
    expect(direct("instance", "remove", "alpha", "--confirm", "")).toEqual(["alpha", "beta"]);
    expect(direct("backup", "schedule", "alpha", "")).toEqual(["off", "on"]);
    expect(direct("self", "update", "--to", "")).toEqual([]);
  });

  it("never completes Backup archive names, nor unfinished dot-prefixed work", () => {
    for (const words of [
      ["instance", "restore", "alpha", ""],
      ["backup", "list", ""],
      ["instance", "restore", "--from", "al"],
    ]) {
      const got = direct(...words);
      expect(got.join(" ")).not.toContain("tar.zst");
      expect(got.join(" ")).not.toContain(".installing");
    }
    expect(direct("instance", "show", "")).not.toContain(".installing-x");
  });
});

// --- Behaviour through bash-completion's sudo handling (bash 5 only) --------

function findBash5(): string | undefined {
  for (const bin of [
    "/opt/homebrew/bin/bash",
    "/usr/local/bin/bash",
    "/usr/bin/bash",
    "/bin/bash",
    "bash",
  ]) {
    try {
      const v = execFileSync(bin, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).trim();
      if (Number(v) >= 5) return bin;
    } catch {
      /* not there */
    }
  }
  return undefined;
}

function findBashCompletion(): string | undefined {
  return [
    "/usr/share/bash-completion/bash_completion",
    "/opt/homebrew/share/bash-completion/bash_completion",
    "/usr/local/share/bash-completion/bash_completion",
  ].find((p) => existsSync(p));
}

const bash5 = findBash5();
const bashCompletion = findBashCompletion();
const SUDO = `source "$1"; source "$2"; shift 2
fn=$(complete -p sudo | sed -n 's/.*-F \\([^ ]*\\).*/\\1/p')
COMP_WORDS=(sudo "$@"); COMP_CWORD=$#; COMP_LINE="sudo $*"; COMP_POINT=\${#COMP_LINE}
"$fn" sudo "\${!#}" "\${COMP_WORDS[COMP_CWORD-1]}"
printf '%s\\n' "\${COMPREPLY[@]}"`;

describe.skipIf(!bash5 || !bashCompletion)("through bash-completion's sudo, in bash 5", () => {
  function viaSudo(...words: string[]): string[] {
    return lines(
      execFileSync(bash5!, ["-c", SUDO, "bash", bashCompletion!, scriptFile, ...words], {
        cwd: root,
        env: { PATH: process.env.PATH, DCABSM_ROOT: root },
        encoding: "utf8",
      }),
    );
  }

  it("completes every noun, verb and flag path after sudo dcabsm", () => {
    expect(viaSudo("dcabsm", "")).toEqual([...table.map((n) => n.name), "help"].sort());
    for (const v of completionModel()) {
      if (v.hidden) continue;
      expect(viaSudo("dcabsm", v.noun, "")).toContain(v.verb);
      expect(viaSudo("dcabsm", v.noun, v.verb, "-")).toEqual([...v.flags].sort());
    }
  });

  it("completes fixture Instance names and Release versions after sudo dcabsm", () => {
    expect(viaSudo("dcabsm", "instance", "show", "")).toEqual(["alpha", "beta"]);
    expect(viaSudo("dcabsm", "host", "setup", "--release", "")).toEqual(["26.10.0", "26.11.0"]);
  });
});
