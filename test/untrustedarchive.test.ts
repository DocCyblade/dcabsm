import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { startArchiveHost, type ArchiveHost } from "./archivehost.ts";

let t: ArchiveHost;
afterEach(() => t.h.cleanup());

/** Adds one member to the host's (fake) archive, as a hostile archive would hold it. */
async function tampered(name: string, type: string): Promise<string> {
  const archive = JSON.parse(await readFile(t.archive, "utf8"));
  archive.extra = [{ name, type }];
  const path = `${t.archive}.evil`;
  await writeFile(path, JSON.stringify(archive));
  return path;
}

const cases: Array<[string, string, string]> = [
  ["a symlink", "data/escape", "l"],
  ["a hard link", "data/again", "h"],
  ["a device node", "data/dev", "c"],
  ["a pipe", "data/pipe", "p"],
  ["an absolute path", "/etc/cron.d/x", "-"],
  ["a .. path", "data/../../../etc/x", "-"],
];

describe("an untrusted archive", () => {
  for (const [what, name, type] of cases) {
    it(`is refused when it holds ${what}, by restore --from and clone --from`, async () => {
      t = await startArchiveHost();
      const evil = await tampered(name, type);
      await t.loseShop();
      expect(await run(["instance", "restore", "--from", evil], t.h.ctx)).not.toBe(0);
      expect(t.err()).toContain("unsafe");
      t.h.err.length = 0;
      const clone = ["instance", "clone", "--from", evil, "two", "--hostname", "two.example.org"];
      expect(await run(clone, t.h.ctx)).not.toBe(0);
      expect(t.err()).toContain("unsafe");
      expect(t.h.calls.some((c) => c.command === "tar" && c.args[0] === "-xzf")).toBe(false);
    });
  }

  it("is refused by an in-place restore before anything is stopped", async () => {
    t = await startArchiveHost();
    const evil = await tampered("data/escape", "l");
    expect(await run(["instance", "restore", "shop", evil, "--confirm", "shop"], t.h.ctx)).not.toBe(
      0,
    );
    expect(t.err()).toContain("unsafe");
    expect(t.sysctls()).not.toContain("stop dcabsm@shop");
  });
});
