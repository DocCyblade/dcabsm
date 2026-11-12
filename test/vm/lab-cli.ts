/**
 * The thin command line over lab.ts that run-journey.sh calls. Run by hand from the author's
 * machine only; it refuses to run in CI.
 *
 *   node test/vm/lab-cli.ts resolve <os> [--vm <NAME>]   shell assignments for run-journey.sh
 *   node test/vm/lab-cli.ts plan <os> [--self-update]    the step ids, one line
 *   node test/vm/lab-cli.ts rollback <os> <snapshot> [--vm <NAME>]
 *   node test/vm/lab-cli.ts redact <os> [--vm <NAME>]    stdin to stdout, lab details hidden
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  guardedPve,
  isJourneyOs,
  JOURNEY_OSES,
  loadVms,
  parseRegistry,
  planSteps,
  redact,
  resolveOs,
  rollbackVm,
  secretsOf,
  type PveTransport,
} from "./lab.ts";

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const sshTarget = (vm: { sshUser?: string; sshHost: string }): string =>
  vm.sshUser ? `${vm.sshUser}@${vm.sshHost}` : vm.sshHost;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function loadRegistry(): Record<string, string> {
  if (process.env.CI) fail("the lab journey never runs in CI");
  const path = process.env.TVM_REGISTRY ?? join(homedir(), ".config", "test-vms.env");
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    fail("no test VM registry (~/.config/test-vms.env)");
  }
  if (mode & 0o077) fail("the test VM registry must be mode 600");
  return parseRegistry(readFileSync(path, "utf8"));
}

function realTransport(url: string, token: string): PveTransport {
  return (req) =>
    new Promise((resolve, reject) => {
      const r = request(
        `${url}/api2/json/${req.path}`,
        {
          method: req.method,
          headers: { Authorization: `PVEAPIToken=${token}`, "Content-Length": 0 },
          // Lab only: the lab's Proxmox uses its own certificate, as curl -k does in scripts/remote-test.sh.
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            let data: unknown = null;
            try {
              data = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown })
                .data;
            } catch {
              // an answer that is not JSON has no data
            }
            resolve({ status: res.statusCode ?? 0, data });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
}

async function main(): Promise<void> {
  const [cmd, osArg, ...rest] = process.argv.slice(2);
  if (!cmd || !osArg || !isJourneyOs(osArg))
    fail(`Usage: lab-cli.ts <resolve|plan|rollback|redact> <${JOURNEY_OSES.join("|")}> ...`);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "plan") {
    process.stdout.write(
      `${planSteps({ os: osArg, selfUpdate: rest.includes("--self-update") }).join(" ")}\n`,
    );
    return;
  }
  const env = loadRegistry();
  const selection = resolveOs(env, osArg, flag("--vm"));
  if (cmd === "resolve") {
    if (selection.skipped || !selection.vm) {
      process.stdout.write(`SKIPPED=${shq(selection.skipped ?? "skipped")}\n`);
      return;
    }
    const { vm } = selection;
    const target = sshTarget(vm);
    process.stdout.write(
      `SSH_TARGET=${shq(target)}\nSNAPSHOTS=${shq(selection.snapshots.join(" "))}\n`,
    );
    return;
  }
  if (cmd === "redact") {
    const secrets = selection.vm ? secretsOf(selection.vm) : loadVms(env).flatMap(secretsOf);
    process.stdout.write(redact(readFileSync(0, "utf8"), secrets));
    return;
  }
  if (cmd === "rollback") {
    const snapshot = rest[0];
    if (!selection.vm || !snapshot) fail(selection.skipped ?? "rollback needs a snapshot");
    const { vm } = selection;
    if (!selection.snapshots.includes(snapshot)) fail("that snapshot is not one of this VM's");
    const target = sshTarget(vm);
    await rollbackVm(vm, snapshot, {
      pve: guardedPve(realTransport(vm.url, vm.token)),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      waitForSsh: async () => {
        for (let i = 0; i < 90; i++) {
          const res = spawnSync(
            "ssh",
            ["-o", "ConnectTimeout=3", "-o", "BatchMode=yes", target, "true"],
            {
              stdio: "ignore",
            },
          );
          if (res.status === 0) return;
          await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error("the VM did not answer over SSH");
      },
    });
    return;
  }
  fail(`unknown command ${cmd}`);
}

main().catch((err: unknown) => {
  // Node's network errors name the host and address, so only their code is shown.
  const code = (err as { code?: unknown } | null)?.code;
  const msg = typeof code === "string" ? `network error ${code}` : (err as Error).message;
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
