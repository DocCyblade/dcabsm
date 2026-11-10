import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCert {
  cert: string;
  key: string;
}

/** A real certificate made with the local `openssl`, valid for 100 years from now. Test setup only. */
export function makeCert(
  hostname: string,
  opts: { days?: number; ca?: TestCert; encrypted?: boolean } = {},
): TestCert {
  const dir = mkdtempSync(join(tmpdir(), "dcabsm-cert-"));
  const f = (n: string) => join(dir, n);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "pipe" });
  try {
    const days = String(opts.days ?? 36500);
    const san = `subjectAltName=DNS:${hostname}`;
    const curve = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
    if (!opts.ca) {
      openssl(
        "req",
        "-x509",
        ...curve,
        "-days",
        days,
        "-subj",
        `/CN=${hostname}`,
        "-addext",
        san,
        "-keyout",
        f("key.pem"),
        "-out",
        f("cert.pem"),
      );
    } else {
      openssl(
        "req",
        "-new",
        ...curve,
        "-subj",
        `/CN=${hostname}`,
        "-keyout",
        f("key.pem"),
        "-out",
        f("csr.pem"),
      );
      writeFileSync(f("ca-cert.pem"), opts.ca.cert);
      writeFileSync(f("ca-key.pem"), opts.ca.key);
      writeFileSync(f("ext.cnf"), `${san}\n`);
      openssl(
        "x509",
        "-req",
        "-in",
        f("csr.pem"),
        "-CA",
        f("ca-cert.pem"),
        "-CAkey",
        f("ca-key.pem"),
        "-CAcreateserial",
        "-days",
        days,
        "-extfile",
        f("ext.cnf"),
        "-out",
        f("cert.pem"),
      );
    }
    let keyFile = f("key.pem");
    if (opts.encrypted) {
      openssl(
        "pkcs8",
        "-topk8",
        "-in",
        f("key.pem"),
        "-out",
        f("enc.pem"),
        "-passout",
        "pass:secret",
      );
      keyFile = f("enc.pem");
    }
    return { cert: readFileSync(f("cert.pem"), "utf8"), key: readFileSync(keyFile, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
