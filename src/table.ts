import type { Context } from "./context.ts";
import { hostSetup } from "./host/setup.ts";
import { hostCheckUpdates } from "./host/updates.ts";
import { releaseInstall } from "./release/install.ts";
import { instanceCreate } from "./instance/create.ts";
import { instanceList, instanceShow } from "./instance/list.ts";
import { releaseList } from "./release/list.ts";
import { versionLine } from "./version.ts";

export interface Invocation {
  ctx: Context;
  args: string[];
}

export type Handler = (inv: Invocation) => Promise<void>;

export interface Verb {
  name: string;
  /** What follows `dcabsm <noun>` in `help`. */
  usage: string;
  summary: string;
  /** Routable but left out of `help`. */
  hidden?: boolean;
  /** Runs without root. Default: root is required. */
  noRoot?: boolean;
  /** Runs before the Host is set up. Default: refuses until `dcabsm.json` exists. */
  beforeSetup?: boolean;
  /** Takes the Host-wide lock and logs a line to journald. */
  changes?: boolean | ((args: string[]) => boolean);
  /** Filled in by the ticket that builds the command. */
  run?: Handler;
}

export interface Noun {
  name: string;
  verbs: Verb[];
}

/**
 * The one declarative noun → verb table. It drives `help` and routing
 * (spec 9, docs/cli.md). A ticket builds a command by setting its `run`.
 */
export const table: Noun[] = [
  {
    name: "host",
    verbs: [
      {
        name: "setup",
        usage: "setup [--release <v>] [--backup-dir <path>] [--yes]",
        summary: "Prepare the Host and install the first Release",
        beforeSetup: true,
        changes: true,
        run: hostSetup,
      },
      {
        name: "doctor",
        usage: "doctor [--fix] [--yes]",
        summary: "Check the Host and every Instance, and optionally fix what DCABSM owns",
        changes: (args) => args.includes("--fix"),
      },
      {
        name: "check-updates",
        usage: "check-updates",
        summary: "Look for a newer Actual Release, Node patch and DCABSM version",
        run: hostCheckUpdates,
      },
      { name: "settings", usage: "settings", summary: "Show the Host settings" },
      {
        name: "set",
        usage: "set <key> <value>",
        summary: "Change one Host setting",
        changes: true,
      },
      {
        name: "nightly",
        usage: "nightly",
        summary: "The Nightly run, started by the dcabsm-nightly service",
        hidden: true,
        changes: true,
      },
    ],
  },
  {
    name: "instance",
    verbs: [
      {
        name: "list",
        usage: "list",
        summary: "The overview: every Instance, then the last update check",
        run: instanceList,
      },
      { name: "show", usage: "show <name>", summary: "One Instance in detail", run: instanceShow },
      {
        name: "create",
        usage:
          "create <name> --hostname <host> (--cert <f> --key <f> | --self-signed) [--release <v>]",
        summary: "Create an Instance",
        changes: true,
        run: instanceCreate,
      },
      {
        name: "remove",
        usage: "remove <name> [--confirm <name>]",
        summary: "Take a final Backup, then delete the Instance",
        changes: true,
      },
      {
        name: "start",
        usage: "start <names>|--all",
        summary: "Start Instances",
        changes: true,
      },
      {
        name: "stop",
        usage: "stop <names>|--all",
        summary: "Stop Instances",
        changes: true,
      },
      {
        name: "restart",
        usage: "restart <names>|--all",
        summary: "Restart Instances",
        changes: true,
      },
      {
        name: "logs",
        usage: "logs <name> [-f] [--since <time>]",
        summary: "Read an Instance's journal",
      },
      {
        name: "set-hostname",
        usage: "set-hostname <name> <host> [--cert <f> [--key <f>] | --self-signed]",
        summary: "Move an Instance to a new hostname",
        changes: true,
      },
      {
        name: "reset-password",
        usage: "reset-password <name>",
        summary: "Reset the server password in Actual's own tool",
        changes: true,
      },
      { name: "settings", usage: "settings <name>", summary: "Show an Instance's settings" },
      {
        name: "set",
        usage: "set <name> <key> <value> [--yes]",
        summary: "Change one Instance setting",
        changes: true,
      },
      {
        name: "unset",
        usage: "unset <name> <key> [--yes]",
        summary: "Return one Instance setting to Actual's default",
        changes: true,
      },
      {
        name: "upgrade",
        usage: "upgrade <names>|--all [--to <v>] [--yes]",
        summary: "Move Instances to a newer Release",
        changes: true,
      },
      {
        name: "rollback",
        usage: "rollback <name> [--restore-data] [--confirm <name>]",
        summary: "Go back one step to the previous Release",
        changes: true,
      },
      {
        name: "restore",
        usage: "restore <name> [<archive>] [--confirm <name>] | restore --from <archive>",
        summary: "Restore an Instance from a Backup, or rebuild one from an archive",
        changes: true,
      },
      {
        name: "clone",
        usage:
          "clone <source> <new> --hostname <host> [cert options] [--yes] | clone --from <archive> <new> ...",
        summary: "Copy an Instance, or make a new one from an archive",
        changes: true,
      },
    ],
  },
  {
    name: "backup",
    verbs: [
      {
        name: "create",
        usage: "create <names>|--all",
        summary: "Take a manual Backup",
        changes: true,
      },
      { name: "list", usage: "list [<names>]", summary: "List archives" },
      {
        name: "prune",
        usage: "prune [<names>|--all] [--dry-run]",
        summary: "Apply Retention by hand",
        changes: (args) => !args.includes("--dry-run"),
      },
      {
        name: "schedule",
        usage: "schedule <name> on|off",
        summary: "Switch scheduled Backups on or off for one Instance",
        changes: true,
      },
    ],
  },
  {
    name: "cert",
    verbs: [
      { name: "test", usage: "test [<names>|--all]", summary: "Check what each hostname serves" },
      {
        name: "update",
        usage: "update <names>|--all --cert <f> [--key <f>]",
        summary: "Swap in a new certificate",
        changes: true,
      },
    ],
  },
  {
    name: "release",
    verbs: [
      {
        name: "list",
        usage: "list",
        summary: "Installed Releases, their Node runtime and the Instances on them",
        run: releaseList,
      },
      {
        name: "install",
        usage: "install <v>",
        summary: "Install a Release",
        changes: true,
        run: releaseInstall,
      },
      {
        name: "prune",
        usage: "prune [--yes]",
        summary: "Remove Releases no Instance uses, and unused Node runtimes",
        changes: true,
      },
      {
        name: "update-node",
        usage: "update-node [--yes]",
        summary: "Install a Node patch and restart the Instances on it",
        changes: true,
      },
    ],
  },
  {
    name: "self",
    verbs: [
      {
        name: "update",
        usage: "update [--to <ver>] [--yes]",
        summary: "Update DCABSM itself",
        beforeSetup: true,
        changes: true,
      },
      {
        name: "version",
        usage: "version",
        summary: "Print the installed version. dcabsm --version does the same",
        noRoot: true,
        beforeSetup: true,
        run: async ({ ctx }) => ctx.io.out(versionLine()),
      },
    ],
  },
];

export function findNoun(name: string): Noun | undefined {
  return table.find((n) => n.name === name);
}

export function findVerb(noun: Noun, name: string): Verb | undefined {
  return noun.verbs.find((v) => v.name === name);
}
