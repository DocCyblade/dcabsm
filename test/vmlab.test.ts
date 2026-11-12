import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  guardedPve,
  loadVms,
  parseRegistry,
  pveAllowed,
  planSteps,
  redact,
  resolveOs,
  rollbackVm,
  secretsOf,
  selectVm,
  snapshotsFor,
  type PveRequest,
  type PveTransport,
} from "./vm/lab.ts";

const example = parseRegistry(
  readFileSync(new URL("./vm/test-vms.env.example", import.meta.url), "utf8"),
);

describe("registry parsing", () => {
  it("reads quoted, exported and commented lines and expands nothing", () => {
    const env = parseRegistry(
      ["# c", 'export A="x y"', "B='z'", "C=plain # trailing", "D=$HOME", "not a line"].join("\n"),
    );
    expect(env).toEqual({ A: "x y", B: "z", C: "plain", D: "$HOME" });
  });

  it("the repo's example parses to four complete VMs on .invalid hosts", () => {
    const vms = loadVms(example);
    expect(vms.map((v) => v.name)).toEqual(["DEB13", "U2404", "U2604", "TK"]);
    for (const vm of vms) {
      expect(vm.sshHost).toMatch(/\.invalid$/);
      expect(vm.url).toMatch(/\.invalid:/);
      expect(vm.token).toContain("fake");
    }
  });
});

