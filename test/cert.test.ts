import { afterEach, describe, expect, it } from "vitest";
import { validateCertificate } from "../src/cert.ts";
import { harness, type Harness } from "./helpers.ts";
import { makeCert } from "./certs.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());
const host = "shop.example.org";
const valid = makeCert(host);

async function check(certPem: string, keyPem: string, hostname = host, now?: Date) {
  h = await harness({ startAt: now ?? new Date() });
  return validateCertificate(h.ctx, { certPem, keyPem, hostname });
}
const refused = (p: Promise<unknown>) =>
  p.then(
    () => "accepted",
    (e: Error & { code?: number }) => `${e.code}: ${e.message}`,
  );

describe("validateCertificate", () => {
  it("accepts a certificate for the hostname and reports the days left", async () => {
    const info = await check(valid.cert, valid.key);
    expect(info.daysLeft).toBeGreaterThan(36000);
    expect(info.certPem).toContain("BEGIN CERTIFICATE");
  });

  it("warns, but accepts, when the chain is not trusted", async () => {
    const info = await check(valid.cert, valid.key);
    expect(info.warnings).toEqual(["The certificate is not trusted by the system CAs."]);
  });

  it("accepts a wildcard that covers the hostname", async () => {
    const w = makeCert("*.example.org");
    expect((await check(w.cert, w.key)).daysLeft).toBeGreaterThan(0);
  });

  it("keeps the full chain, leaf first", async () => {
    const ca = makeCert("ca.example.org");
    const leaf = makeCert(host, { ca });
    const info = await check(leaf.cert + ca.cert, leaf.key);
    expect(info.certPem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(info.certPem.startsWith(leaf.cert.trim())).toBe(true);
  });

  it("refuses an expired certificate", async () => {
    expect(await refused(check(valid.cert, valid.key, host, new Date("2200-01-01")))).toMatch(
      /^2: .*expired/,
    );
  });

  it("refuses a certificate that is not valid yet", async () => {
    expect(await refused(check(valid.cert, valid.key, host, new Date("2000-01-01")))).toMatch(
      /^2: .*not valid until/,
    );
  });

  it("refuses a hostname the certificate does not cover", async () => {
    expect(await refused(check(valid.cert, valid.key, "other.example.org"))).toMatch(
      /^2: .*other\.example\.org/,
    );
  });

  it("refuses a key that does not match", async () => {
    const other = makeCert(host);
    expect(await refused(check(valid.cert, other.key))).toMatch(/^2: .*does not match/);
  });

  it("refuses a passphrase-protected key", async () => {
    const enc = makeCert(host, { encrypted: true });
    expect(await refused(check(enc.cert, enc.key))).toMatch(/^2: .*passphrase/);
  });

  it("refuses text that is not a certificate or not a key", async () => {
    expect(await refused(check("nope", valid.key))).toMatch(/^2: .*certificate/);
    expect(await refused(check(valid.cert, "nope"))).toMatch(/^2: .*key/);
  });
});
