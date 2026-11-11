import { writeFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { exists } from "../src/fsutil.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { fakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
let host: FakeHost;
let stopped: Set<string>;
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const STAMP = "20261109T120000Z";

/** A Host with the named Instances created; each has data unless listed in `empty`. */
async function start(
  names: string[],
  empty: string[] = [],
  interactive = false,
  answers: string[] = [],
) {
  host = fakeHost();
  stopped = new Set();
  h = await harness({
    net: fakeNet({ serverVersion: "26.11.1" }),
    interactive,
    answers,
    runner: (command, args) => {
      if (command === "openssl") {
        writeFileSync(args[args.indexOf("-keyout") + 1]!, "KEY");
        writeFileSync(args[args.indexOf("-out") + 1]!, "CERT");
        return ok();
      }
      if (command === "nginx" && args[0] === "-T") return ok("");
      if (command === "systemctl" && args[0] === "is-active") {
        return stopped.has(args.at(-1)!)
          ? { code: 3, stdout: "inactive\n", stderr: "" }
          : ok("active\n");
      }
      if (command === "systemctl" && args[0] === "stop") stopped.add(args.at(-1)!);
      if (command === "systemctl" && args[0] === "start") stopped.delete(args.at(-1)!);
      return host.run(command, args);
    },
  });
  const p = h.ctx.paths;
  for (const d of [p.releases, p.node, p.instances, p.acme]) await mkdir(d, { recursive: true });
  expect(await run(["release", "install", "26.11.1"], h.ctx)).toBe(0);
  for (const name of names) {
    const args = ["instance", "create", name, "--hostname", `${name}.example.org`, "--self-signed"];
    expect(await run(args, h.ctx)).toBe(0);
    if (!empty.includes(name)) {
      await writeFile(join(p.instances, name, "data", "account.sqlite"), `budget of ${name}`);
    }
  }
  await mkdir(p.under("/srv/dcabsm/backups"), { recursive: true, mode: 0o700 });
  h.out.length = 0;
  h.calls.length = 0;
}

const remove = (...args: string[]) => run(["instance", "remove", ...args], h.ctx);
const backups = (...parts: string[]) => join(h.ctx.paths.under("/srv/dcabsm/backups"), ...parts);
const instance = (name: string) => join(h.ctx.paths.instances, name);
const steps = () =>
  h.calls
    .filter((c) => !(c.command === "systemctl" && c.args[0] === "is-active"))
    .filter((c) => ["systemctl", "tar", "nginx", "userdel"].includes(c.command))
    .filter((c) => !(c.command === "tar" && c.args[0] === "-tzf"))
    .map((c) => `${c.command} ${c.args.slice(0, 2).join(" ")}`.trim());

describe("instance remove", () => {
  it("stops, takes a final Backup, moves the Backups, drops the vhost, then deletes", async () => {
    await start(["shop"]);
    await mkdir(backups("shop"), { recursive: true });
    await writeFile(backups("shop", "20261001T000000Z-manual-26.11.1.tar.gz"), "old");

    expect(await remove("shop", "--confirm", "shop")).toBe(0);

    expect(steps()).toEqual([
      "systemctl stop dcabsm@shop",
      "systemctl disable dcabsm@shop",
      expect.stringMatching(/^tar -czf/),
      "nginx -t",
      "systemctl reload nginx",
      "userdel dcabsm-shop",
    ]);
    expect(await exists(instance("shop"))).toBe(false);
    expect(await exists(backups("shop"))).toBe(false);
    expect((await readdir(backups(`shop.removed-${STAMP}`))).sort()).toEqual([
      "20261001T000000Z-manual-26.11.1.tar.gz",
      `${STAMP}-final-26.11.1.tar.gz`,
    ]);
    expect(h.out).toContain(`  ✓ Backups moved to /srv/dcabsm/backups/shop.removed-${STAMP}/`);
    expect(h.out).toContain("  ✓ Deleted Instance and account dcabsm-shop");
  });

  it("leaves other Instances alone", async () => {
    await start(["shop", "kids"]);
    expect(await remove("shop", "--confirm", "shop")).toBe(0);
    expect(await exists(join(instance("kids"), "nginx", "vhost.conf"))).toBe(true);
  });

  it("takes no final Backup for an Instance that never started, and says so", async () => {
    await start(["shop"], ["shop"]);
    expect(await remove("shop", "--confirm", "shop")).toBe(0);
    expect(steps().some((s) => s.startsWith("tar"))).toBe(false);
    expect(await exists(instance("shop"))).toBe(false);
    expect(await readdir(backups())).toEqual([]);
    expect(h.out.join("\n")).toContain("has never started");
  });

  it("asks for the name and cancels on a mismatch", async () => {
    await start(["shop"], [], true, ["shap"]);
    expect(await remove("shop")).toBe(1);
    expect(h.asked).toEqual(["Type the Instance name shop to confirm: "]);
    expect(h.out.join("\n")).toContain("The name did not match. Nothing changed.");
    expect(await exists(instance("shop"))).toBe(true);
    expect(steps()).toEqual([]);
  });

  it("proceeds when the typed name matches", async () => {
    await start(["shop"], [], true, ["shop"]);
    expect(await remove("shop")).toBe(0);
    expect(await exists(instance("shop"))).toBe(false);
  });

  it("refuses without a terminal or --confirm, and on a wrong --confirm", async () => {
    await start(["shop"]);
    expect(await remove("shop")).toBe(2);
    expect(h.err.join("\n")).toContain("No terminal to confirm on.");
    expect(await remove("shop", "--confirm", "other")).toBe(1);
    expect(await exists(instance("shop"))).toBe(true);
    expect(steps()).toEqual([]);
  });

  it("refuses an unknown Instance and an Instance with an unfinished Release change", async () => {
    await start(["shop"]);
    expect(await remove("ghost", "--confirm", "ghost")).toBe(2);
    expect(h.err.join("\n")).toContain("There is no Instance named ghost.");
    await writeFile(join(instance("shop"), ".changing-release"), "");
    expect(await remove("shop", "--confirm", "shop")).toBe(2);
    expect(await exists(instance("shop"))).toBe(true);
  });

  it("keeps everything when the final Backup fails", async () => {
    await start(["shop"]);
    const wrapped = h.ctx.runner.run;
    h.ctx.runner.run = async (c, a) =>
      c === "tar" && a[0] === "-czf" ? { code: 1, stdout: "", stderr: "tar: boom" } : wrapped(c, a);
    expect(await remove("shop", "--confirm", "shop")).toBe(1);
    expect(h.err.join("\n")).toContain("was not removed");
    expect(await exists(join(instance("shop"), "nginx", "vhost.conf"))).toBe(true);
    expect(steps().some((s) => s.startsWith("userdel"))).toBe(false);
  });

  it("puts the vhost and the Backups back when nginx -t fails", async () => {
    await start(["shop"]);
    await mkdir(backups("shop"), { recursive: true });
    host.nginxTest = { code: 1, stdout: "", stderr: "nginx: [emerg] bad" };
    expect(await remove("shop", "--confirm", "shop")).toBe(1);
    expect(h.err.join("\n")).toContain("nginx -t failed");
    expect(await exists(join(instance("shop"), "nginx", "vhost.conf"))).toBe(true);
    expect(await exists(backups("shop"))).toBe(true);
    expect(steps().some((s) => s === "systemctl reload nginx" || s.startsWith("userdel"))).toBe(
      false,
    );
  });

  it("lets the name be reused with no Backups and a new account", async () => {
    await start(["shop"]);
    expect(await remove("shop", "--confirm", "shop")).toBe(0);
    h.calls.length = 0;
    const args = ["instance", "create", "shop", "--hostname", "shop.example.org", "--self-signed"];
    expect(await run(args, h.ctx)).toBe(0);
    expect(h.calls.some((c) => c.command === "useradd" && c.args.includes("dcabsm-shop"))).toBe(
      true,
    );
    expect(await exists(backups("shop"))).toBe(false);
    expect(await exists(backups(`shop.removed-${STAMP}`))).toBe(true);
  });
});
