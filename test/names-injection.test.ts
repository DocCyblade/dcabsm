import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";
import { requireInstance } from "../src/instance/record.ts";
import { harness, type Harness } from "./helpers.ts";

let h: Harness;
afterEach(() => h.cleanup());

/** A directory beside the Instances with a record in it, which a `../` name would reach. */
async function decoy(): Promise<void> {
  const dir = join(h.ctx.paths.instances, "..", "decoy");
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(
    join(dir, "config/instance.json"),
    JSON.stringify({ port: 15999, hostname: "decoy.example.org" }),
  );
}

describe("an Instance name is checked wherever it is used", () => {
  it("requireInstance refuses a name that climbs out of the Instances directory", async () => {
    h = await harness({ setUp: true });
    await decoy();
    await expect(requireInstance(h.ctx, "../decoy")).rejects.toThrow(
      "is not a valid Instance name",
    );
  });

  it("instance show refuses it too", async () => {
    h = await harness({ setUp: true });
    await decoy();
    expect(await run(["instance", "show", "../decoy"], h.ctx)).not.toBe(0);
    expect(h.err.join("\n")).toContain("is not a valid Instance name");
  });
});
