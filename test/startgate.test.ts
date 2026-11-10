import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { gateDir, gateText, withStartGate } from "../src/instance/start-gate.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

describe("the start gate (spec 6.1 step 7)", () => {
  it("is in place, and reloaded, while the start runs, and gone and reloaded after", async () => {
    h = await harness();
    const file = `${gateDir(h.ctx, "shop")}/10-start-gate.conf`;
    let seen = "";
    const result = await withStartGate(h.ctx, "shop", async () => {
      seen = readFileSync(file, "utf8");
      expect(h.calls.map((c) => c.args.join(" "))).toEqual(["daemon-reload"]);
      return 7;
    });
    expect(result).toBe(7);
    expect(seen).toBe(gateText("shop"));
    expect(existsSync(gateDir(h.ctx, "shop"))).toBe(false);
    expect(h.calls.map((c) => c.args.join(" "))).toEqual(["daemon-reload", "daemon-reload"]);
  });

  it("lifts the marker rule only, and keeps the Node runtime rule", () => {
    expect(gateText("shop")).toBe(
      "[Unit]\nConditionPathExists=\nConditionPathExists=/srv/dcabsm/instances/shop/release/node/bin/node\n",
    );
  });

  it("is closed again when the start fails", async () => {
    h = await harness();
    await expect(
      withStartGate(h.ctx, "shop", async () => {
        throw new Error("did not come up");
      }),
    ).rejects.toThrow("did not come up");
    expect(existsSync(gateDir(h.ctx, "shop"))).toBe(false);
    expect(h.calls.map((c) => c.args.join(" "))).toEqual(["daemon-reload", "daemon-reload"]);
  });

  it("lives under /run, which a boot wipes", async () => {
    h = await harness();
    expect(gateDir(h.ctx, "shop")).toBe(`${h.root}/run/systemd/system/dcabsm@shop.service.d`);
  });
});
