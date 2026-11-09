import { readFile } from "node:fs/promises";
import type { Context } from "../context.ts";

export type Arch = "amd64" | "arm64";

export interface SupportedOs {
  /** As the README and docs/cli.md print it. */
  name: string;
  /** `ID` and `VERSION_ID` in /etc/os-release. */
  id: string;
  versionId: string;
  arches: Arch[];
  form: string;
}

/**
 * The supported OS table (spec 1.4), the one place the list lives. The README's
 * table is checked against it by a test. Add an OS only after the OS gate (13.6).
 *
 * The TurnKey rows share Debian 13's os-release; telling the appliances apart
 * is the TurnKey ticket's job (spec 10.7).
 */
export const SUPPORTED_OS: SupportedOs[] = [
  {
    name: "Debian 13",
    id: "debian",
    versionId: "13",
    arches: ["amd64", "arm64"],
    form: "any install",
  },
  {
    name: "Ubuntu 24.04 LTS",
    id: "ubuntu",
    versionId: "24.04",
    arches: ["amd64", "arm64"],
    form: "any install",
  },
  {
    name: "Ubuntu 26.04 LTS",
    id: "ubuntu",
    versionId: "26.04",
    arches: ["amd64", "arm64"],
    form: "any install",
  },
  {
    name: "TurnKey Core 19.x (Debian 13)",
    id: "debian",
    versionId: "13",
    arches: ["amd64"],
    form: "from the ISO",
  },
  {
    name: "TurnKey Node.js 19.x (Debian 13)",
    id: "debian",
    versionId: "13",
    arches: ["amd64"],
    form: "from the ISO",
  },
];

export function parseOsRelease(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

export function archName(nodeArch: string): string {
  return nodeArch === "x64" ? "amd64" : nodeArch;
}

export interface DetectedOs {
  /** What to show: the pretty name, or the id if there is none. */
  name: string;
  codename: string | undefined;
  arch: string;
  /** Undefined when this OS and architecture are not in the table. */
  supported: SupportedOs | undefined;
}

/** Reads /etc/os-release, never `dpkg-vendor`, which says `TurnKey` on a TurnKey appliance (spec 1.4). */
export async function detectOs(ctx: Context): Promise<DetectedOs> {
  let values: Record<string, string> = {};
  try {
    values = parseOsRelease(await readFile(ctx.paths.osRelease, "utf8"));
  } catch {
    // No os-release: not a supported OS.
  }
  const arch = archName(ctx.arch);
  const supported = SUPPORTED_OS.find(
    (os) =>
      os.id === values["ID"] &&
      os.versionId === values["VERSION_ID"] &&
      (os.arches as string[]).includes(arch),
  );
  return {
    name: values["PRETTY_NAME"] ?? values["ID"] ?? "an unknown OS",
    codename: values["VERSION_CODENAME"],
    arch,
    supported,
  };
}

export function supportedNames(): string {
  const names: string[] = [];
  for (const os of SUPPORTED_OS) if (!names.includes(os.name)) names.push(os.name);
  return names.join(", ");
}
