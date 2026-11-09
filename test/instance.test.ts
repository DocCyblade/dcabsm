import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import type { RunResult } from "../src/context.ts";
import { harness, type Harness } from "./helpers.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { fakeNet, type FakeNet } from "./fakenet.ts";

let h: Harness;
let host: FakeHost;
/** What `nginx -T` prints. */
let nginxDump = "";
afterEach(() => h.cleanup());

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

interface Start {
  net?: FakeNet;
  interactive?: boolean;
  answers?: string[];
  /** Releases to install first. */
  releases?: string[];
  ipv6?: boolean;
  hostOverrides?: Partial<FakeHost>;
  /** Runs before the fake host's own answer; return a result to override it. */
  runner?: (command: string, args: string[]) => RunResult | undefined;
}

async function start(o: Start = {}): Promise<void> {
  host = fakeHost(o.hostOverrides);
  nginxDump = "";
  h = await harness({
    net: o.net ?? fakeNet({ serverVersion: "26.11.1" }),
    interactive: o.interactive,
    answers: o.answers,
    runner: (command, args) => {
      const own = o.runner?.(command, args);
      if (own) return own;
      if (command === "openssl") {
        writeFileSync(args[args.indexOf("-keyout") + 1]!, "KEY");
        writeFileSync(args[args.indexOf("-out") + 1]!, "CERT");
        return ok();
      }
      if (command === "nginx" && args[0] === "-T") return ok(nginxDump);
      if (command === "systemctl" && args[0] === "is-active") return ok("active\n");
      return host.run(command, args);
    },
  });
  const p = h.ctx.paths;
  for (const d of [p.releases, p.node, p.instances, p.acme]) await mkdir(d, { recursive: true });
  if (o.ipv6) {
    mkdirSync(p.under("/proc/net"), { recursive: true });
    writeFileSync(
      p.under("/proc/net/if_inet6"),
      "00000000000000000000000000000001 01 80 10 80 lo\n",
    );
  }
  for (const v of o.releases ?? ["26.11.1"]) {
    expect(await run(["release", "install", v], h.ctx)).toBe(0);
  }
  h.out.length = 0;
  h.calls.length = 0;
}

const create = (...args: string[]) => run(["instance", "create", ...args], h.ctx);
const shop = (...extra: string[]) =>
  create("shop", "--hostname", "shop.example.org", "--self-signed", ...extra);
const dir = (name: string) => join(h.ctx.paths.instances, name);
const modeOf = async (p: string) => (await stat(p)).mode & 0o777;
const read = (p: string) => readFile(p, "utf8");
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const calls = (command: string) => h.calls.filter((c) => c.command === command).map((c) => c.args);

