import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { findNoun, findVerb, table } from "../src/table.ts";
import { versionLine } from "../src/version.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

describe("help and version", () => {
  it("lists every visible command and hides host nightly", async () => {
    h = await harness({ uid: 1000, setUp: false });
    expect(await run(["help"], h.ctx)).toBe(0);
    const text = h.out.join("\n");
    for (const noun of table) {
      for (const verb of noun.verbs.filter((v) => !v.hidden)) {
        expect(text).toContain(`${noun.name} ${verb.usage}`);
      }
    }
    expect(text).not.toContain("nightly");
  });

  it("runs help without root and before setup", async () => {
    h = await harness({ uid: 1000, setUp: false });
    expect(await run(["help"], h.ctx)).toBe(0);
  });

  it("routes host nightly even though help hides it", () => {
    const verb = findVerb(findNoun("host")!, "nightly");
    expect(verb?.hidden).toBe(true);
  });

  it.each([[["--version"]], [["self", "version"]]])(
    "%j prints the version without root and before setup",
    async (argv) => {
      h = await harness({ uid: 1000, setUp: false });
      expect(await run(argv, h.ctx)).toBe(0);
      expect(h.out).toEqual([versionLine()]);
    },
  );
});

describe("guards", () => {
  it("refuses a command when not root, with the full next command", async () => {
    h = await harness({ uid: 1000 });
    expect(await run(["instance", "list"], h.ctx)).toBe(2);
    expect(h.err).toEqual(["error: dcabsm must run as root.", "  Try: sudo dcabsm instance list"]);
  });

  it("refuses before setup, pointing at host setup", async () => {
    h = await harness({ setUp: false });
    expect(await run(["instance", "list"], h.ctx)).toBe(2);
    expect(h.err).toEqual(["error: This Host is not set up yet.", "  Run: sudo dcabsm host setup"]);
  });

  it.each([[["host", "setup"]], [["self", "update"]]])(
    "lets %j past the setup check",
    async (argv) => {
      h = await harness({ setUp: false });
      await run(argv, h.ctx);
      expect(h.err.join("\n")).not.toContain("not set up");
    },
  );

  it("checks root before setup", async () => {
    h = await harness({ uid: 1000, setUp: false });
    await run(["instance", "list"], h.ctx);
    expect(h.err[0]).toBe("error: dcabsm must run as root.");
  });
});

describe("usage errors", () => {
  it("rejects an unknown noun with exit 2 and a hint", async () => {
    h = await harness();
    expect(await run(["frobnicate"], h.ctx)).toBe(2);
    expect(h.err).toEqual(["error: Unknown command: frobnicate.", "  See the list: dcabsm help"]);
  });

  it("rejects an unknown or missing verb with exit 2", async () => {
    h = await harness();
    expect(await run(["instance", "frob"], h.ctx)).toBe(2);
    expect(await run(["instance"], h.ctx)).toBe(2);
    expect(h.err[0]).toBe("error: Unknown command: instance frob.");
  });

  it("exits 1 for a command whose ticket hasn't built it yet", async () => {
    h = await harness();
    expect(await run(["instance", "list"], h.ctx)).toBe(1);
    expect(h.err[0]).toBe("error: instance list is not built yet.");
  });
});
