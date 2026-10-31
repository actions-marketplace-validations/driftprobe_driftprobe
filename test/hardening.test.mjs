// Regressions from the code audit of 31 October 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkProfile } from '../src/check.mjs';
import { learnContract, parseContract } from '../src/contract.mjs';
import { profileDocument } from '../src/profile.mjs';
import { startRecorder } from '../src/record.mjs';
import { formatGithub, formatHuman, neutralizeCommands } from '../src/report.mjs';
import { withoutSecretArguments, withoutSecrets } from '../src/secrets.mjs';
import { expandDeep, expandEnv, loadDocument, loadProfile, SourceError } from '../src/sources.mjs';

const HOUR_MS = 3_600_000;
const NOW = new Date('2026-10-31T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function observedFile(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const path = join(dir, 'observed.jsonl');
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

const contractYaml = (expect) => `version: 1\nname: n\nsource: { type: file, path: x.json }\nexpect: ${expect}\n`;
const freshField = { usable: 10, kinds: { date: 10 }, distinct: 10, ageHours: 2 };

test('a field listed without min_coverage fails when it disappears', () => {
  const contract = { expect: { fields: { updated_at: { type: 'date', max_age: '48h' } } } };
  const missing = checkProfile(contract, { itemCount: 10, fields: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.violations[0].rule, 'present');
  assert.match(missing.violations[0].message, /updated_at: no item carries a value/);
  const allNull = checkProfile(contract, { itemCount: 10, fields: { updated_at: { usable: 0, kinds: { null: 10 }, distinct: 0 } } });
  assert.equal(allNull.ok, false);
});

test('min_coverage: 0 keeps a field optional', () => {
  const contract = { expect: { fields: { nickname: { min_coverage: 0 } } } };
  assert.equal(checkProfile(contract, { itemCount: 10, fields: {} }).ok, true);
});

test('a field that disappears is reported once, not once per rule', () => {
  const contract = { expect: { fields: { price: { min_coverage: 0.9, type: 'number' } } } };
  assert.equal(checkProfile(contract, { itemCount: 10, fields: {} }).violations.length, 1);
});

test('a misspelled rule is refused instead of being ignored', () => {
  assert.throws(() => parseContract(contractYaml('{ fields: { price: { min_coverge: 0.9 } } }')), /unknown rule "min_coverge"/);
  assert.throws(() => parseContract(contractYaml('{ min_itms: 3 }')), /unknown key "min_itms"/);
});

test('an observed contract counts the time passed since the observation', async () => {
  const profile = { itemCount: 10, fields: { updated_at: freshField } };
  const path = await observedFile([{ at: hoursAgo(50), key: 'k', profile }]);
  const aged = await loadProfile({ source: { type: 'observed', path, key: 'k' } }, { now: NOW });
  assert.equal(aged.fields.updated_at.ageHours, 52);
  assert.equal(profile.fields.updated_at.ageHours, 2);
});

test('an observed contract cannot be checked once the proxy has gone silent', async () => {
  const path = await observedFile([{ at: hoursAgo(24 * 30), key: 'k', profile: { itemCount: 10, fields: {} } }]);
  const source = { type: 'observed', path, key: 'k' };
  await assert.rejects(loadProfile({ source }, { now: NOW }), (error) => error instanceof SourceError && /30 days ago/.test(error.message));
  const relaxed = await loadProfile({ source: { ...source, max_silence: '60d' } }, { now: NOW });
  assert.equal(relaxed.itemCount, 10);
  const undated = await observedFile([{ key: 'k', profile: { itemCount: 10, fields: {} } }]);
  await assert.rejects(loadProfile({ source: { ...source, path: undated } }, { now: NOW }), SourceError);
});

test('an invalid max_silence is refused when the contract is read', () => {
  const text = 'version: 1\nname: n\nsource: { type: observed, path: x, key: k, max_silence: soon }\n';
  assert.throws(() => parseContract(text), /invalid max_silence "soon"/);
});

test('a null or scalar where the list should be counts as no list at all', () => {
  for (const results of [null, 'maintenance', 42, false]) {
    const profile = profileDocument({ results }, { itemsPath: 'results', now: NOW });
    assert.equal(profile.itemCount, 0, String(results));
    assert.equal(profile.itemsMissing, true);
  }
  assert.equal(profileDocument({ data: { a: 1 } }, { itemsPath: 'data', now: NOW }).itemCount, 1);
  assert.equal(profileDocument(null, { now: NOW }).itemCount, 0);
  const report = checkProfile({ expect: {} }, profileDocument({ results: null }, { itemsPath: 'results', now: NOW }));
  assert.equal(report.ok, false);
});

test('a scalar document stays readable when the contract learned it that way', () => {
  assert.equal(profileDocument('plain', { itemsPath: '.', now: NOW }).itemCount, 1);
});

test('a contract only reaches variables named DRIFTPROBE_', () => {
  assert.equal(expandEnv('Bearer ${DRIFTPROBE_TOKEN}', { DRIFTPROBE_TOKEN: 'abc' }), 'Bearer abc');
  assert.throws(() => expandEnv('https://evil.test/${AWS_SECRET_ACCESS_KEY}', { AWS_SECRET_ACCESS_KEY: 'leak' }), (error) => {
    assert.ok(error instanceof SourceError);
    assert.match(error.message, /DRIFTPROBE_/);
    assert.doesNotMatch(error.message, /leak/);
    return true;
  });
});

test('variables are expanded inside tool arguments and JSON bodies', async (t) => {
  const env = { DRIFTPROBE_TOKEN: 'abc' };
  assert.deepEqual(expandDeep({ a: '${DRIFTPROBE_TOKEN}', b: [{ c: 'x-${DRIFTPROBE_TOKEN}' }], d: 3 }, env), { a: 'abc', b: [{ c: 'x-abc' }], d: 3 });
  let received = '';
  const url = await listen(t, (req, res) => {
    req.on('data', (chunk) => (received += chunk));
    req.on('end', () => res.end('[]'));
  });
  await loadDocument({ type: 'http', url, body: { token: '${DRIFTPROBE_TOKEN}' } }, { env });
  assert.equal(JSON.parse(received).token, 'abc');
});

test('a redirect to another host is refused and never receives the headers', async (t) => {
  let leaked = false;
  const other = await listen(t, (req, res) => {
    leaked = req.headers['x-api-key'] !== undefined;
    res.end('[]');
  });
  const url = await listen(t, (req, res) => {
    res.writeHead(302, { location: `${other}/x` });
    res.end();
  });
  const source = { type: 'http', url, headers: { 'X-Api-Key': '${DRIFTPROBE_KEY}' } };
  await assert.rejects(loadDocument(source, { env: { DRIFTPROBE_KEY: 'secret' } }), (error) => error instanceof SourceError && /another host/.test(error.message));
  assert.equal(leaked, false);
});

test('a redirect on the same host is followed with its headers', async (t) => {
  const url = await listen(t, (req, res) => {
    if (req.url === '/old') {
      res.writeHead(302, { location: '/new' });
      return res.end();
    }
    return res.end(JSON.stringify([{ key: req.headers['x-api-key'] }]));
  });
  const doc = await loadDocument({ type: 'http', url: `${url}/old`, headers: { 'X-Api-Key': 'plain' } }, { env: {} });
  assert.deepEqual(doc, [{ key: 'plain' }]);
});

test('a redirect loop ends with a readable error', async (t) => {
  const url = await listen(t, (req, res) => {
    res.writeHead(302, { location: '/again' });
    res.end();
  });
  await assert.rejects(loadDocument({ type: 'http', url }, { env: {} }), (error) => error instanceof SourceError && /too many redirects/.test(error.message));
});

test('a response above the size limit is refused', async (t) => {
  const url = await listen(t, (req, res) => res.end(JSON.stringify(['x'.repeat(4096)])));
  await assert.rejects(loadDocument({ type: 'http', url }, { env: {}, maxResponseBytes: 1024 }), (error) => error instanceof SourceError && /too_large/.test(error.message));
});

test('a hostile contract name cannot emit workflow commands', () => {
  const name = 'x\n::stop-commands::abc\n::error::fake';
  const results = [{ name, report: { ok: false, itemCount: 1, violations: [{ message: 'field\n::error::fake' }] } }, { name: '::error::also fake', sourceError: 'nope\n::warning::fake' }];
  const lines = formatHuman(results).split('\n');
  assert.deepEqual(lines.filter((line) => line.trimStart().startsWith('::')), []);
});

test('annotation titles escape what would inject properties', () => {
  const out = formatGithub([{ name: 'a,file=README.md,line=1', sourceError: 'x' }]);
  assert.match(out, /title=driftprobe a%2Cfile=README\.md%2Cline=1::x/);
  assert.match(formatGithub([{ name: 'mcp:search', sourceError: 'x' }]), /title=driftprobe mcp%3Asearch::x/);
});

test('error messages cannot start a workflow command on a new line', () => {
  assert.equal(neutralizeCommands('bad\n::error::fake\n  ::warning::fake'), 'bad\n: :error::fake\n: :warning::fake');
});

test('a credential in the query never reaches the contract, whatever its name', () => {
  const warned = [];
  const text = withoutSecrets('https://a.test/p?q=shoes&page=2&jwt=abc&pwd=abc&session=abc&sid=abc&opaque=abc123def456ghi789jkl012', (name) => warned.push(name));
  for (const name of ['JWT', 'PWD', 'SESSION', 'SID', 'OPAQUE']) assert.ok(text.includes(`\${DRIFTPROBE_${name}}`), `${name} in ${text}`);
  assert.doesNotMatch(text, /abc123def/);
  assert.match(text, /q=shoes&page=2/);
  assert.equal(warned.length, 5);
});

test('a token in the path never reaches the contract, ordinary ids stay', () => {
  const warned = [];
  const text = withoutSecrets('https://a.test/bot123456:AAHabcdefghijklmnopqrstuvwxyz012/getUpdates', (name) => warned.push(name));
  assert.equal(text, 'https://a.test/${DRIFTPROBE_PATH_1}/getUpdates');
  assert.deepEqual(warned, ['DRIFTPROBE_PATH_1']);
  assert.equal(withoutSecrets('https://a.test/v1/shops/12345/products', () => {}), 'https://a.test/v1/shops/12345/products');
});

test('variables already written in a URL survive learning', () => {
  const text = withoutSecrets('https://a.test/${DRIFTPROBE_SHOP}/p?q=${DRIFTPROBE_Q}', () => {});
  assert.equal(text, 'https://a.test/${DRIFTPROBE_SHOP}/p?q=${DRIFTPROBE_Q}');
});

test('a credential passed as a tool argument never reaches the contract', () => {
  const warned = [];
  const args = { q: 'shoes', limit: 5, token: 'abc', nested: { password: 'abc', opaque: 'abc123def456ghi789jkl012' } };
  assert.deepEqual(withoutSecretArguments(args, (name) => warned.push(name)), {
    q: 'shoes',
    limit: 5,
    token: '${DRIFTPROBE_TOKEN}',
    nested: { password: '${DRIFTPROBE_PASSWORD}', opaque: '${DRIFTPROBE_OPAQUE}' },
  });
  assert.equal(warned.length, 3);
  assert.equal(args.token, 'abc');
});

test('learning from a very long observation log does not overflow the stack', () => {
  const profile = { itemsPath: '.', itemCount: 10, fields: { updated_at: freshField } };
  const contract = learnContract(Array.from({ length: 200_000 }, () => profile), { name: 'n', source: { type: 'file', path: 'x' } });
  assert.equal(contract.expect.min_items, 5);
});

test('the observation log is rotated instead of growing without limit', async (t) => {
  const url = await listen(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('[{"a":1}]');
  });
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const out = join(dir, 'observed.jsonl');
  const recorder = await startRecorder({ upstream: url, port: 0, out, maxObservedBytes: 10 });
  t.after(() => recorder.close());
  for (let call = 0; call < 3; call += 1) {
    await (await fetch(`http://127.0.0.1:${recorder.port}/p`)).text();
  }
  assert.ok(existsSync(`${out}.1`));
  assert.equal((await readFile(out, 'utf8')).trim().split('\n').length, 1);
});

test('the GitHub Action runs its own code, not whatever npm serves today', async () => {
  const action = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(action, /npx|@latest/);
  assert.match(action, /GITHUB_ACTION_PATH\/bin\/driftprobe\.mjs/);
  assert.match(action, /npm ci --omit=dev --ignore-scripts/);
});
