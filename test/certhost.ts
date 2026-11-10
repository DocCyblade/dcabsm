import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeNet, type FakeNet } from "./fakenet.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";
import type { TestCert } from "./certs.ts";

/** A Host whose Nginx serves, after each reload, whatever certificate files are on disk. */
export interface CertHost {
  h: Harness;
  net: FakeNet;
  /** `nginx -t` fails with this message while set. */
  testFails?: string;
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
    startAt: new Date(),
    ...opts,
    net,
    runner(command, args) {
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
