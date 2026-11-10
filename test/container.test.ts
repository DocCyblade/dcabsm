import { describe, expect, it } from "vitest";
import { mirrorPath } from "./container/mirror.ts";

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
