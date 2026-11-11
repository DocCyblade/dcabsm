import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vhostConf } from "../src/instance/files.ts";
import { instanceSetHostname } from "../src/instance/set-hostname.ts";
import { makeCert } from "./certs.ts";
import { certHost, type CertHost } from "./certhost.ts";

let t: CertHost | undefined;
afterEach(() => t?.h.cleanup());

const wild = makeCert("*.example.org");
const other = makeCert("kids.other.org");

const file = (name: string) => join(t!.h.root, name);
const dir = (name: string, ...rest: string[]) => join(t!.h.ctx.paths.instances, name, ...rest);
const disk = (name: string, ...rest: string[]) => readFileSync(dir(name, ...rest), "utf8");
const record = (name: string) => JSON.parse(disk(name, "config/instance.json"));
const run = (...args: string[]) => instanceSetHostname({ ctx: t!.h.ctx, args });
const result = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error & { code?: number }) => `${e.code}: ${e.message}`,
  );

/** Instance `family` on a wildcard certificate, with the vhost Nginx would have. */
async function setup(opts = {}) {
  t = await certHost(opts);
  t.add("family", "family.example.org", wild);
  t.add("work", "work.example.org", wild);
  writeFileSync(dir("family", "nginx/vhost.conf"), vhostConf("family", record("family"), false));
  t.reload();
  t.reloads = 0;
  mkdirSync(t.h.root, { recursive: true });
  writeFileSync(file("other.pem"), other.cert);
  writeFileSync(file("other-key.pem"), other.key);
}

describe("instance set-hostname", () => {
  it("reuses a current certificate that covers the new name", async () => {
    await setup();
    await run("family", "kids.example.org");
    expect(record("family").hostname).toBe("kids.example.org");
    expect(disk("family", "nginx/vhost.conf")).toBe(vhostConf("family", record("family"), false));
    expect(disk("family", "nginx/vhost.conf")).not.toContain("family.example.org");
    expect(disk("family", "nginx/cert.pem")).toBe(wild.cert);
    expect(t!.reloads).toBe(1);
    const out = t!.h.out.join("\n");
    expect(out).toContain("Certificate covers kids.example.org");
    expect(out).toContain("Nginx: nginx -t passed, reloaded");
    expect(out).toContain("Served certificate for kids.example.org confirmed");
  });

  it("never restarts Actual and says OpenID login fails until updated", async () => {
    await setup();
    await run("family", "kids.example.org");
    expect(
      t!.h.calls.filter((c) => c.args.includes("restart") || c.args.includes("start")),
    ).toEqual([]);
    const out = t!.h.out.join("\n");
    expect(out).toContain("Devices must use https://kids.example.org now");
    expect(out).toContain("OpenID login fails");
    expect(out).toContain("provider's redirect URL");
  });

  it("swaps in --cert and --key when the current certificate does not cover the name", async () => {
    await setup();
    await run(
      "family",
      "kids.other.org",
      "--cert",
      file("other.pem"),
      "--key",
      file("other-key.pem"),
    );
    expect(record("family").hostname).toBe("kids.other.org");
    expect(disk("family", "nginx/cert.pem")).toBe(other.cert);
    expect(disk("family", "nginx/key.pem")).toBe(other.key);
    expect(disk("family", "nginx/vhost.conf")).toContain("server_name kids.other.org;");
  });

  it("checks --cert alone against the current key", async () => {
    await setup();
    expect(await result(run("family", "kids.other.org", "--cert", file("other.pem")))).toMatch(
      /^2: .*does not match/,
    );
    expect(record("family").hostname).toBe("family.example.org");
  });

  it("makes a self-signed certificate with --self-signed", async () => {
    await setup();
    await run("family", "kids.other.org", "--self-signed");
    expect(record("family").hostname).toBe("kids.other.org");
    expect(disk("family", "nginx/cert.pem")).not.toBe(wild.cert);
    expect(t!.h.out.join("\n")).toContain("(self-signed)");
  });

  it("asks on a terminal when nothing covers the name", async () => {
    await setup({ interactive: true, answers: ["1"] });
    await run("family", "kids.other.org");
    expect(t!.h.out.join("\n")).toContain("No certificate given for kids.other.org");
    expect(record("family").hostname).toBe("kids.other.org");
    expect(disk("family", "nginx/cert.pem")).not.toBe(wild.cert);
  });

  it("refuses with no terminal and no covering certificate, changing nothing", async () => {
    await setup();
    expect(await result(run("family", "kids.other.org"))).toMatch(/^2: No terminal to ask/);
    expect(record("family").hostname).toBe("family.example.org");
    expect(disk("family", "nginx/cert.pem")).toBe(wild.cert);
    expect(t!.reloads).toBe(0);
  });

  it("refuses a given certificate that does not cover the name", async () => {
    await setup();
    expect(
      await result(
        run(
          "family",
          "kids.example.org",
          "--cert",
          file("other.pem"),
          "--key",
          file("other-key.pem"),
        ),
      ),
    ).toMatch(/^2: .*does not cover kids.example.org/);
    expect(record("family").hostname).toBe("family.example.org");
  });

  it("applies create's hostname checks", async () => {
    await setup();
    expect(await result(run("family", "Kids.Example.org"))).toMatch(/not a valid hostname/);
    expect(await result(run("family", "*.example.org"))).toMatch(/not a valid hostname/);
    expect(await result(run("family", "work.example.org"))).toMatch(
      /Instance work already uses work.example.org/,
    );
    expect(record("family").hostname).toBe("family.example.org");
  });

  it("refuses a hostname Nginx already serves", async () => {
    await setup();
    t!.nginxDump = "server_name kids.example.org;\n";
    expect(await result(run("family", "kids.example.org"))).toMatch(/Nginx already serves/);
  });

  it("changes nothing when the name is already the Instance's", async () => {
    await setup();
    await run("family", "family.example.org");
    expect(t!.reloads).toBe(0);
    expect(t!.h.out.join("\n")).toContain("already uses family.example.org");
  });

  it("refuses an unknown Instance, a wrong argument count and an unfinished Release change", async () => {
    await setup();
    expect(await result(run("nope", "kids.example.org"))).toMatch(/no Instance named nope/);
    expect(await result(run("family"))).toMatch(/Give an Instance name and the new hostname/);
    writeFileSync(dir("family", ".changing-release"), "{}");
    expect(await result(run("family", "kids.example.org"))).toMatch(/unfinished Release change/);
  });

  it("puts everything back when nginx -t fails", async () => {
    await setup();
    t!.testFails = "bad vhost";
    const vhost = disk("family", "nginx/vhost.conf");
    expect(
      await result(
        run(
          "family",
          "kids.other.org",
          "--cert",
          file("other.pem"),
          "--key",
          file("other-key.pem"),
        ),
      ),
    ).toMatch(/nginx -t failed: bad vhost/);
    expect(record("family").hostname).toBe("family.example.org");
    expect(disk("family", "nginx/vhost.conf")).toBe(vhost);
    expect(disk("family", "nginx/cert.pem")).toBe(wild.cert);
    expect(disk("family", "nginx/key.pem")).toBe(wild.key);
  });

  it("puts everything back when Nginx does not serve the new name", async () => {
    await setup({ clockStepMs: 1000 });
    t!.reloadIgnored = true;
    const vhost = disk("family", "nginx/vhost.conf");
    expect(await result(run("family", "kids.example.org"))).toMatch(/Nginx is not serving/);
    expect(record("family").hostname).toBe("family.example.org");
    expect(disk("family", "nginx/vhost.conf")).toBe(vhost);
  });
});