describe("instance create --self-signed", () => {
  it("leaves the record, config, vhost, certificate and directories with spec 2.2 modes", async () => {
    await start();
    expect(await shop()).toBe(0);

    const d = dir("shop");
    expect(await readlink(join(d, "release"))).toBe(join(h.ctx.paths.releases, "26.11.1"));
    expect(JSON.parse(await read(join(d, "config/instance.json")))).toEqual({
      port: 15127,
      hostname: "shop.example.org",
      scheduledBackups: true,
    });
    expect(JSON.parse(await read(join(d, "config/config.json")))).toEqual({
      dataDir: "/srv/dcabsm/instances/shop/data",
      serverFiles: "/srv/dcabsm/instances/shop/server-files",
      userFiles: "/srv/dcabsm/instances/shop/user-files",
      hostname: "127.0.0.1",
      port: 15127,
      trustedProxies: ["127.0.0.1/32"],
      allowedLoginMethods: ["password", "openid"],
      trustedAuthProxies: [],
    });
    expect(await read(join(d, "nginx/cert.pem"))).toBe("CERT");

    const modes: Array<[string, number]> = [
      [d, 0o750],
      [join(d, "config"), 0o750],
      [join(d, "config/config.json"), 0o640],
      [join(d, "config/instance.json"), 0o600],
      [join(d, "data"), 0o700],
      [join(d, "server-files"), 0o700],
      [join(d, "user-files"), 0o700],
      [join(d, "nginx"), 0o700],
      [join(d, "nginx/vhost.conf"), 0o600],
      [join(d, "nginx/cert.pem"), 0o600],
      [join(d, "nginx/key.pem"), 0o600],
    ];
    for (const [path, mode] of modes) expect([path, await modeOf(path)]).toEqual([path, mode]);
  });

  it("makes the static account and hands each path to the right owner", async () => {
    await start();
    await shop();
    expect(calls("useradd")).toEqual([
      [
        "--system",
        "--user-group",
        "--no-create-home",
        "--home-dir",
        "/nonexistent",
        "--shell",
        "/usr/sbin/nologin",
        "dcabsm-shop",
      ],
    ]);
    const d = dir("shop");
    const owners = new Map(calls("chown").map((a) => [a[1], a[0]]));
    expect(owners.get(d)).toBe("root:dcabsm-shop");
    expect(owners.get(join(d, "config"))).toBe("root:dcabsm-shop");
    expect(owners.get(join(d, "config/config.json"))).toBe("root:dcabsm-shop");
    expect(owners.get(join(d, "data"))).toBe("dcabsm-shop:dcabsm-shop");
    expect(owners.get(join(d, "server-files"))).toBe("dcabsm-shop:dcabsm-shop");
    expect(owners.get(join(d, "user-files"))).toBe("dcabsm-shop:dcabsm-shop");
  });

  it("writes the vhost of spec 5.2", async () => {
    await start();
    await shop();
    const vhost = await read(join(dir("shop"), "nginx/vhost.conf"));
    expect(vhost).toContain("listen 443 ssl;");
    expect(vhost).not.toContain("[::]");
    expect(vhost).toContain("server_name shop.example.org;");
    expect(vhost).toContain("ssl_certificate /srv/dcabsm/instances/shop/nginx/cert.pem;");
    expect(vhost).toContain("ssl_certificate_key /srv/dcabsm/instances/shop/nginx/key.pem;");
    expect(vhost).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
    expect(vhost).toContain("client_max_body_size 51m;");
    expect(vhost).toContain("proxy_pass http://127.0.0.1:15127;");
    expect(vhost).toContain("proxy_http_version 1.1;");
    expect(vhost).toContain('proxy_set_header Connection "";');
    expect(vhost).toContain("proxy_set_header Host $host;");
    expect(vhost).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(vhost).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(vhost).toContain('proxy_set_header X-Actual-Password "";');
    expect(vhost).toContain("location /.well-known/acme-challenge/ {");
    expect(vhost).toContain("root /srv/dcabsm/acme;");
    expect(vhost).toContain("return 301 https://$host$request_uri;");
    for (const banned of ["http2", "Cross-Origin", "Strict-Transport", "Upgrade"])
      expect(vhost).not.toContain(banned);
  });

  it("listens on IPv6 only when the Host has it", async () => {
    await start({ ipv6: true });
    await shop();
    const vhost = await read(join(dir("shop"), "nginx/vhost.conf"));
    expect(vhost).toContain("listen [::]:443 ssl;");
    expect(vhost).toContain("listen [::]:80;");
  });

  it("makes an ECDSA P-256 certificate valid for 397 days and gives the browser advice", async () => {
    await start();
    await shop();
    expect(calls("openssl")[0]).toEqual(
      expect.arrayContaining([
        "req",
        "-x509",
        "ec",
        "ec_paramgen_curve:P-256",
        "-nodes",
        "397",
        "subjectAltName=DNS:shop.example.org",
      ]),
    );
    expect(h.out).toContain("  ✓ Certificate for shop.example.org, 397 days left (self-signed)");
    expect(h.out.join("\n")).toContain("Self-signed: browsers warn on each device");
    expect(h.out.join("\n")).toContain("sudo dcabsm cert update <name> --cert <file> --key <file>");
  });

  it("runs nginx -t, reloads, starts, verifies, then enables", async () => {
    await start();
    await shop();
    const order = h.calls
      .map((c) => [c.command, ...c.args].join(" "))
      .filter((l) => /^(nginx -t|systemctl (reload|start|enable))/.test(l));
    expect(order).toEqual([
      "nginx -t",
      "systemctl reload nginx",
      "systemctl start dcabsm@shop",
      "systemctl enable dcabsm@shop",
    ]);
    expect(h.out.at(-2)).toContain("Open https://shop.example.org now to set the server password");
    expect(h.out.join("\n")).toContain("whoever opens it first sets it");
    expect(h.out.at(-1)).toBe("Scheduled backups are on.");
  });

  it("is verified by /health and /info against the Release", async () => {
    await start();
    await shop();
    expect(h.net.fetched.filter((u) => u.startsWith("http://127.0.0.1"))).toEqual([
      "http://127.0.0.1:15127/health",
      "http://127.0.0.1:15127/info",
    ]);
    expect(
      h.out.some((l) => /Started and verified: \/health UP, \/info 26\.11\.1 \(\d+s\)/.test(l)),
    ).toBe(true);
  });
});

