import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { writeFileAtomic } from "./fsutil.ts";
import type { Paths } from "./paths.ts";
import { table as commandTable, type Noun } from "./table.ts";

/** What a completion position or flag value takes its words from. */
export type Kind = "instance" | "release" | "onoff" | "file" | "none";

export interface Positional {
  kind: Kind;
  /** Every position from this one on takes the same kind, as in `start <names>`. */
  variadic: boolean;
}

export interface VerbModel {
  noun: string;
  verb: string;
  hidden: boolean;
  flags: string[];
  valueFlags: Array<{ flag: string; kind: Kind }>;
  positionals: Positional[];
}

const FILE_FLAGS = new Set(["--cert", "--key", "--backup-dir", "--from"]);

function valueKind(noun: string, flag: string): Kind {
  if (flag === "--release" || (flag === "--to" && noun !== "self")) return "release";
  if (flag === "--confirm") return "instance";
  if (FILE_FLAGS.has(flag)) return "file";
  return "none";
}

function positionalsOf(verb: string, usage: string): Positional[] {
  // `restore <name> [<archive>] | restore --from <archive>`: the first form decides.
  const first = usage.split(` | ${verb} `)[0]!;
  const bare = first
    .replace(/\([^)]*\)/g, "")
    .replace(/\[-[^\]]*\]/g, "")
    .replace(/--[\w-]+( <\w+>)?/g, "")
    .trim()
    .split(/\s+/)
    .slice(1);
  const out: Positional[] = [];
  for (const token of bare) {
    const m = /^\[?<(name|names|source)>/.exec(token);
    if (m) out.push({ kind: "instance", variadic: m[1] === "names" });
    else if (token === "on|off") out.push({ kind: "onoff", variadic: false });
    else out.push({ kind: "none", variadic: false });
  }
  return out;
}

/** What completion knows about every command, read from the same table as `help` and routing. */
export function completionModel(nouns: Noun[] = commandTable): VerbModel[] {
  const models: VerbModel[] = [];
  for (const noun of nouns) {
    for (const verb of noun.verbs) {
      const flags = new Set(verb.usage.match(/(?<![\w-])--?[a-z][\w-]*/g) ?? []);
      if (verb.usage.includes("[cert options]")) {
        for (const f of ["--cert", "--key", "--self-signed"]) flags.add(f);
      }
      const valueFlags = [...verb.usage.matchAll(/(--[\w-]+) <\w+>/g)].map((m) => ({
        flag: m[1]!,
        kind: valueKind(noun.name, m[1]!),
      }));
      if (verb.usage.includes("[cert options]")) {
        for (const flag of ["--cert", "--key"]) {
          valueFlags.push({ flag, kind: "file" });
        }
      }
      models.push({
        noun: noun.name,
        verb: verb.name,
        hidden: verb.hidden === true,
        flags: [...flags],
        valueFlags,
        positionals: positionalsOf(verb.name, verb.usage),
      });
    }
  }
  return models;
}

const sh = (s: string) => `"${s}"`;

/** The bash completion script, generated from the command table (spec 9.1). */
export function completionScript(nouns: Noun[] = commandTable): string {
  const models = completionModel(nouns);
  const visible = models.filter((m) => !m.hidden);
  const nounNames = nouns.map((n) => n.name);

  const verbCases = nounNames.map((n) => {
    const verbs = visible.filter((m) => m.noun === n).map((m) => m.verb);
    return `      ${n}) words=${sh(verbs.join(" "))} ;;`;
  });
  const flagCases = visible.map(
    (m) => `      ${sh(`${m.noun} ${m.verb}`)}) words=${sh(m.flags.join(" "))} ;;`,
  );
  const valueFlagCases = visible.flatMap((m) =>
    m.valueFlags
      .filter((f) => f.kind !== "none")
      .map((f) => `      ${sh(`${m.noun} ${m.verb} ${f.flag}`)}) kind=${f.kind} ;;`),
  );
  const noValue = visible.flatMap((m) =>
    m.valueFlags.filter((f) => f.kind === "none").map((f) => `${m.noun} ${m.verb} ${f.flag}`),
  );
  const valueFlagNames = [...new Set(visible.flatMap((m) => m.valueFlags.map((f) => f.flag)))].join(
    "|",
  );
  const positionCases = visible.flatMap((m) =>
    m.positionals.flatMap((p, i) => {
      if (p.kind === "none") return [];
      const pattern = p.variadic
        ? `${sh(`${m.noun} ${m.verb} `)}*`
        : sh(`${m.noun} ${m.verb} ${i}`);
      return [`      ${pattern}) kind=${p.kind} ;;`];
    }),
  );
  // A flag whose value has no word list (--hostname, --since) completes nothing, not a position.
  const noValueCases = noValue.length ? [`      ${noValue.map(sh).join("|")}) kind=none ;;`] : [];

  return `# bash completion for dcabsm. Generated from the command table; do not edit.
# Instance names and Release versions come from instances/ and releases/, which are
# world-readable, so completion never needs root. Backup archives are root-only and never complete.

_dcabsm_dirs() {
  local p
  for p in "$1"/*/; do
    if [ -d "$p" ]; then
      p=\${p%/}
      printf '%s\\n' "\${p##*/}"
    fi
  done
}

_dcabsm() {
  local cur=\${COMP_WORDS[COMP_CWORD]} srv="\${DCABSM_ROOT%/}/srv/dcabsm"
  local noun=\${COMP_WORDS[1]} verb=\${COMP_WORDS[2]}
  local words="" kind="" pos=0 skip=0 i w prev
  COMPREPLY=()

  if [ "$COMP_CWORD" -eq 1 ]; then
    words="${nounNames.join(" ")} help"
    case "$cur" in -*) words="--version" ;; esac
  elif [ "$COMP_CWORD" -eq 2 ]; then
    case "$noun" in
${verbCases.join("\n")}
    esac
  else
    prev=\${COMP_WORDS[COMP_CWORD-1]}
    case "$noun $verb $prev" in
${valueFlagCases.join("\n")}
${noValueCases.join("\n")}
    esac
    if [ -z "$kind" ]; then
      case "$cur" in
        -*)
          case "$noun $verb" in
${flagCases.join("\n")}
          esac
          ;;
        *)
          for ((i = 3; i < COMP_CWORD; i++)); do
            w=\${COMP_WORDS[i]}
            if [ "$skip" -eq 1 ]; then
              skip=0
            else
              case "$w" in
                ${valueFlagNames}) skip=1 ;;
                -*) ;;
                *) pos=$((pos + 1)) ;;
              esac
            fi
          done
          case "$noun $verb $pos" in
${positionCases.join("\n")}
          esac
          ;;
      esac
    fi
  fi

  case "$kind" in
    instance) words=$(_dcabsm_dirs "$srv/instances") ;;
    release) words=$(_dcabsm_dirs "$srv/releases") ;;
    onoff) words="on off" ;;
    file)
      COMPREPLY=($(compgen -f -- "$cur"))
      return 0
      ;;
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
  return 0
}

complete -F _dcabsm dcabsm
`;
}

/** Where the script lives on the Host (spec 2.1). */
export function completionPath(paths: Paths): string {
  return join(paths.root, "usr/share/bash-completion/completions/dcabsm");
}

/** Writes the script as a world-readable file; the caller records it as an owned file. */
export async function installCompletion(paths: Paths, script: string): Promise<void> {
  const path = completionPath(paths);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, script, 0o644);
}
