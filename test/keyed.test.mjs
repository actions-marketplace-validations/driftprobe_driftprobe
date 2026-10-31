import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, BASELINE_RUNS } from '../study/analyse.mjs';
import { buildRequest, observeKeyed, parseKeys } from '../study/keyed.mjs';
import { KEY_SOURCES } from '../study/keyed-sources.mjs';

const SECRET = 'sk-super-secret-value-123';
const NOW = new Date('2026-11-05T12:00:00Z');
const JSON_HEADERS = { 'content-type': 'application/json' };

const answer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const source = (overrides = {}) => ({ name: 'demo', variable: 'DRIFTPROBE_DEMO', url: 'https://api.example.com/items?q=a', itemsPath: 'results', keyHeader: 'X-Api-Key', ...overrides });
const observeWith = (fetchImpl, overrides) => observeKeyed(source(overrides), SECRET, { fetchImpl, now: NOW });

test('parseKeys keeps filled lines and ignores comments and empty values', () => {
  const keys = parseKeys('# a comment\nDRIFTPROBE_A=abc=def\r\nDRIFTPROBE_B=\n\nDRIFTPROBE_C= spaced \n');
  assert.deepEqual([...keys], [['DRIFTPROBE_A', 'abc=def'], ['DRIFTPROBE_C', 'spaced']]);
});

test('a key sent by header stays out of the url', () => {
  const { url, init } = buildRequest(source({ keyPrefix: 'Bearer ', keyHeader: 'Authorization' }), SECRET);
  assert.equal(url, 'https://api.example.com/items?q=a');
  assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(init.method, 'GET');
});

test('a key sent by query parameter is added to the existing query', () => {
  const { url, init } = buildRequest(source({ keyHeader: undefined, keyParam: 'api-key' }), SECRET);
  assert.equal(new URL(url).searchParams.get('api-key'), SECRET);
  assert.equal(new URL(url).searchParams.get('q'), 'a');
  assert.deepEqual(init.headers, { accept: 'application/json' });
});

test('a POST source sends its JSON body', () => {
  const { init } = buildRequest(source({ method: 'POST', body: { query: 'news' } }), SECRET);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, '{"query":"news"}');
  assert.equal(init.headers['content-type'], 'application/json');
});

test('a healthy answer gives the row analyse.mjs expects, with shapes only', async () => {
  const row = await observeWith(answer({ results: [{ title: 'private text', price: 3 }, { title: 'other text', price: 4 }] }));
  assert.equal(row.ok, true);
  assert.equal(row.server, 'demo');
  assert.equal(row.at, NOW.toISOString());
  assert.equal(row.profile.itemCount, 2);
  assert.ok(row.profile.fields.price);
  assert.ok(!JSON.stringify(row).includes('private text'));
});

test('the key never reaches the row, even when the server echoes it or the network error quotes the url', async () => {
  const echoed = await observeWith(answer({ results: [{ token: SECRET, price: 1 }] }));
  const failed = await observeWith(async (url) => { throw new Error(`connect failed for ${url}?api-key=${SECRET}`); });
  const refused = await observeWith(answer({ error: SECRET }, 401));
  for (const row of [echoed, failed, refused]) assert.ok(!JSON.stringify(row).includes(SECRET));
});

test('a refused key and a spent quota are not reported as outages of the provider', async () => {
  for (const status of [401, 403]) assert.equal((await observeWith(answer({}, status))).error, 'key_refused');
  for (const status of [402, 429]) assert.equal((await observeWith(answer({}, status))).error, 'quota');
});

test('a 400 is a refused key only when the provider says so: a renamed parameter stays visible', async () => {
  const badKey = await observeWith(answer({ error_message: 'The value for variable api_key is not registered.' }, 400));
  assert.equal(badKey.error, 'key_refused');
  assert.equal((await observeWith(answer({ errors: ['apikey parameter is invalid'] }, 400))).error, 'key_refused');
  const drift = await observeWith(answer({ error_message: 'Unknown parameter series_id' }, 400));
  assert.equal(drift.error, 'protocol');
  assert.ok(!JSON.stringify(badKey).includes('registered'));
});

