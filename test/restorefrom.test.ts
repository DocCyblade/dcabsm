import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { makeWritable } from "../src/fsutil.ts";
import { startArchiveHost, type ArchiveHost } from "./archivehost.ts";
import { makeCert } from "./certs.ts";

let t: ArchiveHost;
afterEach(() => t.h.cleanup());

const restoreFrom = (...args: string[]) => run(["instance", "restore", "--from", ...args], t.h.ctx);

describe("instance restore --from", () => {
  it("rebuilds the Instance on a new Host from its archive", async () => {
    t = await startArchiveHost({ settings: { "upload-limit-mb": "60" } });
    const oldCert = await readFile(t.inst("shop", "nginx", "cert.pem"), "utf8");
    // The archive was taken after the settings were set; this Host never had `shop`.
    expect(await run(["backup", "create", "shop"], t.h.ctx)).toBe(0);
    const [file] = await readdir(t.backups("shop"));
    await t.loseShop();
    t.archive = t.backups("shop", file!);
    expect(await restoreFrom(t.archive), t.err()).toBe(0);

    // The files left behind: the archive's data, regrouped, and the archive's record and certificate.
    expect(await readFile(t.inst("shop", "data", "notes"), "utf8")).toBe("v1");
    const [group] = t.groupIds("shop");
    expect(group).not.toBe("group-one");
    expect(await readdir(t.inst("shop", "user-files"))).toEqual([`group-${group}.sqlite`]);
    expect(t.messagesIn("shop", group!)).toEqual(["m1", "m2"]);
    const record = JSON.parse(await readFile(t.inst("shop", "config", "instance.json"), "utf8"));
    expect(record).toEqual({
      port: 15127,
      hostname: "shop.example.org",
      scheduledBackups: true,
      createdAt: expect.any(String),
      settings: { "upload-limit-mb": 60 },
    });
    expect(await readFile(t.inst("shop", "nginx", "cert.pem"), "utf8")).toBe(oldCert);
    expect(await readFile(t.inst("shop", "nginx", "vhost.conf"), "utf8")).toContain(
      "server_name shop.example.org;",
    );
    expect(await readFile(t.inst("shop", "nginx", "vhost.conf"), "utf8")).toContain(
      "client_max_body_size 61m;",
    );
    const config = JSON.parse(await readFile(t.inst("shop", "config", "config.json"), "utf8"));
    expect(config.port).toBe(15127);
    expect(config.dataDir).toBe("/srv/dcabsm/instances/shop/data");
    expect((await readdir(t.h.ctx.paths.instances)).sort()).toEqual(["shop"]);

    // The account, ownership, nginx -t before the reload, and the start.
    const calls = t.h.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    expect(calls.some((c) => c.startsWith("useradd") && c.endsWith("dcabsm-shop"))).toBe(true);
    const owner = t.h.calls.filter((c) => c.command === "chown" && c.args[0] === "-R").at(-1)!;
    expect(owner.args[1]).toBe("dcabsm-shop:dcabsm-shop");
    expect(calls.indexOf("nginx -t")).toBeGreaterThan(-1);
    expect(calls.indexOf("nginx -t")).toBeLessThan(calls.indexOf("systemctl reload nginx"));
    expect(t.sysctls()).toContain("start dcabsm@shop");
    expect(t.sysctls()).toContain("enable dcabsm@shop");

    expect(t.out()).toContain(`Rebuild Instance shop from ${file}`);
    expect(t.out()).toContain("Port 15127 is free, kept");
    expect(t.out()).toContain("Started and verified: /health UP, /info 26.11.0");
    expect(t.out()).toContain("Point DNS for shop.example.org at this Host.");
    expect(t.out()).toContain("Click Revert");
  });

  it("refuses an existing name and points to restore and clone --from", async () => {
    t = await startArchiveHost();
    expect(await restoreFrom(t.archive)).toBe(2);
    expect(t.err()).toContain("an Instance named shop already exists here");
    expect(t.err()).toContain(`instance restore shop ${t.archive}`);
    expect(t.err()).toContain(`instance clone --from ${t.archive}`);
    expect(t.sysctls()).toEqual([]);
  });

  it("takes a new port when the archived one is in use", async () => {
    t = await startArchiveHost();
    await t.loseShop();
    t.host.listeners = "LISTEN 0 511 127.0.0.1:15127 0.0.0.0:*\n";
    expect(await restoreFrom(t.archive), t.err()).toBe(0);
    const record = JSON.parse(await readFile(t.inst("shop", "config", "instance.json"), "utf8"));
    expect(record.port).toBe(15128);
    expect(JSON.parse(await readFile(t.inst("shop", "config", "config.json"), "utf8")).port).toBe(
      15128,
    );
    expect(await readFile(t.inst("shop", "nginx", "vhost.conf"), "utf8")).toContain(
      "proxy_pass http://127.0.0.1:15128;",
    );
    expect(t.out()).toContain("Port 15127 is in use here, so shop takes 15128");
  });

  it("keeps an expired certificate with a warning pointing to cert update", async () => {
    // The Host clock is far ahead of the certificate's year; the archive's certificate is the expired one.
    t = await startArchiveHost({ startAt: new Date("2040-01-01T00:00:00Z") });
    const old = makeCert("shop.example.org", { days: 1 });
    await writeFile(t.inst("shop", "nginx", "cert.pem"), old.cert);
    await writeFile(t.inst("shop", "nginx", "key.pem"), old.key);
    expect(await run(["backup", "create", "shop"], t.h.ctx)).toBe(0);
    const [file] = await readdir(t.backups("shop"));
    await t.loseShop();
    expect(await restoreFrom(t.backups("shop", file!))).toBe(0);
    expect(await readFile(t.inst("shop", "nginx", "cert.pem"), "utf8")).toBe(old.cert);
    expect(await readFile(t.inst("shop", "nginx", "key.pem"), "utf8")).toBe(old.key);
    expect(t.out()).toMatch(/! Certificate from the archive expired \d+ days ago/);
    expect(t.out()).toContain("sudo dcabsm cert update shop");
    expect(t.out()).toContain("Started and verified");
  });

  it("applies create's hostname check", async () => {
    t = await startArchiveHost();
    await t.loseShop();
    t.nginxT.text = "server {\n    server_name shop.example.org;\n}\n";
    expect(await restoreFrom(t.archive)).toBe(2);
    expect(t.err()).toContain("Nginx already serves shop.example.org");
    // Nothing was built.
    expect(await readdir(t.h.ctx.paths.instances)).toEqual([]);
    expect(t.h.calls.some((c) => c.command === "useradd")).toBe(false);
  });

  it("installs the archive's Release when it is missing", async () => {
    t = await startArchiveHost();
    await t.loseShop();
    await makeWritable(t.h.ctx.paths.releases);
    await rm(`${t.h.ctx.paths.releases}/26.11.0`, { recursive: true, force: true });
    expect(await restoreFrom(t.archive), t.err()).toBe(0);
    expect((await stat(`${t.h.ctx.paths.releases}/26.11.0`)).isDirectory()).toBe(true);
    expect(t.out()).toContain("Started and verified: /health UP, /info 26.11.0");
  });

  it("leaves nothing behind when nginx -t fails", async () => {
    t = await startArchiveHost();
    await t.loseShop();
    t.host.nginxTest = { code: 1, stdout: "", stderr: "nginx: [emerg] bad" };
    expect(await restoreFrom(t.archive)).toBe(1);
    expect(t.err()).toContain("nginx -t failed");
    expect(await readdir(t.h.ctx.paths.instances)).toEqual([]);
    expect(t.h.calls.some((c) => c.command === "userdel")).toBe(true);
  });

  it("refuses a missing archive and an archive path given as a name", async () => {
    t = await startArchiveHost();
    expect(await restoreFrom("/nope/x.tar.gz")).toBe(2);
    expect(t.err()).toContain("is not an archive file");
    t.h.err.length = 0;
    expect(await run(["instance", "restore", "--from", t.archive, "shop"], t.h.ctx)).toBe(2);
    expect(t.err()).toContain("takes an archive and no Instance name");
  });
});
