// One round of the study, launched twice a day by the scheduler until STUDY_END.
// Stores shapes only: no value returned by any server is ever written to disk.
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapPool, runIsolated } from './isolated.mjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const STUDY_END = '2026-12-05';
const MIN_GAP_HOURS = 6;
const CONCURRENCY = 6;
const HARD_TIMEOUT_MS = 90_000;
const WATCHDOG_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

async function readIfExists(file) {
  return readFile(file, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function loadDigestKey() {
  const file = join(DATA_DIR, 'digest.key');
  const existing = await readIfExists(file);
  if (existing) return existing.trim();
  const created = randomBytes(32).toString('hex');
  await writeFile(file, created);
  return created;
}

function summarise(rows) {
  const counts = { ok: 0, data: 0, toolError: 0, skipped: 0, failed: {} };
  for (const row of rows) {
    if (!row.ok) counts.failed[row.error] = (counts.failed[row.error] ?? 0) + 1;
    else counts.ok += 1;
    if (row.toolError) counts.toolError += 1;
    if (row.skipped) counts.skipped += 1;
    if (row.profile?.itemCount > 0) counts.data += 1;
  }
  return counts;
}

async function main() {
  const now = new Date();
  if (now.toISOString().slice(0, 10) > STUDY_END) return log(`study ended on ${STUDY_END}, nothing to do`);
  const stateFile = join(DATA_DIR, 'last-run.txt');
  const last = await readIfExists(stateFile);
  // The scheduler catches up after the PC was off: two catch-ups in a row would skew the series.
  if (last && (now - Date.parse(last.trim())) / HOUR_MS < MIN_GAP_HOURS) return log(`last run at ${last.trim()}, skipping`);
  // Written first: an interrupted round keeps what it collected and is not replayed at once.
  await writeFile(stateFile, now.toISOString());
  const digestKey = await loadDigestKey();
  const { servers } = JSON.parse(await readFile(join(DATA_DIR, 'panel.json'), 'utf8'));
  const file = join(DATA_DIR, `obs-${now.toISOString().slice(0, 7)}.jsonl`);
  const rows = await mapPool(
    servers,
    CONCURRENCY,
    async (entry) => {
      const result = await runIsolated('observe', { entry, now: now.toISOString(), digestKey }, HARD_TIMEOUT_MS);
      if (!result.isolationFailure) return result;
      return { at: now.toISOString(), server: entry.name, ok: false, stage: 'worker', error: result.isolationFailure };
    },
    (row) => appendFile(file, `${JSON.stringify(row)}\n`),
  );
  return log(`observed ${rows.length} servers: ${JSON.stringify(summarise(rows))}`);
}

setTimeout(() => {
  log('watchdog: run took too long, exiting');
  process.exit(1);
}, WATCHDOG_MS).unref();

try {
  await main();
  process.exit(0);
} catch (error) {
  log(`failed: ${error.stack}`);
  process.exit(1);
}
