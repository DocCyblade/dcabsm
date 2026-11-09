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
    ...overrides,
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
