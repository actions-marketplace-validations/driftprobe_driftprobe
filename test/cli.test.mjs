import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'driftprobe.mjs');
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

const healthy = { results: Array.from({ length: 20 }, (_, i) => ({ name: `p${i}`, price: i + 1 })) };
const degraded = { results: healthy.results.map((item, i) => ({ ...item, price: i < 3 ? item.price : null })) };

async function learnedContract(extra = []) {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const data = join(dir, 'data.json');
  const contract = join(dir, 'contract.yaml');
  await writeFile(data, JSON.stringify(healthy));
  const learned = run('learn', data, '--name', 'products', '--out', contract, ...extra);
  assert.equal(learned.status, 0, learned.stderr);
  return { dir, data, contract };
}

test('learn then check passes on the same data', async () => {
  const { contract } = await learnedContract();
  const result = run('check', contract);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 ok/);
});

test('check exits 1 and names the field when the data degrades', async () => {
  const { data, contract } = await learnedContract();
  await writeFile(data, JSON.stringify(degraded));
  const result = run('check', contract);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /price: only 15% of 20 items carry a value/);
});

test('--github emits annotations and --json stays machine readable', async () => {
  const { data, contract } = await learnedContract();
  await writeFile(data, JSON.stringify(degraded));
  assert.match(run('check', contract, '--github').stdout, /^::error title=driftprobe products::price: only 15%25/m);
  const parsed = JSON.parse(run('check', contract, '--json').stdout);
  assert.equal(parsed[0].report.ok, false);
});

test('check exits 2 when the source cannot be read', async () => {
  const { data, contract } = await learnedContract();
  await writeFile(data, 'not json');
  const result = run('check', contract);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /could not check/);
});

test('a credential found in a learned URL never reaches the contract', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(healthy));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const contract = join(dir, 'c.yaml');
  const url = 'http://127.0.0.1:' + server.address().port + '/p?q=shoes&api_key=super-secret-value';
  const learned = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'learn', url, '--name', 'p', '--out', contract], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stderr }));
  });
  assert.equal(learned.status, 0, learned.stderr);
  assert.match(learned.stderr, /API_KEY/);
  const text = await readFile(contract, 'utf8');
  assert.ok(!text.includes('super-secret-value'));
  assert.match(text, /api_key=\$\{DRIFTPROBE_API_KEY\}/);
  assert.match(text, /q=shoes/);
});

test('--fields restricts the contract to what the agent reads', async () => {
  const { contract } = await learnedContract(['--fields', 'price']);
  const text = await readFile(contract, 'utf8');
  assert.match(text, /price:/);
  assert.doesNotMatch(text, /name: *\n\s+min_coverage/);
});

test('fails with a short message on bad usage', () => {
  assert.equal(run('check').status, 2);
  const unknown = run('nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command/);
  assert.doesNotMatch(run('check', 'missing.yaml').stderr, /\bat .*\.mjs/);
});

test('learn --observed writes one contract per key, with a path relative to the contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const observed = join(dir, 'observed.jsonl');
  const profile = { itemsPath: 'results', itemCount: 10, fields: { price: { usable: 10, kinds: { number: 10 }, distinct: 10 } } };
  const at = new Date().toISOString();
  await writeFile(observed, `${JSON.stringify({ at, key: 'GET /v1/items', profile })}\n${JSON.stringify({ at, key: 'mcp:search', profile })}\n`);
  const out = join(dir, 'contracts');
  assert.equal(run('learn', '--observed', observed, '--out-dir', out).status, 0);
  const text = await readFile(join(out, 'GET_v1_items.yaml'), 'utf8');
  assert.match(text, /path: \.\.\/observed\.jsonl/);
  assert.equal(run('check', join(out, 'GET_v1_items.yaml'), join(out, 'mcp_search.yaml')).status, 0);
});
