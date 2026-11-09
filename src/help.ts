import { table } from "./table.ts";

export function helpLines(): string[] {
  const rows: Array<[string, string]> = [];
  for (const noun of table) {
    for (const verb of noun.verbs) {
      if (verb.hidden) continue;
      rows.push([`${noun.name} ${verb.usage}`, verb.summary]);
    }
  }
  const lines = ["Usage: dcabsm <noun> <verb> [args] [flags]", ""];
  for (const [usage, summary] of rows) {
    lines.push(`  ${usage}`, `      ${summary}`);
  }
  lines.push(
    "",
    "  help",
    "      Print this list",
    "  --version",
    "      Print the installed version",
  );
  return lines;
}
