import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { table } from "../src/table.ts";

const root = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The "Commands at a glance" rows of docs/cli.md, as [command, summary] pairs. */
function glanceRows(cli: string): Array<[string, string]> {
  const start = cli.indexOf("## Commands at a glance");
  const end = cli.indexOf("\n## ", start + 1);
  const rows: Array<[string, string]> = [];
  for (const line of cli.slice(start, end).split("\n")) {
    if (!line.startsWith("|")) continue;
    // Split on unescaped pipes only.
    const cells = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    const m = /^`(.*)`$/.exec(cells[1] ?? "");
    if (m) rows.push([m[1]!.replaceAll("\\|", "|"), cells[2] ?? ""]);
  }
  return rows;
}

describe("docs/cli.md matches the help table", () => {
  it("lists every visible command, with its usage and summary, in help order", () => {
    const expected: Array<[string, string]> = [];
    for (const noun of table) {
      for (const verb of noun.verbs.filter((v) => !v.hidden)) {
        expected.push([`${noun.name} ${verb.usage}`, verb.summary]);
      }
    }
    expect(glanceRows(read("docs/cli.md"))).toEqual(expected);
  });

  it("mentions every flag of every command, hidden ones included", () => {
    const cli = read("docs/cli.md");
    for (const noun of table) {
      for (const verb of noun.verbs) {
        for (const flag of verb.usage.match(/--[a-z][a-z-]*/g) ?? []) {
          expect(cli, `${noun.name} ${verb.name} ${flag}`).toContain(flag);
        }
      }
    }
  });
});

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

describe("markdown links", () => {
  it("every relative link points at a file or directory that exists", () => {
    const broken: string[] = [];
    for (const file of markdownFiles(root)) {
      const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!.split("#")[0]!;
        if (!target || /^[a-z]+:/i.test(target)) continue;
        try {
          statSync(resolve(dirname(file), target));
        } catch {
          broken.push(`${relative(root, file)} -> ${m[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("docs/development.md layout", () => {
  it("names every source file under src/", () => {
    const dev = read("docs/development.md");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(join(root, d))) {
        const p = `${d}/${n}`;
        if (statSync(join(root, p)).isDirectory()) walk(p);
        else if (n.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");
    // A name shared by several files (list.ts, prune.ts, doctor.ts) must be named that many times.
    const base = (f: string) => f.split("/").pop()!;
    const missing = files.filter((f) => {
      const same = files.filter((g) => base(g) === base(f)).length;
      return dev.split(base(f)).length - 1 < same;
    });
    expect(missing).toEqual([]);
  });
});
