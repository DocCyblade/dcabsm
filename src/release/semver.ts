export type Version = [number, number, number];

export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/** Compares two `x.y.z` strings; unparseable ones sort first. */
export function compareText(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return va ? 1 : vb ? -1 : 0;
  return compareVersions(va, vb);
}

type Partial3 = [number, number | undefined, number | undefined];

function parsePartial(text: string): Partial3 | undefined {
  const parts = text.replace(/^v/, "").split(".");
  if (parts.length > 3 || parts[0] === "") return undefined;
  const nums = parts.map((p) =>
    /^[xX*]$/.test(p) ? undefined : /^\d+$/.test(p) ? Number(p) : Number.NaN,
  );
  if (nums.some((n) => Number.isNaN(n))) return undefined;
  if (nums[0] === undefined) return [0, undefined, undefined];
  return [nums[0], nums[1], nums[1] === undefined ? undefined : nums[2]];
}

const low = (p: Partial3): Version => [p[0], p[1] ?? 0, p[2] ?? 0];

/** The first version above everything a partial like `22` or `22.1` covers. */
function upper(p: Partial3): Version {
  if (p[1] === undefined) return [p[0] + 1, 0, 0];
  if (p[2] === undefined) return [p[0], p[1] + 1, 0];
  return [p[0], p[1], p[2] + 1];
}

function caretCeiling(p: Partial3): Version {
  if (p[0] > 0 || p[1] === undefined) return [p[0] + 1, 0, 0];
  if (p[1] > 0 || p[2] === undefined) return [0, p[1] + 1, 0];
  return [0, 0, p[2] + 1];
}

function comparator(token: string, v: Version): boolean {
  if (/^[xX*]$/.test(token)) return true;
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)!;
  const p = parsePartial(m[2]!);
  if (!p) return false;
  const c = (b: Version) => compareVersions(v, b);
  switch (m[1] ?? "") {
    case ">=":
      return c(low(p)) >= 0;
    case ">":
      return c(upper(p)) >= 0;
    case "<=":
      return c(upper(p)) < 0;
    case "<":
      return c(low(p)) < 0;
    case "^":
      return c(low(p)) >= 0 && c(caretCeiling(p)) < 0;
    case "~":
      return c(low(p)) >= 0 && c(p[1] === undefined ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0]) < 0;
    default:
      return c(low(p)) >= 0 && c(upper(p)) < 0;
  }
}

/**
 * Whether a version satisfies an npm `engines` range: `||` alternatives of
 * space-separated comparators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~`, x-ranges).
 * Hyphen ranges and pre-releases do not appear in `engines.node`.
 */
export function satisfies(version: Version, range: string): boolean {
  return range.split("||").some((set) => {
    const joined = set.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
    const tokens = joined.split(/\s+/).filter((t) => t !== "");
    return tokens.every((t) => comparator(t, version));
  });
}
