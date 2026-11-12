import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { startArchiveHost, type ArchiveHost } from "./archivehost.ts";
import { makeCert } from "./certs.ts";

let t: ArchiveHost;
afterEach(() => t.h.cleanup());

const clone = (...args: string[]) => run(["instance", "clone", ...args], t.h.ctx);
const taken = () => t.h.calls.filter((c) => c.command === "tar" && c.args[0] === "-czf");

describe("instance clone from a source", () => {
  it("takes a pre-clone Backup, builds the copy under its own account, port and hostname", async () => {
    t = await startArchiveHost({ settings: { "upload-limit-mb": "60" } });
    const sourceGroups = t.groupIds("shop");
    expect(
      await clone("shop", "shop-test", "--hostname", "try.example.org", "--self-signed", "--yes"),
    ).toBe(0);

    // The source stopped briefly, was backed up and started again, before the copy started.
    expect(t.sysctls().slice(0, 2)).toEqual(["stop dcabsm@shop", "start dcabsm@shop"]);
    expect(t.sysctls()).toContain("start dcabsm@shop-test");
    const backups = await readdir(t.backups("shop"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^\d{8}T\d{6}Z-pre-clone-26\.11\.0\.tar\.gz$/);
    expect(taken()).toHaveLength(1);

    // The copy: its record, config and vhost carry the new port and hostname, and the source's settings.
    const record = JSON.parse(
      await readFile(t.inst("shop-test", "config", "instance.json"), "utf8"),
    );
    expect(record).toEqual({
      port: 15128,
      hostname: "try.example.org",
      scheduledBackups: true,
      settings: { "upload-limit-mb": 60 },
    });
    const config = JSON.parse(await readFile(t.inst("shop-test", "config", "config.json"), "utf8"));
    expect(config.port).toBe(15128);
    expect(config.dataDir).toBe("/srv/dcabsm/instances/shop-test/data");
    const vhost = await readFile(t.inst("shop-test", "nginx", "vhost.conf"), "utf8");
    expect(vhost).toContain("server_name try.example.org;");
    expect(vhost).toContain("proxy_pass http://127.0.0.1:15128;");
    expect(vhost).toContain("client_max_body_size 61m;");
    expect(await readFile(t.inst("shop-test", "data", "notes"), "utf8")).toBe("v1");

    // Regroup: the copy has new group ids, the source keeps its own, and both keep every message.
    const [group] = t.groupIds("shop-test");
    expect(group).not.toBe(sourceGroups[0]);
    expect(t.groupIds("shop")).toEqual(sourceGroups);
    expect(await readdir(t.inst("shop-test", "user-files"))).toEqual([`group-${group}.sqlite`]);
    expect(t.messagesIn("shop-test", group!)).toEqual(["m1", "m2"]);
    expect(t.messagesIn("shop", sourceGroups[0]!)).toEqual(["m1", "m2"]);

    // Its own account and ownership; the source's files are not touched.
    expect(
      t.h.calls.some((c) => c.command === "useradd" && c.args.at(-1) === "dcabsm-shop-test"),
    ).toBe(true);
    const owner = t.h.calls.filter((c) => c.command === "chown" && c.args[0] === "-R").at(-1)!;
    expect(owner.args[1]).toBe("dcabsm-shop-test:dcabsm-shop-test");
    expect(await readFile(t.inst("shop", "config", "instance.json"), "utf8")).toContain(
      "shop.example.org",
    );
    expect((await readdir(t.h.ctx.paths.instances)).sort()).toEqual(["shop", "shop-test"]);

    // The result says what was copied and what OpenID needs.
    expect(t.out()).toContain(
      "Logins are copied: everyone who can log in to shop can log in to shop-test",
    );
    expect(t.out()).toContain("OpenID");
    expect(t.out()).toContain(
      "add https://try.example.org/openid/callback as a redirect URL at the provider",
    );
    expect(t.out()).toContain("Started and verified: /health UP, /info 26.11.0");
  });

  it("needs --cert/--key or --self-signed when the source's certificate does not cover the hostname, before the source stops", async () => {
    t = await startArchiveHost();
    expect(await clone("shop", "shop-test", "--hostname", "try.example.org", "--yes")).toBe(2);
    expect(t.err()).toContain("--cert <f> --key <f>, or --self-signed");
    expect(t.out()).toContain("cannot be reused for try.example.org");
    expect(t.sysctls()).toEqual([]);
    expect(await readdir(t.backups("shop"))).toEqual([]);
    expect(await readdir(t.h.ctx.paths.instances)).toEqual(["shop"]);
  });

  it("reuses the source's certificate when it covers the new hostname", async () => {
    t = await startArchiveHost();
    const wild = makeCert("*.example.org");
    await writeFile(t.inst("shop", "nginx", "cert.pem"), wild.cert);
    await writeFile(t.inst("shop", "nginx", "key.pem"), wild.key);
    expect(await clone("shop", "shop-test", "--hostname", "try.example.org", "--yes")).toBe(0);
    expect(await readFile(t.inst("shop-test", "nginx", "cert.pem"), "utf8")).toBe(wild.cert);
    expect(await readFile(t.inst("shop-test", "nginx", "key.pem"), "utf8")).toBe(wild.key);
    expect((await stat(t.inst("shop-test", "nginx", "key.pem"))).mode & 0o777).toBe(0o600);
    expect(t.out()).toContain("Certificate: copied from shop (it covers try.example.org)");
  });

  it("uses the certificate given with --cert and --key", async () => {
    t = await startArchiveHost();
    const own = makeCert("try.example.org");
    await writeFile(join(t.h.root, "c.pem"), own.cert);
    await writeFile(join(t.h.root, "k.pem"), own.key);
    expect(
      await clone(
        "shop",
        "shop-test",
        "--hostname",
        "try.example.org",
        "--cert",
        join(t.h.root, "c.pem"),
        "--key",
        join(t.h.root, "k.pem"),
        "--yes",
      ),
    ).toBe(0);
    expect(await readFile(t.inst("shop-test", "nginx", "cert.pem"), "utf8")).toBe(own.cert);
  });

  it("asks before stopping the source, and a no changes nothing", async () => {
    t = await startArchiveHost({ interactive: true, answers: ["n"] });
    expect(await clone("shop", "shop-test", "--hostname", "try.example.org", "--self-signed")).toBe(
      1,
    );
    expect(t.h.asked).toEqual(["Continue? [y/N] "]);
    expect(t.out()).toContain("shop stops for a few seconds while it is backed up.");
    expect(t.sysctls()).toEqual([]);
    expect(await readdir(t.h.ctx.paths.instances)).toEqual(["shop"]);
  });

  it("refuses an existing name, a hostname in use, an unknown source and an unfinished change", async () => {
    t = await startArchiveHost();
    const base = ["--hostname", "try.example.org", "--self-signed", "--yes"];
    expect(await clone("shop", "shop", ...base)).toBe(2);
    expect(t.err()).toContain("needs a name of its own");
    t.h.err.length = 0;
    expect(await clone("nosuch", "other", ...base)).toBe(2);
    expect(t.err()).toContain("There is no Instance named nosuch");
    t.h.err.length = 0;
    expect(
      await clone("shop", "other", "--hostname", "shop.example.org", "--self-signed", "--yes"),
    ).toBe(2);
    expect(t.err()).toContain("Instance shop already uses shop.example.org");
    t.h.err.length = 0;
    expect(await clone("shop", "other", "--self-signed", "--yes")).toBe(2);
    expect(t.err()).toContain("--hostname is required");
    t.h.err.length = 0;
    await writeFile(t.inst("shop", ".changing-release"), "{}");
    expect(await clone("shop", "other", ...base)).toBe(2);
    expect(t.err()).toContain("unfinished Release change");
    expect(t.sysctls()).toEqual([]);
  });

  it("leaves nothing of the copy when nginx -t fails, and the source runs again", async () => {
    t = await startArchiveHost();
    t.host.nginxTest = { code: 1, stdout: "", stderr: "nginx: [emerg] bad" };
    expect(
      await clone("shop", "shop-test", "--hostname", "try.example.org", "--self-signed", "--yes"),
    ).toBe(1);
    expect(t.err()).toContain("nginx -t failed");
    expect(await readdir(t.h.ctx.paths.instances)).toEqual(["shop"]);
    expect(t.host.active.has("dcabsm@shop")).toBe(true);
    // The pre-clone Backup stays in the source's Backups.
    expect(await readdir(t.backups("shop"))).toHaveLength(1);
  });
});

describe("instance clone --from", () => {
  it("clones from an archive, takes no Backup and leaves the source alone", async () => {
    t = await startArchiveHost({ settings: { "upload-limit-mb": "60" } });
    expect(
      await clone(
        "--from",
        t.archive,
        "shop-test",
        "--hostname",
        "try.example.org",
        "--self-signed",
      ),
    ).toBe(0);
    expect(taken()).toHaveLength(0);
    expect(await readdir(t.backups("shop"))).toEqual([]);
    expect(t.sysctls()).toEqual([
      "reload nginx",
      "start dcabsm@shop-test",
      "enable dcabsm@shop-test",
    ]);
    const record = JSON.parse(
      await readFile(t.inst("shop-test", "config", "instance.json"), "utf8"),
    );
    expect(record.hostname).toBe("try.example.org");
    expect(record.port).toBe(15128);
    expect(record.settings).toEqual({ "upload-limit-mb": 60 });
    const [group] = t.groupIds("shop-test");
    expect(group).not.toBe("group-one");
    expect(t.messagesIn("shop-test", group!)).toEqual(["m1", "m2"]);
    expect(await readdir(t.h.ctx.paths.instances)).toEqual(["shop", "shop-test"]);
    expect(t.out()).toContain("Logins are copied");
    expect(t.out()).toContain("OpenID");
  });

  it("works when the archived Instance is gone, and needs a certificate for the new hostname", async () => {
    t = await startArchiveHost();
    await t.loseShop();
    expect(
      await clone("--from", t.archive, "shop2", "--hostname", "try.example.org", "--yes"),
    ).toBe(2);
    expect(t.err()).toContain("--self-signed");
    expect(await readdir(t.h.ctx.paths.instances)).toEqual([]);
    t.h.err.length = 0;
    expect(
      await clone("--from", t.archive, "shop2", "--hostname", "try.example.org", "--self-signed"),
    ).toBe(0);
    expect(await readdir(t.h.ctx.paths.instances)).toEqual(["shop2"]);
  });

  it("refuses a missing archive and a missing name", async () => {
    t = await startArchiveHost();
    expect(
      await clone("--from", "/nope.tar.gz", "x", "--hostname", "x.example.org", "--self-signed"),
    ).toBe(2);
    expect(t.err()).toContain("is not an archive file");
    t.h.err.length = 0;
    expect(await clone("--from", t.archive, "--hostname", "x.example.org", "--self-signed")).toBe(
      2,
    );
    expect(t.err()).toContain("Give the name of the new Instance");
  });
});
