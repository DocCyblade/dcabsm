import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { certUpdate } from "../src/certs/update.ts";
import { makeCert } from "./certs.ts";
import { certHost, type CertHost } from "./certhost.ts";

let t: CertHost | undefined;
afterEach(() => t?.h.cleanup());

const oldA = makeCert("a.example.org");
const oldB = makeCert("b.example.org");
const wild = makeCert("*.example.org");

const file = (name: string) => join(t!.h.root, name);
const disk = (name: string, f: "cert.pem" | "key.pem") =>
  readFileSync(join(t!.h.ctx.paths.instances, name, "nginx", f), "utf8");
const run = (...args: string[]) => certUpdate({ ctx: t!.h.ctx, args });
const result = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error & { code?: number }) => `${e.code}: ${e.message}`,
  );

async function setup(opts = {}) {
  t = await certHost(opts);
  t.add("a", "a.example.org", oldA);
  t.add("b", "b.example.org", oldB);
  t.reload();
  t.reloads = 0;
  writeFileSync(file("new.pem"), wild.cert);
  writeFileSync(file("new-key.pem"), wild.key);
}

describe("cert update", () => {
  it("swaps the certificate and key of every named Instance, reloads and confirms", async () => {
    await setup();
    await run("a", "b", "--cert", file("new.pem"), "--key", file("new-key.pem"));
    for (const n of ["a", "b"]) {
      expect(disk(n, "cert.pem")).toBe(wild.cert);
      expect(disk(n, "key.pem")).toBe(wild.key);
    }
    expect(t!.reloads).toBe(1);
    expect(t!.h.calls.some((c) => c.command === "nginx" && c.args[0] === "-t")).toBe(true);
    expect(t!.h.out.join("\n")).toContain("a: now serving the new certificate");
    expect(t!.h.out).toContain("  · Actual was not restarted.");
    expect(t!.h.calls.filter((c) => c.args.includes("restart"))).toEqual([]);
  });

  it("covers every Instance with --all", async () => {
    await setup();
    await run("--all", "--cert", file("new.pem"), "--key", file("new-key.pem"));
    expect(disk("a", "cert.pem")).toBe(wild.cert);
    expect(disk("b", "cert.pem")).toBe(wild.cert);
  });

  it("checks the current key against the new certificate without --key", async () => {
    await setup();
    // A renewal that keeps the key, as certbot does with --reuse-key.
    t!.add("a", "a.example.org", wild);
    t!.reload();
    const renewed = makeCert("*.example.org");
    writeFileSync(file("new.pem"), renewed.cert);
    expect(await result(run("a", "--cert", file("new.pem")))).toMatch(/^2: .*does not match/);
    expect(disk("a", "cert.pem")).toBe(wild.cert);
    writeFileSync(file("new.pem"), wild.cert);
    await run("a", "--cert", file("new.pem"));
    expect(disk("a", "key.pem")).toBe(wild.key);
    expect(t!.h.out.join("\n")).toContain("matches the current key");
  });

  it("refuses a key that does not match, changing nothing for any Instance", async () => {
    await setup();
    expect(await result(run("a", "b", "--cert", file("new.pem")))).toMatch(/^2: .*does not match/);
    expect(disk("a", "cert.pem")).toBe(oldA.cert);
    expect(disk("b", "cert.pem")).toBe(oldB.cert);
    expect(t!.reloads).toBe(0);
  });

  it("refuses when one Instance's hostname is not covered, changing nothing", async () => {
    await setup();
    t!.add("c", "c.example.com", makeCert("c.example.com"));
    expect(
      await result(run("a", "c", "--cert", file("new.pem"), "--key", file("new-key.pem"))),
    ).toMatch(/^2: .*example\.com/);
    expect(disk("a", "cert.pem")).toBe(oldA.cert);
    expect(t!.reloads).toBe(0);
  });

  it("refuses an expired certificate and a passphrase-protected key", async () => {
    await setup({ startAt: new Date("2200-01-01") });
    expect(await result(run("a", "--cert", file("new.pem"), "--key", file("new-key.pem")))).toMatch(
      /^2: .*expired/,
    );
    await t!.h.cleanup();
    await setup();
    const enc = makeCert("*.example.org", { encrypted: true });
    writeFileSync(file("enc.pem"), enc.key);
    expect(await result(run("a", "--cert", file("new.pem"), "--key", file("enc.pem")))).toMatch(
      /^2: .*passphrase/,
    );
  });

  it("warns about an untrusted chain but still swaps", async () => {
    await setup();
    await run("a", "--cert", file("new.pem"), "--key", file("new-key.pem"));
    expect(t!.h.out.join("\n")).toContain("! a: The certificate is not trusted by the system CAs.");
  });

  it("restores the old files and exits non-zero when nginx -t fails, without reloading", async () => {
    await setup();
    t!.testFails = "nginx: [emerg] bad";
    expect(
      await result(run("a", "b", "--cert", file("new.pem"), "--key", file("new-key.pem"))),
    ).toMatch(/^1: .*nginx -t failed: nginx: \[emerg\] bad/);
    expect(disk("a", "cert.pem")).toBe(oldA.cert);
    expect(disk("b", "key.pem")).toBe(oldB.key);
    expect(t!.reloads).toBe(0);
  });

  it("restores the old files and reloads again when the new certificate is not served in 5 seconds", async () => {
    await setup({ clockStepMs: 1000 });
    t!.reloadIgnored = true;
    expect(await result(run("a", "--cert", file("new.pem"), "--key", file("new-key.pem")))).toMatch(
      /^1: .*a: .*not serving the new certificate within 5 seconds/,
    );
    expect(disk("a", "cert.pem")).toBe(oldA.cert);
    expect(disk("a", "key.pem")).toBe(oldA.key);
    expect(t!.reloads).toBe(2);
    expect(t!.h.calls.filter((c) => c.args.includes("restart"))).toEqual([]);
  });

  it("refuses unknown Instances, a missing --cert, and names with --all", async () => {
    await setup();
    expect(await result(run("nope", "--cert", file("new.pem")))).toMatch(/^2: .*no Instance/);
    expect(await result(run("a"))).toMatch(/^2: .*--cert/);
    expect(await result(run("a", "--all", "--cert", file("new.pem")))).toMatch(/^2: .*not both/);
    expect(await result(run("--cert", file("new.pem")))).toMatch(/^2: .*at least one/);
  });
});
