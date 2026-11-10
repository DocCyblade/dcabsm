import { isIP } from "node:net";
import { compareText } from "../release/semver.ts";

/** A value as the record holds it: a number, a boolean or a string. */
export type SettingValue = number | boolean | string;

export interface SettingDef {
  /** The DCABSM key, as the System Admin types it. */
  key: string;
  /** Actual's key in `config.json`; dots mean nesting. */
  actualKey: string;
  /** Actual's default, as `instance settings` shows it. */
  defaultText: string;
  /** What a good value looks like, for the refusal. */
  expects: string;
  /** Checks and converts text typed by the System Admin, or returns undefined when it is not valid. */
  parse(text: string): SettingValue | undefined;
  /** The first Release that knows the setting. */
  firstRelease: string;
  /** Value written to `config.json` (lists become arrays). */
  toConfig(value: SettingValue): unknown;
}

/** An upload limit in MB: Nginx sizes `client_max_body_size` from these (spec 5.2). */
export interface UploadDef extends SettingDef {
  /** Actual's default, in MB. */
  defaultValue: number;
}

function megabytes(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= 1024 ? n : undefined;
}

function networkList(text: string): string | undefined {
  const items = text.split(",").map((s) => s.trim());
  const ok = items.every((item) => {
    const [addr, prefix, extra] = item.split("/");
    const family = isIP(addr ?? "");
    if (family === 0 || extra !== undefined) return false;
    if (prefix === undefined) return true;
    return /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
  });
  return ok ? items.join(",") : undefined;
}

const identity = (v: SettingValue): unknown => v;
const upload = (key: string, actualKey: string, defaultValue: number): UploadDef => ({
  key,
  actualKey,
  defaultText: String(defaultValue),
  defaultValue,
  expects: "a whole number from 1 to 1024",
  parse: megabytes,
  firstRelease: "26.10.0",
  toConfig: identity,
});

/** The upload limits. */
export const UPLOAD_SETTINGS: readonly UploadDef[] = [
  upload("upload-sync-limit-mb", "upload.fileSizeSyncLimitMB", 20),
  upload("upload-encrypted-sync-limit-mb", "upload.syncEncryptedFileSizeLimitMB", 50),
  upload("upload-limit-mb", "upload.fileSizeLimitMB", 20),
];

/** The settings table (spec 4.11). */
export const SETTINGS: readonly SettingDef[] = [
  ...UPLOAD_SETTINGS,
  {
    key: "openid-enforce",
    actualKey: "enforceOpenId",
    defaultText: "false",
    expects: "true or false",
    parse: (t) => (t === "true" ? true : t === "false" ? false : undefined),
    firstRelease: "26.10.0",
    toConfig: identity,
  },
  {
    key: "openid-user-creation",
    actualKey: "userCreationMode",
    defaultText: "manual",
    expects: "manual or login",
    parse: (t) => (t === "manual" || t === "login" ? t : undefined),
    firstRelease: "26.10.0",
    toConfig: identity,
  },
  {
    key: "simplefin-allowed-networks",
    actualKey: "simplefinAllowedNetworks",
    defaultText: "(empty)",
    expects: "comma-separated IP addresses and CIDRs",
    parse: networkList,
    firstRelease: "26.11.0",
    toConfig: (v) => String(v).split(","),
  },
];

export const findSetting = (key: string): SettingDef | undefined =>
  SETTINGS.find((s) => s.key === key);

/** Whether a Release knows the setting. */
export const usedBy = (def: SettingDef, release: string): boolean =>
  compareText(release, def.firstRelease) >= 0;

/** Keys DCABSM always sets (spec 4.4). */
export const ALWAYS_SET = [
  "dataDir",
  "serverFiles",
  "userFiles",
  "hostname",
  "port",
  "trustedProxies",
  "allowedLoginMethods",
  "trustedAuthProxies",
];

/** Never settable (spec 4.11); `https.*` and `openId.*` are prefixes. */
export const NEVER_SET = ["loginMethod", "webRoot", "env", "mode", "projectRoot"];

/** Why a key that is not in the table can't be set, if it is a known Actual key. */
export function neverSettable(key: string): string | undefined {
  if (ALWAYS_SET.includes(key)) return "DCABSM always sets it";
  if (key === "https" || key.startsWith("https.")) return "Nginx handles TLS";
  if (key === "openId" || key.startsWith("openId.")) {
    return "OpenID is set up in Actual's web UI (ADR-0005)";
  }
  if (NEVER_SET.includes(key)) {
    return key === "loginMethod"
      ? "password and OpenID are switched in Actual's web UI"
      : "DCABSM does not expose it";
  }
  return undefined;
}

/** One line of `instance show`: settings set, with those the Release doesn't know marked. */
export function settingsSummary(
  settings: Record<string, SettingValue> | undefined,
  release: string,
): string | undefined {
  const parts = SETTINGS.flatMap((def) => {
    const value = settings?.[def.key];
    if (value === undefined) return [];
    return [`${def.key} ${value}${usedBy(def, release) ? "" : ` (not used by ${release})`}`];
  });
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** The value in force: what was set, or Actual's default. */
export function effectiveMb(
  def: UploadDef,
  settings: Record<string, SettingValue> | undefined,
): number {
  const v = settings?.[def.key];
  return typeof v === "number" ? v : def.defaultValue;
}

/** The upload limits the vhost sizes `client_max_body_size` from. */
export const UPLOAD_KEYS: readonly string[] = UPLOAD_SETTINGS.map((s) => s.key);

/** Nginx's `client_max_body_size` in MB: just above the largest upload limit (spec 5.2). */
export function bodyLimitMb(settings: Record<string, SettingValue> | undefined): number {
  return Math.max(...UPLOAD_SETTINGS.map((d) => effectiveMb(d, settings))) + 1;
}