describe("what is checked first", () => {
  it.each(["Shop", "1shop", "-shop", "a".repeat(25), "my.shop", "sh_op"])(
    "refuses the name %j",
    async (name) => {
      await start();
      expect(await create(name, "--hostname", "a.example.org", "--self-signed")).toBe(2);
      expect(await readdir(h.ctx.paths.instances)).toEqual([]);
    },
  );

  it("accepts a name of 24 characters", async () => {
    await start();
    expect(await create("a".repeat(24), "--hostname", "a.example.org", "--self-signed")).toBe(0);
  });

  it.each([
    "Shop.example.org",
    "*.example.org",
    "shop.example.org.",
    "shop..example.org",
    "-shop.example.org",
    "shop_x.example.org",
    "10.0.0.1",
  ])("refuses the hostname %j", async (hostname) => {
    await start();
    expect(await create("shop", "--hostname", hostname, "--self-signed")).toBe(2);
    expect(await readdir(h.ctx.paths.instances)).toEqual([]);
  });

  it("refuses a missing name or hostname, and a name that is already an Instance", async () => {
    await start();
    expect(await create("--hostname", "a.example.org", "--self-signed")).toBe(2);
    expect(await create("shop", "--self-signed")).toBe(2);
    expect(await shop()).toBe(0);
    expect(await create("shop", "--hostname", "other.example.org", "--self-signed")).toBe(2);
    expect(h.err.join("\n")).toContain("shop already exists");
  });

  it("refuses a hostname another Instance uses", async () => {
    await start();
    expect(await shop()).toBe(0);
    expect(await create("two", "--hostname", "shop.example.org", "--self-signed")).toBe(2);
    expect(await readdir(h.ctx.paths.instances)).toEqual(["shop"]);
  });

  it("refuses a hostname that nginx -T already serves", async () => {
    await start();
    nginxDump =
      "server {\n    listen 443 ssl;\n    server_name www.example.org Shop.Example.org;\n}\n";
    expect(await shop()).toBe(2);
    expect(h.err[0]).toContain("shop.example.org");
    expect(h.err[0]).toContain("Nginx");
    expect(await readdir(h.ctx.paths.instances)).toEqual([]);
    expect(calls("useradd")).toEqual([]);
  });

  it("refuses without a certificate choice on a script, and --cert, which is not built yet", async () => {
    await start();
    expect(await create("shop", "--hostname", "shop.example.org")).toBe(2);
    expect(h.err[0]).toContain("No terminal");
    expect(
      await create("shop", "--hostname", "shop.example.org", "--cert", "a", "--key", "b"),
    ).toBe(2);
    expect(await readdir(h.ctx.paths.instances)).toEqual([]);
  });

  it("asks on a terminal, and answer 1 makes a self-signed certificate", async () => {
    await start({ interactive: true, answers: ["1"] });
    expect(await create("shop", "--hostname", "shop.example.org")).toBe(0);
    expect(h.out).toContain(
      "No certificate given for shop.example.org. Every Instance must have one.",
    );
    expect(h.asked).toEqual(["  [1] self-signed now  [2] cancel (re-run with --cert/--key): "]);
    expect(await exists(join(dir("shop"), "nginx/cert.pem"))).toBe(true);
  });

  it("changes nothing when the terminal answer is cancel", async () => {
    await start({ interactive: true, answers: ["2"] });
    expect(await create("shop", "--hostname", "shop.example.org")).toBe(1);
    expect(await readdir(h.ctx.paths.instances)).toEqual([]);
  });
});

describe("which Release", () => {
  it("uses the newest installed Release by default", async () => {
    await start({ releases: ["26.10.0", "26.11.0"], net: fakeNet({ serverVersion: "26.11.0" }) });
    expect(await shop()).toBe(0);
    expect(await readlink(join(dir("shop"), "release"))).toContain("26.11.0");
    expect(h.out).toContain("  ✓ Instance on Release 26.11.0, port 15127");
  });

  it("installs the requested Release first when it is missing", async () => {
    await start({ releases: ["26.11.1"], net: fakeNet({ serverVersion: "26.10.0" }) });
    expect(await shop("--release", "26.10.0")).toBe(0);
    expect(await readdir(h.ctx.paths.releases)).toEqual(["26.10.0", "26.11.1"]);
    expect(await readlink(join(dir("shop"), "release"))).toContain("26.10.0");
  });

  it("installs the latest when no Release is installed", async () => {
    await start({ releases: [] });
    expect(await shop()).toBe(0);
    expect(await readdir(h.ctx.paths.releases)).toEqual(["26.11.1"]);
  });

  it("refuses an unusable --release before changing anything", async () => {
    await start();
    expect(await shop("--release", "26.9.0")).toBe(2);
    expect(await readdir(h.ctx.paths.instances)).toEqual([]);
  });
});