test('a server failure and a page that is not JSON are outages', async () => {
  assert.equal((await observeWith(answer({}, 503))).error, 'server_error');
  const html = await observeWith(async () => new Response('<html>maintenance</html>', { status: 200 }));
  assert.equal(html.ok, false);
  assert.equal(html.error, 'not_json');
});

test('200 OK without the list is data, and the contract is the one to judge it', async () => {
  const row = await observeWith(answer({ Information: 'rate limit reached' }));
  assert.equal(row.ok, true);
  assert.equal(row.profile.itemsMissing, true);
});

test('every source is complete and sends its key one way only', () => {
  const names = new Set(KEY_SOURCES.map((entry) => entry.name));
  const variables = new Set(KEY_SOURCES.map((entry) => entry.variable));
  assert.equal(names.size, KEY_SOURCES.length);
  assert.equal(variables.size, KEY_SOURCES.length);
  for (const entry of KEY_SOURCES) {
    assert.match(entry.variable, /^DRIFTPROBE_[A-Z0-9_]+$/, entry.name);
    assert.ok(entry.url.startsWith('https://'), entry.name);
    assert.ok(entry.itemsPath, entry.name);
    assert.ok(Boolean(entry.keyHeader) !== Boolean(entry.keyParam), entry.name);
    assert.ok(entry.signup.startsWith('https://') && entry.keyPage.startsWith('https://'), entry.name);
  }
});

test('analyse sets aside refused keys and spent quotas, and counts them', () => {
  const at = (hours) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
  const profile = { itemsPath: 'results', itemCount: 2, fields: { price: { present: 2, types: { number: 2 }, distinct: 2 } } };
  const round = (hours) => ['a', 'b', 'c'].map((server) => ({ at: at(hours), server, ok: true, profile }));
  const healthy = Array.from({ length: BASELINE_RUNS }, (_, index) => round(index * 12)).flat();
  const [refused, ...rest] = round(100);
  const [quota, ...others] = round(112);
  const result = analyse([
    ...healthy,
    { ...refused, ok: false, stage: 'http', error: 'key_refused' },
    ...rest,
    { ...quota, ok: false, stage: 'http', error: 'quota' },
    ...others,
  ]);
  assert.equal(result.excludedRounds, 0);
  assert.equal(result.excludedRows, 2);
  assert.equal(result.withOutage, 0);
  assert.deepEqual(result.accountFaults, { a: 2 });
});

test('half the keys refused does not throw away the sources that answered', () => {
  const at = (hours) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
  const profile = { itemsPath: 'results', itemCount: 2, fields: { price: { present: 2, types: { number: 2 }, distinct: 2 } } };
  const rows = Array.from({ length: BASELINE_RUNS + 2 }, (_, index) => [
    { at: at(index * 12), server: 'answers', ok: true, profile },
    { at: at(index * 12), server: 'refused', ok: false, stage: 'http', error: 'key_refused' },
  ]).flat();
  const result = analyse(rows);
  assert.equal(result.excludedRounds, 0);
  assert.equal(result.withBaseline, 1);
  assert.equal(result.accountFaults.refused, BASELINE_RUNS + 2);
});

test('a round where most sources really fail is still blamed on our connection', () => {
  const at = new Date(NOW).toISOString();
  const rows = [
    { at, server: 'a', ok: false, stage: 'fetch', error: 'timeout' },
    { at, server: 'b', ok: false, stage: 'fetch', error: 'timeout' },
    { at, server: 'c', ok: false, stage: 'http', error: 'key_refused' },
    { at, server: 'd', ok: true, profile: { itemCount: 1, fields: {} } },
  ];
  assert.equal(analyse(rows).excludedRounds, 1);
});
