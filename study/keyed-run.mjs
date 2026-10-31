// One round of the keyed panel, launched after run.mjs by the same scheduled task.
//   node keyed-run.mjs           one round, stored in data/keyed
//   node keyed-run.mjs --check   tries every key without storing anything
// Keys come from the file named by DRIFTPROBE_STUDY_KEYS. A source without a key is simply left out.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeKeyed, parseKeys } from './keyed.mjs';
import { KEY_SOURCES } from './keyed-sources.mjs';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const OUT_DIR = join(DATA_DIR, 'keyed');
const STUDY_END = '2026-12-05';
const MIN_GAP_HOURS = 6;
const HOUR_MS = 3_600_000;
const WATCHDOG_MS = 10 * 60_000;

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

async function loadKeys() {
  const file = process.env.DRIFTPROBE_STUDY_KEYS;
  if (!file) throw new Error('DRIFTPROBE_STUDY_KEYS is not set');
  return parseKeys((await readIfExists(file)) ?? '');
}

const describe = (row) => (row.ok ? `${row.profile.itemCount} items, ${Object.keys(row.profile.fields).length} fields` : row.error);

async function check(keys, digestKey) {
  for (const source of KEY_SOURCES) {
    const key = keys.get(source.variable);
    console.log(`${source.name}: ${key ? describe(await observeKeyed(source, key, { digestKey })) : 'no key'}`);
  }
}

async function round(keys, digestKey) {
  const now = new Date();
  if (now.toISOString().slice(0, 10) > STUDY_END) return log(`study ended on ${STUDY_END}, nothing to do`);
  const sources = KEY_SOURCES.filter((source) => keys.has(source.variable));
  const stateFile = join(OUT_DIR, 'last-run.txt');
  const last = await readIfExists(stateFile);
  // Before the first round this is normal. After it, the key file has gone: the series must not stop in silence.
  if (sources.length === 0 && last) throw new Error('no key found although rounds already ran, check the key file');
  if (sources.length === 0) return log('no key yet');
  await mkdir(OUT_DIR, { recursive: true });
  if (last && (now - Date.parse(last.trim())) / HOUR_MS < MIN_GAP_HOURS) return log(`last run at ${last.trim()}, skipping`);
  await writeFile(stateFile, now.toISOString());
  const rows = await Promise.all(sources.map((source) => observeKeyed(source, keys.get(source.variable), { now, digestKey })));
  await appendFile(join(OUT_DIR, `obs-${now.toISOString().slice(0, 7)}.jsonl`), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const failed = rows.filter((row) => !row.ok).map((row) => `${row.server}:${row.error}`);
  const empty = rows.filter((row) => row.ok && row.profile.itemCount === 0).map((row) => row.server);
  const noKey = KEY_SOURCES.filter((source) => !keys.has(source.variable)).map((source) => source.name);
  return log(`observed ${rows.length} of ${KEY_SOURCES.length} sources, failed [${failed.join(' ')}], empty [${empty.join(' ')}], no key [${noKey.join(' ')}]`);
}

setTimeout(() => {
  log('watchdog: run took too long, exiting');
  process.exit(1);
}, WATCHDOG_MS).unref();

try {
  const keys = await loadKeys();
  const digestKey = await loadDigestKey();
  await (process.argv.includes('--check') ? check(keys, digestKey) : round(keys, digestKey));
  process.exit(0);
} catch (error) {
  log(`failed: ${error.message}`);
  process.exit(1);
}
