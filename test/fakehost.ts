import type { RunResult } from "../src/context.ts";

const ok = (stdout = "", stderr = ""): RunResult => ({ code: 0, stdout, stderr });
const fail = (stderr = "", code = 1, stdout = ""): RunResult => ({ code, stdout, stderr });

export const DEBIAN_POLICY = `nginx:
  Installed: (none)
  Candidate: 1.26.3-3
  Version table:
     1.26.3-3 500
        500 http://deb.debian.org/debian trixie/main amd64 Packages
`;

export const NGINX_ORG_POLICY = `nginx:
  Installed: (none)
  Candidate: 1.28.0-1~trixie
  Version table:
     1.28.0-1~trixie 500
        500 http://nginx.org/packages/debian trixie/nginx amd64 Packages
     1.26.3-3 500
        500 http://deb.debian.org/debian trixie/main amd64 Packages
`;

export interface FakeHost {
  installed: Set<string>;
  /** `ss -H -ltnp` output. */
  listeners: string;
  container: string;
  policy: string;
  nginxTest: RunResult;
  aptResult: RunResult;
  /** pid → `readlink -f /proc/<pid>/exe`. */
  exe: Record<number, string>;
  /** Units systemd says are active (`nginx`) or enabled (`nginx`, `dcabsm-nightly.timer`). */
  active: Set<string>;
  enabled: Set<string>;
  /** `ufw status` output; empty when ufw is not installed. */
  ufw: string;
  /** The device `df` reports for the backup directory and for the Instance data. */
  backupDevice: string;
  dataDevice: string;
  systemctl(args: string[]): RunResult;
  run(command: string, args: string[]): RunResult;
}

/** A clean Debian 13 VM, as the faked command runner sees it. */
export function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost {
  const host: FakeHost = {
    installed: new Set(),
    listeners: "",
    container: "none",
    policy: DEBIAN_POLICY,
    nginxTest: ok("", "nginx: configuration file /etc/nginx/nginx.conf test is successful"),
    aptResult: ok(),
    exe: {},
    active: new Set(["nginx"]),
    enabled: new Set(["nginx", "dcabsm-nightly.timer"]),
    ufw: "",
    backupDevice: "/dev/vdb1",
    dataDevice: "/dev/vda1",
    ...overrides,
    systemctl(args) {
      const unit = (args[args.length - 1] ?? "").replace(/\.service$/, "");
      const yes = (set: Set<string>) => (set.has(unit) ? ok() : fail("", 3));
      if (args[0] === "is-active") return yes(host.active);
      if (args[0] === "is-enabled") return yes(host.enabled);
      if (args[0] === "enable") host.enabled.add(unit);
      if (args[0] === "enable" && args.includes("--now")) host.active.add(unit);
      if (args[0] === "start") host.active.add(unit);
      return ok();
    },
    run(command, args) {
      if (command === "env" && args[0] === "LC_ALL=C") return host.run(args[1]!, args.slice(2));
      const line = [command, ...args].join(" ");
      if (command === "systemd-detect-virt") {
        return host.container === "none" ? fail("", 1, "none") : ok(host.container);
      }
      if (command === "apt-cache") return ok(host.policy);
      if (command === "ss") return ok(host.listeners);
      if (command === "readlink") return ok(host.exe[Number(/proc\/(\d+)/.exec(line)?.[1])] ?? "");
      if (command === "dpkg") return ok("nginx: /usr/sbin/nginx");
      if (command === "dpkg-query") {
        const pkg = args[args.length - 1]!;
        return host.installed.has(pkg) ? ok("install ok installed") : fail("no packages found");
      }
      if (command === "nginx") return host.nginxTest;
      if (command === "systemctl") return host.systemctl(args);
      if (command === "ufw") return host.ufw === "" ? fail("not found", 127) : ok(host.ufw);
      if (command === "df") {
        const dev = args[args.length - 1]!.includes("/instances")
          ? host.dataDevice
          : host.backupDevice;
        return ok(
          `Filesystem 1024-blocks Used Available Capacity Mounted on\n${dev} 100 1 99 1% /\n`,
        );
      }
      if (command === "env" && args.includes("apt-get")) {
        if (host.aptResult.code === 0) {
          for (const pkg of args.slice(args.indexOf("-y") + 1)) host.installed.add(pkg);
        }
        return host.aptResult;
      }
      return ok();
    },
  };
  return host;
}
