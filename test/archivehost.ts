import { copyFileSync, readlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { makeWritable } from "../src/fsutil.ts";
import { makeCert } from "./certs.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";
import { harness, type Harness } from "./helpers.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

const GROUP_SCHEMA = `
CREATE TABLE messages_binary (timestamp TEXT PRIMARY KEY, is_encrypted BOOLEAN, content bytea);
CREATE TABLE messages_merkles (id INTEGER PRIMARY KEY, merkle TEXT);`;

/** A Host with Instance `shop` (a Budget file in its data) and a Backup of it, for the --from and clone tests. */
export interface ArchiveHost {
  h: Harness;
  net: FakeNet;
  host: FakeHost;
  /** What `nginx -T` prints, for the hostname-in-use check. */
  nginxT: { text: string };
  /** The archive of `shop`, copied out of its Backups to a path of its own. */
  archive: string;
  inst(name: string, ...parts: string[]): string;
  backups(...parts: string[]): string;
  out(): string;
  err(): string;
  /** Group ids in an Instance's `account.sqlite`. */
  groupIds(name: string): string[];
  messagesIn(name: string, group: string): string[];
  /** Calls to systemctl that changed something, as `verb unit`. */
  sysctls(): string[];
  /** Forgets the Instance `shop` the way a new Host never had it, keeping its archive. */
  loseShop(): Promise<void>;
}

export interface StartOptions {
  startAt?: Date;
  interactive?: boolean;
  answers?: string[];
  /** The Release `shop` runs. Default 26.11.0. */
  release?: string;
  settings?: Record<string, string>;
}

const fixture = (release: string) =>
  join(import.meta.dirname, "fixtures", `actual-${release}`, "account.sqlite");

export async function startArchiveHost(opts: StartOptions = {}): Promise<ArchiveHost> {
  const host = fakeHost();
  const net = fakeNet({ serverVersion: "26.11.0" });
  const nginxT = { text: "" };
  let hRef: Harness | undefined;
  const inst = (name: string, ...parts: string[]) =>
    join(hRef!.ctx.paths.instances, name, ...parts);
  const h = await harness({
    net,
    startAt: opts.startAt ?? new Date(Date.now() + 60_000),
    interactive: opts.interactive,
    answers: opts.answers,
    runner: (command, args) => {
      if (command === "openssl") {
        // A real certificate, since restore and clone read the one in the archive.
        const cn = args[args.indexOf("-subj") + 1]!.slice("/CN=".length);
        const made = makeCert(cn);
        writeFileSync(args[args.indexOf("-keyout") + 1]!, made.key);
        writeFileSync(args[args.indexOf("-out") + 1]!, made.cert);
        return ok();
      }
      if (command === "nginx" && args[0] === "-T") return ok(nginxT.text);
      if (command === "systemctl" && args[0] === "is-active") {
        const up = host.active.has(args.at(-1)!);
        return { code: up ? 0 : 3, stdout: up ? "active\n" : "inactive\n", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "start") {
        const name = args.at(-1)!.replace(/^dcabsm@/, "");
        try {
          net.serverVersion = basename(readlinkSync(inst(name, "release")));
        } catch {
          // No link yet: nothing to report.
        }
      }
      return host.run(command, args);
    },
  });
  hRef = h;
  const p = h.ctx.paths;
  for (const d of [p.releases, p.node, p.instances, p.acme]) await mkdir(d, { recursive: true });
  const release = opts.release ?? "26.11.0";
  expect(await run(["release", "install", release], h.ctx)).toBe(0);
  const create = ["instance", "create", "shop", "--hostname", "shop.example.org", "--self-signed"];
  expect(await run([...create, "--release", release, "--yes"], h.ctx)).toBe(0);
  for (const [key, value] of Object.entries(opts.settings ?? {})) {
    expect(await run(["instance", "set", "shop", key, value, "--yes"], h.ctx)).toBe(0);
  }
  const backups = (...parts: string[]) => join(p.under("/srv/dcabsm/backups"), ...parts);
  await mkdir(backups(), { recursive: true, mode: 0o700 });

  await writeFile(inst("shop", "data", "notes"), "v1");
  copyFileSync(fixture("26.11.0"), inst("shop", "server-files", "account.sqlite"));
  const db = new DatabaseSync(inst("shop", "server-files", "account.sqlite"));
  db.prepare(
    "INSERT INTO files (id, group_id, sync_version, name) VALUES ('file-one', 'group-one', 2, 'Budget')",
  ).run();
  db.close();
  const g = new DatabaseSync(inst("shop", "user-files", "group-group-one.sqlite"));
  g.exec(GROUP_SCHEMA);
  for (const m of ["m1", "m2"]) g.prepare("INSERT INTO messages_binary VALUES (?, 0, ?)").run(m, m);
  g.close();

  expect(await run(["backup", "create", "shop"], h.ctx)).toBe(0);
  const taken = (await readdir(backups("shop")))[0]!;
  const archive = join(h.root, "shop-backup.tar.gz");
  await rename(backups("shop", taken), archive);

  h.out.length = 0;
  h.calls.length = 0;
  return {
    h,
    net,
    host,
    nginxT,
    archive,
    inst,
    backups,
    out: () => h.out.join("\n"),
    err: () => h.err.join("\n"),
    groupIds(name) {
      const d = new DatabaseSync(inst(name, "server-files", "account.sqlite"));
      const rows = d.prepare("SELECT group_id FROM files ORDER BY id").all() as Array<{
        group_id: string;
      }>;
      d.close();
      return rows.map((r) => r.group_id);
    },
    messagesIn(name, group) {
      const d = new DatabaseSync(inst(name, "user-files", `group-${group}.sqlite`));
      const rows = d
        .prepare("SELECT timestamp FROM messages_binary ORDER BY timestamp")
        .all() as Array<{ timestamp: string }>;
      d.close();
      return rows.map((r) => r.timestamp);
    },
    sysctls: () =>
      h.calls
        .filter(
          (c) =>
            c.command === "systemctl" &&
            !["is-active", "show", "daemon-reload", "reset-failed"].includes(c.args[0]!),
        )
        .map((c) => c.args.join(" ")),
    async loseShop() {
      await makeWritable(inst("shop"));
      await rm(inst("shop"), { recursive: true, force: true });
      host.active.delete("dcabsm@shop");
      h.calls.length = 0;
      h.out.length = 0;
    },
  };
}
