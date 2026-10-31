// Append only logs can end on a half written line when a process is interrupted.

/** Parses JSON lines. A corrupt line never loses the others: it is counted, for the caller to report. */
export function parseJsonLines(text) {
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}
