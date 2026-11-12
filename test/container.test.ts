import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mirrorPath } from "./container/mirror.ts";

describe("the container journey's curl timeouts", () => {
  const script = readFileSync(new URL("./container/journey.sh", import.meta.url), "utf8");

  it("scale with JOURNEY_WAIT_SCALE like the polling waits, so parallel load cannot fail a probe", () => {
    expect(script).toContain("curl_max=$((5 * ${JOURNEY_WAIT_SCALE:-1}))");
    expect(script).not.toMatch(/--max-time\s+5\b/);
    expect(script.match(/--max-time "\$curl_max"/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the container mirror's paths", () => {
  it("maps a host and path to a file under the site root", () => {
    expect(mirrorPath("/site", "nodejs.org", "/dist/index.json")).toBe(
      "/site/nodejs.org/dist/index.json",
    );
  });

  it("decodes the %2f npm puts in a scoped package name", () => {
    expect(mirrorPath("/site", "registry.npmjs.org", "/@actual-app%2fsync-server/26.10.0")).toBe(
      "/site/registry.npmjs.org/@actual-app/sync-server/26.10.0",
    );
  });

  it("ignores the port and the query", () => {
    expect(mirrorPath("/site", "github.com:443", "/a/b?x=1")).toBe("/site/github.com/a/b");
  });

  it("refuses a path that climbs out of the root", () => {
    expect(mirrorPath("/site", "nodejs.org", "/../../etc/passwd")).toBeUndefined();
    expect(mirrorPath("/site", "nodejs.org", "/%2e%2e/%2e%2e/etc/passwd")).toBeUndefined();
    expect(mirrorPath("/site", "../x", "/a")).toBeUndefined();
  });
});
