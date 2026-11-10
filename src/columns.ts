/** Pads every column but the last to its widest cell plus two spaces; lines end without spaces. */
export function formatColumns(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]! + 2)))
      .join("")
      .trimEnd(),
  );
}
