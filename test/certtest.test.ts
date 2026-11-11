import { afterEach, describe, expect, it } from "vitest";
import { instanceList } from "../src/instance/list.ts";
import { certChecks } from "../src/certs/doctor.ts";
import { certTest } from "../src/certs/test.ts";
import { hostFacts } from "../src/host/checks.ts";
import { makeCert } from "./certs.ts";
import { certHost, type CertHost } from "./certhost.ts";

let t: CertHost | undefined;
afterEach(() => t?.h.cleanup());

const a = makeCert("a.example.org");
const b = makeCert("b.example.org", { days: 10 });

const run = (...args: string[]) => certTest({ ctx: t!.h.ctx, args });
const result = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error & { code?: number }) => `${e.code}: ${e.message}`,
  );

async function setup(opts = {}) {
  t = await certHost(opts);
  t.add("a", "a.example.org", a);
  t.add("b", "b.example.org", b);
  t.reload();
  t.net.dns = { "a.example.org": ["127.0.0.1"], "b.example.org": ["127.0.0.1"] };
}
const out = () => t!.h.out.join("\n");

describe("cert test", () => {
  it("reports days left, a match with the disk and resolution; untrusted is a note", async () => {
    await setup();
    expect(await result(run("a"))).toBe("ok");
    expect(t!.h.out[0]).toBe("a  a.example.org");
    expect(out()).toContain("✓ Served certificate matches a.example.org and the file on disk");
    expect(out()).toMatch(/✓ 36\d{3} days left/);
    expect(out()).toContain("· Not trusted by system CAs (self-signed)");
    expect(out()).toContain("✓ Hostname resolves to this Host");
  });

  it("covers every Instance with no names or with --all", async () => {
    await setup();
    await run();
    expect(out()).toContain("b  b.example.org");
    t!.h.out.length = 0;
    await run("--all");
    expect(out()).toContain("a  a.example.org");
  });

  it("warns under 30 days and when the hostname does not resolve, and still exits 0", async () => {
    await setup();
    t!.net.dns = {};
    expect(await result(run("b"))).toBe("ok");
    expect(out()).toContain("! 9 days left");
    expect(out()).toContain("! Hostname does not resolve");
  });

  it("fails an expired certificate", async () => {
    await setup({ startAt: new Date(Date.now() + 11 * 86_400_000) });
    expect(await result(run("b"))).toMatch(/^1: 1 of 1 Instances failed/);
    expect(out()).toMatch(/✗ Expired \d+ days ago/);
  });

  it("fails when the served certificate differs from the file on disk", async () => {
    await setup();
    t!.net.served["a.example.org"] = makeCert("a.example.org").cert;
    expect(await result(run("a"))).toMatch(/^1:/);
    expect(out()).toContain("✗ Served certificate differs from the file on disk");
  });

  it("fails when the served certificate does not cover the hostname", async () => {
    await setup();
    t!.net.served["a.example.org"] = b.cert;
    expect(await result(run("a"))).toMatch(/^1:/);
    expect(out()).toContain("✗ Served certificate does not cover a.example.org");
  });

  it("fails when nothing answers, and goes on to the next Instance", async () => {
    await setup();
    delete t!.net.served["a.example.org"];
    expect(await result(run())).toMatch(/^1: 1 of 2 Instances failed/);
    expect(out()).toContain("✗ Could not connect to 127.0.0.1:443 as a.example.org");
    expect(out()).toContain("b  b.example.org");
  });

  it("fails a file on disk that does not cover the hostname when nothing is served", async () => {
    await setup();
    t!.add("c", "c.example.org", a);
    t!.reload();
    delete t!.net.served["c.example.org"];
    expect(await result(run("c"))).toMatch(/^1:/);
    expect(out()).toContain("✗ Certificate file does not cover c.example.org");
  });

  it("does not repeat the hostname failure when the served and disk certificates match", async () => {
    await setup();
    expect(await result(run("a"))).toBe("ok");
    expect(out()).not.toContain("Certificate file does not cover");
  });

  it("notes a hostname that resolves elsewhere", async () => {
    await setup();
    t!.net.dns["a.example.org"] = ["203.0.113.9"];
    await run("a");
    expect(out()).toContain("· Hostname resolves to 203.0.113.9, not an address on this Host");
  });

  it("refuses an unknown Instance", async () => {
    await setup();
    expect(await result(run("nope"))).toMatch(/^2: .*no Instance/);
  });
});

describe("instance list", () => {
  it("shows the certificate days left, and self-signed", async () => {
    await setup();
    const ca = makeCert("ca.example.org");
    t!.add("c", "c.example.org", makeCert("c.example.org", { ca }));
    await instanceList({ ctx: t!.h.ctx, args: [] });
    expect(t!.h.out[0]).toMatch(/PORT {3}CERT {12,}LAST SCHEDULED$/);
    expect(t!.h.out[1]).toMatch(/^a {8}.* 3\d{4}d self-signed +off$/);
    expect(t!.h.out[2]).toMatch(/^b {8}.* 9d self-signed +off$/);
    expect(t!.h.out[3]).toMatch(/^c {8}.* 3\d{4}d +off$/);
  });

  it("shows expired", async () => {
    await setup({ startAt: new Date(Date.now() + 11 * 86_400_000) });
    await instanceList({ ctx: t!.h.ctx, args: [] });
    expect(t!.h.out[2]).toMatch(/expired self-signed/);
  });
});

describe("host doctor's certificate check (spec 5.7)", () => {
  const check = () => certChecks[0]!.run(t!.h.ctx, hostFacts(t!.h.ctx));

  it("runs the cert test for every Instance, rating each finding", async () => {
    await setup();
    t!.net.dns = { "a.example.org": ["127.0.0.1"] };
    const results = await check();
    expect(results).toContainEqual({
      kind: "pass",
      label: "a: Served certificate matches a.example.org and the file on disk",
    });
    expect(results).toContainEqual({
      kind: "problem",
      severity: "note",
      message: "a: Not trusted by system CAs (self-signed)",
    });
    expect(results).toContainEqual({
      kind: "problem",
      severity: "warn",
      message: "b: 9 days left",
    });
    expect(results).toContainEqual({
      kind: "problem",
      severity: "warn",
      message: "b: Hostname does not resolve",
    });
  });

  it("fails an Instance whose served certificate differs from the file on disk", async () => {
    await setup();
    // A renewed file is on disk and Nginx has not reloaded.
    t!.add("a", "a.example.org", makeCert("a.example.org"));
    const results = await check();
    expect(results).toContainEqual({
      kind: "problem",
      severity: "fail",
      message:
        "a: Served certificate differs from the file on disk. Reload Nginx: sudo systemctl reload nginx",
    });
  });

  it("has nothing to say on a Host with no Instances", async () => {
    t = await certHost();
    expect(await check()).toEqual([]);
  });
});
