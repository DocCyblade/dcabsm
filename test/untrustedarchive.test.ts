import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { startArchiveHost, type ArchiveHost } from "./archivehost.ts";

let t: ArchiveHost;
afterEach(() => t.h.cleanup());

/** Adds one member to the host's (fake) archive, as a hostile archive would hold it. */
async function tampered(name: string, type: string, perms?: string): Promise<string> {
  const archive = JSON.parse(await readFile(t.archive, "utf8"));
  archive.extra = [{ name, type, perms }];
  const path = `${t.archive}.evil`;
  await writeFile(path, JSON.stringify(archive));
  return path;
}

const cases: Array<[string, string, string, string?]> = [
  ["a symlink", "data/escape", "l"],
  ["a hard link", "data/again", "h"],
  ["a device node", "data/dev", "c"],
  ["a pipe", "data/pipe", "p"],
  ["an absolute path", "/etc/cron.d/x", "-"],
  ["a .. path", "data/../../../etc/x", "-"],
  ["a setuid file", "data/su", "-", "rwsr-xr-x"],
  ["a setgid file", "data/sg", "-", "rwxr-sr-x"],
];

describe("an untrusted archive", () => {
  for (const [what, name, type, perms] of cases) {
    it(`is refused when it holds ${what}, by restore --from and clone --from`, async () => {
      t = await startArchiveHost();
      const evil = await tampered(name, type, perms);
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

describe("an untrusted archive's Instance record", () => {
  /** Rewrites config/instance.json in the (fake) archive. */
  async function withRecord(patch: Record<string, unknown>): Promise<string> {
    const archive = JSON.parse(await readFile(t.archive, "utf8"));
    const record = JSON.parse(archive.files["config/instance.json"]);
    archive.files["config/instance.json"] = JSON.stringify({ ...record, ...patch });
    const path = `${t.archive}.record`;
    await writeFile(path, JSON.stringify(archive));
    return path;
  }

  const bad: Array<[string, Record<string, unknown>]> = [
    ["a port below 1024", { port: 22 }],
    ["a fractional port", { port: 8080.5 }],
    ["a port beyond 65535", { port: 70000 }],
    ["an unknown setting", { settings: { "no-such-setting": 1 } }],
    ["a setting with the wrong value", { settings: { "upload-limit-mb": "1m; evil" } }],
    ["a setting out of range", { settings: { "upload-limit-mb": 1e21 } }],
  ];
  for (const [what, patch] of bad) {
    it(`is refused with ${what}`, async () => {
      t = await startArchiveHost();
      const evil = await withRecord(patch);
      await t.loseShop();
      expect(await run(["instance", "restore", "--from", evil], t.h.ctx)).not.toBe(0);
      expect(t.err()).toContain("Instance record");
    });
  }
});
