import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { fakeHost, type FakeHost } from "./fakehost.ts";
import { harness, type Harness, type HarnessOptions } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

/** A Host that `host setup` has just finished with. */
async function setUpHost(host: FakeHost = fakeHost(), opts: HarnessOptions = {}) {
  h = await harness({ setUp: false, runner: (c, a) => host.run(c, a), ...opts });
  expect(await run(["host", "setup", "--yes"], h.ctx)).toBe(0);
  h.out.length = 0;
  h.calls.length = 0;
}
const doctor = (...args: string[]) => run(["host", "doctor", ...args], h.ctx);

describe("host doctor on a Host setup has just finished with", () => {
  it("is read-only, passes every check and exits 0", async () => {
    await setUpHost();
    expect(await doctor()).toBe(0);
    expect(h.out[0]).toBe("Read-only. Takes no lock.");
    expect(h.out).toContain("  ✓ Debian 13 (trixie), amd64");
    expect(h.out.some((l) => l.includes("✗") || l.includes("!"))).toBe(false);
  });
});
