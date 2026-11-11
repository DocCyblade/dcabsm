import { afterEach, describe, expect, it } from "vitest";
import { resolveInstanceNames } from "../src/instance/resolve-names.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

const usage = "Usage: dcabsm x";

describe("resolveInstanceNames", () => {
  it("refuses names together with --all", async () => {
    h = await harness();
    await expect(resolveInstanceNames(h.ctx, ["a"], true, { usage })).rejects.toThrow(
      "Give Instance names or --all, not both.",
    );
  });

  it("refuses no names unless allowEmpty", async () => {
    h = await harness();
    await expect(resolveInstanceNames(h.ctx, [], false, { usage })).rejects.toThrow(
      "Give at least one Instance name, or --all.",
    );
  });

  it("refuses --all on a Host with no Instances", async () => {
    h = await harness();
    await expect(resolveInstanceNames(h.ctx, [], true, { usage })).rejects.toThrow(
      "There are no Instances.",
    );
  });

  it("drops duplicate names", async () => {
    h = await harness();
    expect(await resolveInstanceNames(h.ctx, ["a", "a", "b"], false, { usage })).toEqual([
      "a",
      "b",
    ]);
  });
});
