import { afterEach, describe, expect, it } from "vitest";
import { Cancelled } from "../src/errors.ts";
import { confirm, confirmName, confirmOrCancel } from "../src/prompt.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

describe("confirmName", () => {
  it("accepts --confirm with the right name without asking", async () => {
    h = await harness();
    await confirmName(h.ctx, "family", { confirm: "family" });
    expect(h.asked).toEqual([]);
  });

  it("cancels on a wrong --confirm", async () => {
    h = await harness();
    await expect(confirmName(h.ctx, "family", { confirm: "test" })).rejects.toThrow(
      new Cancelled("The name did not match. Nothing changed."),
    );
  });

  it("asks for the typed name on a terminal", async () => {
    h = await harness({ interactive: true, answers: ["family"] });
    await confirmName(h.ctx, "family");
    expect(h.asked).toEqual(["Type the Instance name family to confirm: "]);
  });

  it("cancels when the typed name doesn't match", async () => {
    h = await harness({ interactive: true, answers: ["nope"] });
    await expect(confirmName(h.ctx, "family")).rejects.toBeInstanceOf(Cancelled);
  });

  it("refuses with no terminal and no flag", async () => {
    h = await harness({ interactive: false });
    await expect(confirmName(h.ctx, "family")).rejects.toMatchObject({
      message: "No terminal to confirm on.",
      hint: "Re-run with --confirm family to proceed without asking.",
      code: 2,
    });
  });
});

describe("confirm", () => {
  it("--yes answers without asking, even with no terminal", async () => {
    h = await harness();
    expect(await confirm(h.ctx, "Continue?", { yes: true })).toBe(true);
    expect(h.asked).toEqual([]);
  });

  it("refuses with no terminal and no flag", async () => {
    h = await harness();
    await expect(confirm(h.ctx, "Continue?")).rejects.toMatchObject({
      message: "No terminal to confirm on.",
      hint: "Re-run with --yes to proceed without asking.",
      code: 2,
    });
  });

  it("defaults to no with [y/N]", async () => {
    h = await harness({ interactive: true, answers: ["", "y", "YES", "n"] });
    expect(await confirm(h.ctx, "Continue?")).toBe(false);
    expect(h.asked[0]).toBe("Continue? [y/N] ");
    expect(await confirm(h.ctx, "Continue?")).toBe(true);
    expect(await confirm(h.ctx, "Continue?")).toBe(true);
    expect(await confirm(h.ctx, "Continue?")).toBe(false);
  });

  it("defaults to yes with [Y/n]", async () => {
    h = await harness({ interactive: true, answers: ["", "n"] });
    expect(await confirm(h.ctx, "Restart?", { defaultYes: true })).toBe(true);
    expect(h.asked[0]).toBe("Restart? [Y/n] ");
    expect(await confirm(h.ctx, "Restart?", { defaultYes: true })).toBe(false);
  });

  it("confirmOrCancel cancels on no", async () => {
    h = await harness({ interactive: true, answers: ["n"] });
    await expect(confirmOrCancel(h.ctx, "Continue?")).rejects.toThrow(
      "Cancelled. Nothing changed.",
    );
  });
});
