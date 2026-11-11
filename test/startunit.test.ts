import { afterEach, describe, expect, it } from "vitest";
import { startUnit } from "../src/host/system.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

describe("a deliberate start", () => {
  it("clears the start-limit count first, so back-to-back operations cannot trip it", async () => {
    h = await harness();
    await startUnit(h.ctx, "start", "dcabsm@shop");
    await startUnit(h.ctx, "restart", "dcabsm@shop");
    expect(h.calls.map((c) => c.args.join(" "))).toEqual([
      "reset-failed dcabsm@shop",
      "start dcabsm@shop",
      "reset-failed dcabsm@shop",
      "restart dcabsm@shop",
    ]);
  });
});
