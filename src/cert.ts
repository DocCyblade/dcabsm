import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import type { Context } from "./context.ts";
import { refusal } from "./errors.ts";

/** What a certificate and key passed. Shared by create, `cert update`, `set-hostname` and Clone (spec 5.6). */
export interface CertificateInfo {
  /** The full chain as PEM, leaf first, ready to write as `cert.pem`. */
  certPem: string;
  /** The key as PEM. */
  keyPem: string;
  notAfter: Date;
  daysLeft: number;
  /** Things worth saying that do not stop the command, such as an untrusted chain. */
  warnings: string[];
}

export interface CertificateInput {
  certPem: string;
  keyPem: string;
  hostname: string;
}

const DAY_MS = 86_400_000;
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function parseChain(certPem: string): X509Certificate[] {
  const blocks = certPem.match(PEM_BLOCK) ?? [];
  if (blocks.length === 0) throw refusal("The certificate file holds no PEM certificate.");
  try {
    return blocks.map((b) => new X509Certificate(b));
  } catch {
    throw refusal("The certificate file is not a valid PEM certificate.");
  }
}

export function parsePrivateKey(keyPem: string): KeyObject {
  if (/ENCRYPTED/.test(keyPem)) {
    throw refusal(
      "The key is protected by a passphrase.",
      "Remove the passphrase first, e.g. openssl pkey -in key.pem -out key-plain.pem",
    );
  }
  try {
    return createPrivateKey(keyPem);
  } catch (err) {
    throw /passphrase/i.test(String(err))
      ? refusal("The key is protected by a passphrase.")
      : refusal("The key file is not a usable PEM private key.");
  }
}

let roots: X509Certificate[] | undefined;
function systemRoots(): X509Certificate[] {
  roots ??= rootCertificates.map((pem) => new X509Certificate(pem));
  return roots;
}

/** Whether the chain, as given, leads to a root the system trusts. */
function chainTrusted(chain: X509Certificate[]): boolean {
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i]!;
    const next = chain[i + 1];
    if (systemRoots().some((r) => r.fingerprint256 === cert.fingerprint256)) return true;
    if (systemRoots().some((r) => cert.checkIssued(r) && cert.verify(r.publicKey))) return true;
    if (!next || !(cert.checkIssued(next) && cert.verify(next.publicKey))) return false;
  }
  return false;
}

/**
 * Refuses, with no override, an expired or not-yet-valid certificate, a hostname it does not cover,
 * a key that does not match, and a passphrase-protected key. An untrusted chain only warns.
 */
export function validateCertificate(ctx: Context, input: CertificateInput): CertificateInfo {
  const chain = parseChain(input.certPem);
  const leaf = chain[0]!;
  const key = parsePrivateKey(input.keyPem);

  const now = ctx.now();
  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (now < notBefore) {
    throw refusal(`The certificate is not valid until ${notBefore.toISOString()}.`);
  }
  if (now > notAfter) {
    throw refusal(`The certificate expired on ${notAfter.toISOString()}.`);
  }
  if (!leaf.checkHost(input.hostname)) {
    throw refusal(
      `The certificate does not cover ${input.hostname}.`,
      `It is valid for: ${leaf.subjectAltName ?? leaf.subject}`,
    );
  }
  if (!leaf.checkPrivateKey(key)) throw refusal("The key does not match the certificate.");

  const warnings = chainTrusted(chain) ? [] : ["The certificate is not trusted by the system CAs."];
  return {
    certPem: `${chain.map((c) => c.toString().trim()).join("\n")}\n`,
    keyPem: input.keyPem.trim() + "\n",
    notAfter,
    daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / DAY_MS),
    warnings,
  };
}

/** What a certificate chain looks like to a client, without refusing anything (spec 5.7). */
export interface ChainFacts {
  /** The SHA-256 fingerprint of the leaf. */
  fingerprint: string;
  notAfter: Date;
  /** Negative once expired. */
  daysLeft: number;
  /** Whether the leaf covers the hostname. */
  covers: boolean;
  /** Whether the chain leads to a root the system trusts. */
  trusted: boolean;
  /** One certificate that signed itself. */
  selfSigned: boolean;
}

/** Reads a chain as it is, for `cert test` and `instance list`. Throws a refusal if it holds no certificate. */
export function inspectChain(ctx: Context, certPem: string, hostname: string): ChainFacts {
  const chain = parseChain(certPem);
  const leaf = chain[0]!;
  const notAfter = new Date(leaf.validTo);
  return {
    fingerprint: leaf.fingerprint256,
    notAfter,
    daysLeft: Math.floor((notAfter.getTime() - ctx.now().getTime()) / DAY_MS),
    covers: Boolean(leaf.checkHost(hostname)),
    trusted: chainTrusted(chain),
    selfSigned: chain.length === 1 && leaf.checkIssued(leaf),
  };
}

async function readPem(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw refusal(`Cannot read the ${what} file ${path}.`);
  }
}

/** Reads a certificate file and a key file, then validates them for `hostname`. */
export async function validateCertificateFiles(
  ctx: Context,
  files: { cert: string; key: string; hostname: string },
): Promise<CertificateInfo> {
  return validateCertificate(ctx, {
    certPem: await readPem(files.cert, "certificate"),
    keyPem: await readPem(files.key, "key"),
    hostname: files.hostname,
  });
}
