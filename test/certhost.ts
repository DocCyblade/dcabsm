import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeNet, type FakeNet } from "./fakenet.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";
import { makeCert, type TestCert } from "./certs.ts";

/** A Host whose Nginx serves, after each reload, whatever certificate files are on disk. */
export interface CertHost {
  h: Harness;
  net: FakeNet;
  /** `nginx -t` fails with this message while set. */
  testFails?: string;
  /** What `nginx -T` prints: the `server_name` lines Nginx already has. */
  nginxDump: string;
  /** A reload leaves the old certificate served. */
  reloadIgnored: boolean;
  reloads: number;
  /** Writes an Instance with its record and certificate files. */
  add(name: string, hostname: string, cert: TestCert): void;
  /** Makes Nginx serve what is on disk now. */
  reload(): void;
}

export async function certHost(opts: HarnessOptions = {}): Promise<CertHost> {
  const net = fakeNet();
  const host: CertHost = {
    net,
    reloadIgnored: false,
    nginxDump: "",
    reloads: 0,
    add(name, hostname, cert) {
      const dir = join(host.h.ctx.paths.instances, name);
      mkdirSync(join(dir, "config"), { recursive: true });
      mkdirSync(join(dir, "nginx"), { recursive: true });
      writeFileSync(
        join(dir, "config/instance.json"),
        JSON.stringify({ port: 15127, hostname, scheduledBackups: false }),
      );
      writeFileSync(join(dir, "nginx/cert.pem"), cert.cert, { mode: 0o600 });
      writeFileSync(join(dir, "nginx/key.pem"), cert.key, { mode: 0o600 });
    },
    reload() {
      const root = host.h.ctx.paths.instances;
      for (const name of readdirSync(root)) {
        const record = JSON.parse(readFileSync(join(root, name, "config/instance.json"), "utf8"));
        net.served[record.hostname] = readFileSync(join(root, name, "nginx/cert.pem"), "utf8");
      }
    },
    h: undefined as unknown as Harness,
  };
  host.h = await harness({
    // A minute ahead: openssl dates a certificate made later in the test from the real clock.
    startAt: new Date(Date.now() + 60_000),
    ...opts,
    net,
    runner(command, args) {
      if (command === "openssl") {
        // `req -x509 ... -subj /CN=<host>`: a real certificate for that name.
        const made = makeCert(args[args.indexOf("-subj") + 1]!.slice(4));
        writeFileSync(args[args.indexOf("-keyout") + 1]!, made.key);
        writeFileSync(args[args.indexOf("-out") + 1]!, made.cert);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "nginx" && args[0] === "-T") {
        return { code: 0, stdout: host.nginxDump, stderr: "" };
      }
      if (command === "nginx" && args[0] === "-t") {
        return host.testFails
          ? { code: 1, stdout: "", stderr: host.testFails }
          : { code: 0, stdout: "", stderr: "" };
      }
      if (command === "systemctl" && args[0] === "reload" && args[1] === "nginx") {
        host.reloads++;
        if (!host.reloadIgnored) host.reload();
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return host;
}