describe("OS to VM selection", () => {
  it("picks each OS from the example", () => {
    const pick = (os: Parameters<typeof resolveOs>[1]) => resolveOs(example, os).vm?.name;
    expect(pick("debian-13")).toBe("DEB13");
    expect(pick("ubuntu-24.04")).toBe("U2404");
    expect(pick("ubuntu-26.04")).toBe("U2604");
    expect(pick("turnkey")).toBe("TK");
  });

  it("skips with a clear message when the registry has no VM for the OS", () => {
    const env = { ...example, VMS: "DEB13" };
    expect(resolveOs(env, "ubuntu-26.04")).toMatchObject({
      skipped: "skipped: no VM for ubuntu-26.04",
      snapshots: [],
    });
    expect(resolveOs({}, "turnkey").skipped).toBe("skipped: no VM for turnkey");
  });

  it("does not take a TurnKey VM for plain Debian, even when its notes say Debian 13", () => {
    const env = {
      VMS: "TK",
      TVM_TK_PURPOSE: "TurnKey",
      TVM_TK_NOTES: "based on Debian 13",
    };
    expect(resolveOs(env, "debian-13").skipped).toBe("skipped: no VM for debian-13");
  });

  it("prefers an OS key, then purpose, then notes, and honours a named VM", () => {
    const env = {
      VMS: "A B C",
      TVM_A_NOTES: "ubuntu 24.04 once",
      TVM_B_PURPOSE: "Ubuntu 24.04 lab",
      TVM_C_OS: "ubuntu-24.04",
    };
    const vms = loadVms(env);
    expect(selectVm(vms, "ubuntu-24.04")?.name).toBe("C");
    expect(selectVm(vms, "ubuntu-24.04", "B")?.name).toBe("B");
    expect(vms).toHaveLength(3);
  });

  it("skips a VM that is not fully described and names keys, not values", () => {
    const env = { VMS: "D", TVM_D_PURPOSE: "debian-13", TVM_D_SSH_HOST: "d.lab.invalid" };
    const sel = resolveOs(env, "debian-13");
    expect(sel.skipped).toMatch(/^skipped: the VM for debian-13 is not fully described \(missing /);
    expect(sel.skipped).toContain("NODE");
    expect(sel.skipped).not.toContain("d.lab.invalid");
  });

  it("uses the Proxmox-wide token when the VM has none of its own", () => {
    const vm = loadVms(example)[0]!;
    expect(vm.token).toBe("lab@pve!example=00000000-fake-fake-fake-000000000000");
  });

  it("runs TurnKey from both its snapshots and others from their one", () => {
    const vms = loadVms(example);
    expect(snapshotsFor(vms[3]!, "turnkey")).toEqual(["clean-core", "clean-nodejs"]);
    expect(snapshotsFor({ ...vms[3]!, snapshots: [] }, "turnkey")).toEqual([
      "clean-core",
      "clean-nodejs",
    ]);
    expect(snapshotsFor(vms[0]!, "debian-13")).toEqual(["clean"]);
  });
});

describe("step planning", () => {
  it("runs the spec 13.4 journey in order on a plain OS", () => {
    expect(planSteps({ os: "debian-13" })).toEqual([
      "install",
      "setup",
      "create-alpha",
      "create-beta",
      "upgrade",
      "rollback",
      "backup",
      "restore",
      "clone",
      "reboot",
      "doctor",
    ]);
  });

  it("adds the TurnKey extras on TurnKey only", () => {
    const steps = planSteps({ os: "turnkey" });
    expect(steps).toContain("tk-setup-prompt");
    expect(steps.indexOf("tk-setup-prompt")).toBeLessThan(steps.indexOf("setup"));
    expect(steps).toContain("tk-pieces");
    expect(steps).toContain("tk-vhost");
    expect(steps.at(-1)).toBe("tk-doctor");
    expect(planSteps({ os: "ubuntu-24.04" }).some((s) => s.startsWith("tk-"))).toBe(false);
  });

  it("plans a self update journey that ends in a reboot and doctor", () => {
    const steps = planSteps({ os: "ubuntu-24.04", selfUpdate: true });
    expect(steps[0]).toBe("install-prev");
    expect(steps).toContain("self-update");
    expect(steps.slice(-2)).toEqual(["reboot", "doctor"]);
    expect(steps).not.toContain("upgrade");
  });
});

describe("Proxmox calls", () => {
  const ok = (data: unknown) => ({ status: 200, data });
  const req = (method: "GET" | "POST", path: string): PveRequest => ({ method, path });

  it("allows only state reads, snapshot rollback and power on", () => {
    const base = "nodes/pve1/qemu/9001";
    expect(pveAllowed(req("POST", `${base}/snapshot/clean-core/rollback`))).toBe(true);
    expect(pveAllowed(req("POST", `${base}/status/start`))).toBe(true);
    expect(pveAllowed(req("GET", `${base}/status/current`))).toBe(true);
    for (const bad of [
      req("POST", "nodes/pve1/qemu"),
      req("POST", `${base}/snapshot`),
      req("POST", `${base}/clone`),
      req("POST", `${base}/status/stop`),
      req("POST", `${base}/config`),
      req("POST", `${base}/snapshot/x/../../config`),
      req("GET", `${base}/config`),
    ])
      expect(pveAllowed(bad), `${bad.method} ${bad.path}`).toBe(false);
  });

  it("refuses any other call, before it reaches the transport", async () => {
    const seen: PveRequest[] = [];
    const pve = guardedPve(async (r) => (seen.push(r), ok(null)));
    await expect(pve(req("POST", "nodes/pve1/qemu/1/clone"))).rejects.toThrow(
      /not a call the lab makes/,
    );
    expect(seen).toEqual([]);
  });

  async function roll(power: string) {
    const vm = loadVms(example)[0]!;
    const calls: string[] = [];
    const pve: PveTransport = async (r) => {
      calls.push(`${r.method} ${r.path}`);
      if (r.path.endsWith("/status/current")) return ok({ status: power });
      if (r.path.includes("/tasks/")) return ok({ status: "stopped", exitstatus: "OK" });
      return ok("UPID:task");
    };
    let sshWaited = 0;
    await rollbackVm(vm, "clean", {
      pve: guardedPve(pve),
      sleep: async () => {},
      waitForSsh: async () => void sshWaited++,
    });
    return { calls, sshWaited };
  }

  it("rolls back, leaves a running VM alone and waits for SSH", async () => {
    const { calls, sshWaited } = await roll("running");
    expect(calls[0]).toBe("POST nodes/pve1/qemu/9001/snapshot/clean/rollback");
    expect(calls.some((c) => c.endsWith("/status/start"))).toBe(false);
    expect(sshWaited).toBe(1);
  });

  it("powers on a VM the rollback left stopped", async () => {
    const { calls } = await roll("stopped");
    expect(calls.filter((c) => c.endsWith("/status/start"))).toHaveLength(1);
  });

  it("fails when a Proxmox task fails", async () => {
    const vm = loadVms(example)[0]!;
    const pve: PveTransport = async (r) =>
      r.path.includes("/tasks/")
        ? ok({ status: "stopped", exitstatus: "snapshot does not exist" })
        : ok("UPID:task");
    await expect(
      rollbackVm(vm, "clean", { pve, sleep: async () => {}, waitForSsh: async () => {} }),
    ).rejects.toThrow(/task failed/);
  });
});

describe("output redaction", () => {
  it("hides IPv4 and IPv6 addresses", () => {
    const text = "inet 192.0.2.17/24 and 10.1.2.3, fe80::1ff:fe23:4567:890a, 2001:db8::1";
    const out = redact(text, []);
    expect(out).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(out).not.toContain("2001:db8");
    expect(out).not.toContain("fe80");
    expect(out).toContain("<ip>/24");
  });

  it("hides every lab detail of the VM, longest first, and keeps ordinary text", () => {
    const vm = loadVms(example)[0]!;
    const secrets = secretsOf(vm);
    const text = `ssh ${vm.sshHost} via ${vm.url} token ${vm.token} node ${vm.node} vm ${vm.vmid} ok 26.11.0`;
    const out = redact(text, secrets);
    for (const s of secrets) expect(out).not.toContain(s);
    expect(out).toContain("ok 26.11.0");
    expect(out).not.toContain("00000000-fake");
  });
});
