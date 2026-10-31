// Reads the observations and separates what every status page sees (outages)
// from what the study is about (the server answers, but no longer delivers).
// The method is tested against simulated stationary servers: see the false alarm test.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { learnContract } from '../src/contract.mjs';
import { checkProfile } from '../src/check.mjs';
import { parseJsonLines } from '../src/jsonl.mjs';

export const BASELINE_RUNS = 6;
export const SUSTAINED_RUNS = 2;
const LOCAL_FAILURE_SHARE = 0.5;
const MAX_EXAMPLES = 5;
// Failures that say something about our side, never about the server.
const OUR_FAULT = new Set(['internal', 'worker_crash', 'out_of_memory']);
// A key or a quota of ours (keyed panel). They say nothing about the source, nor about our connection.
const ACCOUNT_FAULT = new Set(['key_refused', 'quota']);

function learnBaseline(server, usable) {
  const rows = usable.slice(0, BASELINE_RUNS);
  if (rows.length < BASELINE_RUNS || rows.some((row) => row.profile.itemCount === 0)) return { contract: null, lastAt: '' };
  const source = { type: 'observed', path: 'x', key: server };
  return { contract: learnContract(rows.map((row) => row.profile), { name: server, source }), lastAt: rows.at(-1).at };
}

// A break is sustained when the same rule on the same field fails on consecutive observations.
// One odd response is what sampling looks like, not an incident.
function trackBreaks(rows, contract, lastAt, detail) {
  let streaks = new Map();
  for (const row of rows) {
    if (!row.profile || row.at <= lastAt) continue;
    const { violations } = checkProfile(contract, row.profile);
    const current = new Map();
    for (const violation of violations) {
      const key = `${violation.field ?? ''}:${violation.rule}`;
      const streak = (streaks.get(key) ?? 0) + 1;
      current.set(key, streak);
      if (streak !== SUSTAINED_RUNS) continue;
      detail.silentBreaks += 1;
      if (detail.examples.length < MAX_EXAMPLES) detail.examples.push({ at: row.at, rule: violation.rule, field: violation.field, message: violation.message });
    }
    for (const [key, streak] of streaks) if (streak === 1 && !current.has(key)) detail.transientBreaks += 1;
    streaks = current;
  }
}

function trackChanges(rows, detail) {
  let previous = null;
  for (const row of rows) {
    if (!row.ok) continue;
    if (previous && row.toolsHash !== previous.toolsHash) detail.catalogueChanges += 1;
    if (previous && row.profile?.digest && row.profile.digest === previous.profile?.digest) detail.unchangedRuns += 1;
    previous = row;
  }
}

function analyseServer(server, rows) {
  const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const { contract, lastAt } = learnBaseline(server, sorted.filter((row) => row.ok && row.profile));
  const detail = {
    server,
    runs: sorted.length,
    baselineReady: Boolean(contract),
    outages: sorted.filter((row) => !row.ok).length,
    toolErrors: sorted.filter((row) => row.toolError).length,
    skipped: sorted.filter((row) => row.skipped).length,
    catalogueChanges: 0,
    silentBreaks: 0,
    transientBreaks: 0,
    unchangedRuns: 0,
    examples: [],
  };
  trackChanges(sorted, detail);
  if (contract) trackBreaks(sorted, contract, lastAt, detail);
  return detail;
}

/** Rounds where most of the panel failed at once say our connection was down: they are set aside. */
function excludeLocalFailures(rows) {
  const excludedRounds = new Set();
  const judged = rows.filter((row) => !ACCOUNT_FAULT.has(row.error));
  for (const [at, round] of Map.groupBy(judged, (row) => row.at)) {
    if (round.filter((row) => !row.ok).length / round.length >= LOCAL_FAILURE_SHARE) excludedRounds.add(at);
  }
  return { kept: judged.filter((row) => !excludedRounds.has(row.at) && !OUR_FAULT.has(row.error)), excludedRounds: excludedRounds.size };
}

/** A source we could not ask must stay visible: it has no detail of its own. */
function countAccountFaults(rows) {
  const counts = {};
  for (const row of rows) if (ACCOUNT_FAULT.has(row.error)) counts[row.server] = (counts[row.server] ?? 0) + 1;
  return counts;
}

/** Pure on purpose, so that the published numbers can be recomputed and tested. */
export function analyse(allRows) {
  const { kept, excludedRounds } = excludeLocalFailures(allRows);
  const details = [...Map.groupBy(kept, (row) => row.server)].map(([server, rows]) => analyseServer(server, rows));
  const count = (test) => details.filter(test).length;
  return {
    servers: details.length,
    observations: kept.length,
    excludedRounds,
    excludedRows: allRows.length - kept.length,
    accountFaults: countAccountFaults(allRows),
    withBaseline: count((detail) => detail.baselineReady),
    withOutage: count((detail) => detail.outages > 0),
    withToolError: count((detail) => detail.toolErrors > 0),
    withCatalogueChange: count((detail) => detail.catalogueChanges > 0),
    withSilentBreak: count((detail) => detail.silentBreaks > 0),
    details,
  };
}

export async function readObservations(dir) {
  const files = (await readdir(dir)).filter((file) => /^obs-.*\.jsonl$/.test(file));
  const rows = [];
  let skipped = 0;
  for (const file of files) {
    const parsed = parseJsonLines(await readFile(join(dir, file), 'utf8'));
    rows.push(...parsed.rows);
    skipped += parsed.skipped;
  }
  return { rows, skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // `node analyse.mjs keyed` reads the second panel.
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'data', process.argv[2] ?? '');
  const { rows, skipped } = await readObservations(dir);
  if (skipped) console.warn(`${skipped} corrupt line(s) skipped`);
  const result = analyse(rows);
  await writeFile(join(dir, 'study-results.json'), JSON.stringify(result, null, 2));
  const { details, ...summary } = result;
  console.log(summary);
  for (const detail of details.filter((entry) => entry.silentBreaks > 0).slice(0, 20)) {
    console.log(`${detail.server}: ${detail.silentBreaks} silent break(s), e.g. ${detail.examples[0].message}`);
  }
}