describe("ports", () => {
  it("takes the first port not in any record and not listening", async () => {
    await start({
      hostOverrides: {
        listeners: 'LISTEN 0 511 127.0.0.1:15128 0.0.0.0:* users:(("node",pid=9,fd=1))\n',
      },
    });
    expect(await shop()).toBe(0);
    expect(JSON.parse(await read(join(dir("shop"), "config/instance.json"))).port).toBe(15127);
    expect(await create("two", "--hostname", "two.example.org", "--self-signed")).toBe(0);
    // 15128 is listening and 15127 is in shop's record.
    expect(JSON.parse(await read(join(dir("two"), "config/instance.json"))).port).toBe(15129);
  });

  it("reuses the port of a removed Instance", async () => {
    await start();
    await shop();
    await rm(dir("shop"), { recursive: true });
    await shop();
    expect(JSON.parse(await read(join(dir("shop"), "config/instance.json"))).port).toBe(15127);
  });
});

describe("failures", () => {
  it("removes everything it made when nginx -t fails, so a bad vhost never stays", async () => {
    await start({
      runner: (c, a) =>
        c === "nginx" && a[0] === "-t"
          ? { code: 1, stdout: "", stderr: "nginx: [emerg] bad directive" }
          : undefined,
    });
    expect(await shop()).toBe(1);
    expect(h.err[0]).toContain("nginx -t failed");
    expect(await readdir(h.ctx.paths.instances)).toEqual([]);
    expect(calls("userdel")).toEqual([["dcabsm-shop"]]);
    expect(calls("systemctl").some((a) => a[0] === "reload")).toBe(false);
  });

  it("fails and does not enable when /health never comes up within 120 s", async () => {
    await start({ net: fakeNet({ serverUp: false }), clockStepMs: 30_000 });
    expect(await shop()).toBe(1);
    expect(h.err[0]).toContain("did not pass verification within 120 s");
    expect(calls("systemctl").some((a) => a[0] === "enable" && a[1] === "dcabsm@shop")).toBe(false);
    // The Instance stays, for `instance logs` and `instance remove`.
    expect(await exists(dir("shop"))).toBe(true);
  });

  it("fails when /info reports another version", async () => {
    await start({ net: fakeNet({ serverVersion: "26.10.0" }) });
    expect(await shop()).toBe(1);
    expect(h.err[0]).toContain("26.10.0");
  });

  it("fails when the unit restarted during the window", async () => {
    await start({
      runner: (c, a) => (c === "systemctl" && a[0] === "show" ? ok("1\n") : undefined),
    });
    expect(await shop()).toBe(1);
    expect(h.err[0]).toContain("restarted");
  });

  it("fails when the unit is not active", async () => {
    await start({
      runner: (c, a) =>
        c === "systemctl" && a[0] === "is-active"
          ? { code: 3, stdout: "failed\n", stderr: "" }
          : undefined,
    });
    expect(await shop()).toBe(1);
    expect(h.err[0]).toContain("failed");
  });
});

describe("instance list and show", () => {
  it("points to create when there are no Instances", async () => {
    await start();
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
    expect(h.out.join("\n")).toContain("instance create");
  });

  it("lists one row per Instance with state, Release, hostname and port", async () => {
    await start();
    await shop();
    await create("two", "--hostname", "two.example.org", "--self-signed");
    // Stop `two` from now on.
    const inner = h.ctx.runner;
    h.ctx.runner = {
      run: (c, a) =>
        c === "systemctl" && a[0] === "is-active" && a.at(-1) === "dcabsm@two"
          ? Promise.resolve({ code: 3, stdout: "inactive\n", stderr: "" })
          : inner.run(c, a),
    };
    h.out.length = 0;
    expect(await run(["instance", "list"], h.ctx)).toBe(0);
    expect(h.out).toEqual([
      "INSTANCE  STATE    RELEASE  HOSTNAME          PORT",
      "shop      active   26.11.1  shop.example.org  15127",
      "two       stopped  26.11.1  two.example.org   15128",
      "",
      expect.stringMatching(/^DCABSM \S+$/),
      "→ No update check yet: sudo dcabsm host check-updates",
    ]);
  });

  it("shows CHANGING for an unfinished Release change", async () => {
    await start();
    await shop();
    await writeFile(join(dir("shop"), ".changing-release"), "");
    h.out.length = 0;
    await run(["instance", "list"], h.ctx);
    expect(h.out[1]).toMatch(/^shop {6}CHANGING/);
  });

  it("shows one Instance in detail", async () => {
    await start();
    await shop();
    h.out.length = 0;
    expect(await run(["instance", "show", "shop"], h.ctx)).toBe(0);
    expect(h.out).toEqual([
      "shop  active",
      "  Hostname           https://shop.example.org",
      "  Release            26.11.1 (Node 24.11.1)",
      "  Port               127.0.0.1:15127",
      "  Account            dcabsm-shop",
      "  Scheduled backups  on",
    ]);
  });

  it("refuses an unknown name with a pointer to instance list", async () => {
    await start();
    expect(await run(["instance", "show", "nope"], h.ctx)).toBe(2);
    expect(h.err.join("\n")).toContain("instance list");
  });
});
