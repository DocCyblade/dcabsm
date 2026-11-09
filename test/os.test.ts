import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOsRelease, SUPPORTED_OS } from "../src/host/os.ts";

describe("supported OS table", () => {
  it("matches the README's list", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const rows = [
      ...readme.matchAll(/^\| (.+?) \| ((?:amd64|arm64)(?:, arm64)?) \| (.+?) \|$/gm),
    ].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(SUPPORTED_OS.map((os) => [os.name, os.arches.join(", "), os.form]));
  });
});

describe("parseOsRelease", () => {
  it("strips quotes and ignores other lines", () => {
    expect(parseOsRelease("ID=ubuntu\nVERSION_ID=\"24.04\"\n# note\nNAME='Ubuntu'\n")).toEqual({
      ID: "ubuntu",
      VERSION_ID: "24.04",
      NAME: "Ubuntu",
    });
  });
});
