import { describe, expect, it } from "vitest";
import { realRunner } from "../src/real.ts";

describe("realRunner", () => {
  it("keeps the whole output of a command that prints more than 1 MB (a tar listing of many files)", async () => {
    const size = 3 * 1024 * 1024;
    const res = await realRunner.run(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(${size}))`,
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBe(size);
  });
});
