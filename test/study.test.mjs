import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, isPublicHttpsUrl, isPublicUrlShape, isSafeTool, buildArguments, usableRemote, guardedLookup } from '../study/safety.mjs';
import { analyse, BASELINE_RUNS } from '../study/analyse.mjs';
import { catalogueHash, planCall, studyFetch } from '../study/observe.mjs';
import { runIsolated, mapPool } from '../study/isolated.mjs';
import { profileDocument } from '../src/profile.mjs';

test('recognises private and local addresses, in every IPv6 disguise', () => {
  const blocked = [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fc00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', 'not-an-ip',
  ];
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(isPrivateIp(ip), false, ip);
});

test('only public https endpoints are probed', async () => {
  const publicDns = async () => [{ address: '8.8.8.8' }];
  const privateDns = async () => [{ address: '192.168.1.10' }];
  assert.equal(await isPublicHttpsUrl('https://example.com/mcp', publicDns), true);
  assert.equal(await isPublicHttpsUrl('http://example.com/mcp', publicDns), false);
  assert.equal(await isPublicHttpsUrl('https://rebind.example.com/mcp', privateDns), false);
  assert.equal(await isPublicHttpsUrl('https://127.0.0.1:8130/', publicDns), false);
  assert.equal(await isPublicHttpsUrl('https://[::ffff:7f00:1]/', publicDns), false);
  assert.equal(await isPublicHttpsUrl('https://localhost/mcp', publicDns), false);
  assert.equal(await isPublicHttpsUrl('not a url', publicDns), false);
  assert.equal(await isPublicHttpsUrl('https://gone.example.com', async () => { throw new Error('ENOTFOUND'); }), false);
});

test('unusual ports and embedded credentials are refused', () => {
  assert.equal(isPublicUrlShape('https://example.com:22/'), false);
  assert.equal(isPublicUrlShape('https://example.com:8443/'), true);
  assert.equal(isPublicUrlShape('https://a:b@example.com/'), false);
});

test('every connection is checked, so that DNS rebinding finds a closed door', async () => {
  const lookupVia = (addresses, options = {}) =>
    new Promise((resolve) => guardedLookup('x.example', options, (...result) => resolve(result), (_, __, callback) => callback(null, addresses)));
  const [error] = await lookupVia([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  assert.equal(error.code, 'EBLOCKED');
  assert.deepEqual(await lookupVia([{ address: '8.8.8.8', family: 4 }]), [null, '8.8.8.8', 4]);
  assert.deepEqual(await lookupVia([{ address: '8.8.8.8', family: 4 }], { all: true }), [null, [{ address: '8.8.8.8', family: 4 }]]);
});

test('the study fetch refuses private targets before any network access', async () => {
  await assert.rejects(studyFetch('http://example.com/'), (e) => e.code === 'EBLOCKED');
  await assert.rejects(studyFetch('https://127.0.0.1/'), (e) => e.code === 'EBLOCKED');
});

const readOnly = (name, extra = {}) => ({ name, annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} }, ...extra });

test('a tool is called only if it declares itself read only and is named like a read', () => {
  for (const name of ['search_papers', 'getWeather', 'list-stations', 'fetch.prices']) assert.equal(isSafeTool(readOnly(name)), true, name);
  assert.equal(isSafeTool({ name: 'search_papers', inputSchema: {} }), false);
  assert.equal(isSafeTool(readOnly('search', { annotations: { readOnlyHint: true, destructiveHint: true } })), false);
});

test('a read only label does not excuse a name that acts', () => {
  const names = [
    'delete_item', 'send_email', 'sendMessage', 'createIssue', 'issues.create', 'book_flight', 'trigger_build', 'clear_cache', 'merge_pull_request',
    'restart_server', 'invite_member', 'create_order', 'pay_invoice', 'run_code', 'weather_forecast',
    'get_api_key', 'generate_image', 'list_users', 'get_user_profile', 'getUserProfile', 'search_and_send',
  ];
  for (const name of names) assert.equal(isSafeTool(readOnly(name)), false, name);
});

const schema = (properties, required) => ({ inputSchema: { type: 'object', properties, required } });

test('builds arguments only from neutral, known parameters', () => {
  assert.deepEqual(buildArguments(schema({ query: { type: 'string' } }, ['query'])), { query: 'coffee' });
  assert.deepEqual(buildArguments(schema({ city: { type: 'string' } }, ['city'])), { city: 'Paris' });
  assert.deepEqual(buildArguments(schema({ unit: { type: 'string', enum: ['c', 'f'] } }, ['unit'])), { unit: 'c' });
  assert.deepEqual(buildArguments(schema({ n: { type: 'integer', default: 7 } }, ['n'])), { n: 7 });
  assert.deepEqual(buildArguments(schema({ limit: { type: 'integer' } }, [])), { limit: 20 });
  assert.deepEqual(buildArguments(schema({ other: { type: 'string' } }, [])), {});
  assert.deepEqual(buildArguments({}), {});
});

test('refuses to invent a value it cannot justify', () => {
  assert.equal(buildArguments(schema({ url: { type: 'string' } }, ['url'])), null);
  assert.equal(buildArguments(schema({ user_id: { type: 'string' } }, ['user_id'])), null);
  assert.equal(buildArguments(schema({ filter: { type: 'object' } }, ['filter'])), null);
  assert.equal(buildArguments(schema({ email: { type: 'string', default: 'a@b.c' } }, ['email'])), null);
  assert.equal(buildArguments(schema({ dry_run: { type: 'boolean' } }, ['dry_run'])), null);
  assert.equal(buildArguments(schema({ flag: { type: 'boolean' } }, ['flag'])), null);
  assert.equal(buildArguments(schema({ source: { type: 'string', default: 'https://evil.example' } }, ['source'])), null);
});

test('keeps remote endpoints usable without credentials', () => {
  const ok = { type: 'streamable-http', url: 'https://a.example/mcp' };
  assert.deepEqual(usableRemote({ remotes: [ok] }), ok);
  assert.equal(usableRemote({ remotes: [{ ...ok, headers: [{ name: 'X-Key', isRequired: true }] }] }), null);
  assert.equal(usableRemote({ remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example/mcp' }] }), null);
  assert.equal(usableRemote({ packages: [{}] }), null);
  const sse = { type: 'sse', url: 'https://b.example/sse' };
  assert.deepEqual(usableRemote({ remotes: [sse, ok] }), ok);
});

test('the safety policy is applied again on every round', () => {
  const entry = { tool: 'search_papers', args: { query: 'coffee' } };
  const tool = readOnly('search_papers', { inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } });
  assert.deepEqual(planCall([tool], entry), { args: { query: 'coffee' }, argsChanged: false });
  assert.equal(planCall([], entry).skip, 'tool_gone');
  assert.equal(planCall([{ ...tool, annotations: { readOnlyHint: false } }], entry).skip, 'tool_no_longer_safe');
  const newlyRequired = { ...tool, inputSchema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] } };
  assert.equal(planCall([newlyRequired], entry).skip, 'arguments_no_longer_known');
});

test('the catalogue hash ignores key order and tool order', () => {
  const a = { name: 'a', inputSchema: { type: 'object', properties: { x: { type: 'string', title: 't' } } } };
  const reordered = { inputSchema: { properties: { x: { title: 't', type: 'string' } }, type: 'object' }, name: 'a' };
  const b = { name: 'b', inputSchema: {} };
  assert.equal(catalogueHash([a, b]), catalogueHash([b, reordered]));
  assert.notEqual(catalogueHash([a]), catalogueHash([b]));
});

test('a frozen worker is killed from outside', async () => {
  const frozen = new URL('data:text/javascript,while(true){}');
  const started = Date.now();
  assert.deepEqual(await runIsolated('none', {}, 300, frozen), { isolationFailure: 'hard_timeout' });
  assert.ok(Date.now() - started < 5000);
});

test('a crashing worker is reported, not thrown', async () => {
  const crashing = new URL('data:text/javascript,throw new Error("boom")');
  assert.deepEqual(await runIsolated('none', {}, 5000, crashing), { isolationFailure: 'worker_crash' });
});

test('mapPool reports each result as soon as it is ready', async () => {
  const seen = [];
  const results = await mapPool([1, 2, 3], 2, async (n) => n * 2, async (r) => seen.push(r));
  assert.deepEqual(results, [2, 4, 6]);
  assert.deepEqual(seen.sort(), [2, 4, 6]);
});

const profile = (itemCount, priceUsable, digest = 'd') => ({
  itemsPath: 'results',
  itemCount,
  digest,
  fields: { price: { usable: priceUsable, kinds: { number: priceUsable, null: itemCount - priceUsable }, distinct: priceUsable } },
});
const dayOf = (index) => new Date(Date.UTC(2026, 10, 1 + index, 12)).toISOString();
const obs = (server, index, fields) => ({ at: dayOf(index), server, ok: true, stage: 'done', format: 'json', toolsHash: 'h', ...fields });
const healthyRuns = (server, count = BASELINE_RUNS) => Array.from({ length: count }, (_, i) => obs(server, i, { profile: profile(100, 100, `${server}${i}`) }));

test('tells outages apart from sustained contract breaks', () => {
  const last = BASELINE_RUNS;
  const rows = [
    ...healthyRuns('healthy', BASELINE_RUNS + 2),
    ...healthyRuns('silent'),
    obs('silent', last, { profile: profile(100, 15, 'x1') }),
    obs('silent', last + 1, { profile: profile(100, 15, 'x2') }),
    ...healthyRuns('blip'),
    obs('blip', last, { profile: profile(100, 15, 'y1') }),
    obs('blip', last + 1, { profile: profile(100, 100, 'y2') }),
    ...healthyRuns('down'),
    { at: dayOf(last), server: 'down', ok: false, stage: 'connect', error: 'timeout' },
  ];
  const result = analyse(rows);
  assert.equal(result.servers, 4);
  assert.equal(result.withSilentBreak, 1);
  assert.equal(result.withOutage, 1);
  const silent = result.details.find((d) => d.server === 'silent');
  assert.equal(silent.silentBreaks, 1);
  assert.equal(silent.outages, 0);
  assert.equal(silent.examples[0].rule, 'min_coverage');
  assert.equal(silent.examples[0].field, 'price');
  const blip = result.details.find((d) => d.server === 'blip');
  assert.equal(blip.silentBreaks, 0);
  assert.equal(blip.transientBreaks, 1);
  assert.equal(result.details.find((d) => d.server === 'down').silentBreaks, 0);
});

test('a round where the whole panel failed says our connection was down', () => {
  const rows = [...healthyRuns('a'), ...healthyRuns('b'), ...['a', 'b'].map((server) => ({ at: dayOf(BASELINE_RUNS), server, ok: false, stage: 'connect', error: 'unreachable' }))];
  const result = analyse(rows);
  assert.equal(result.withOutage, 0);
  assert.equal(result.excludedRounds, 1);
});

test('our own failures are never counted against a server', () => {
  const rows = [...healthyRuns('a'), ...healthyRuns('b'), ...healthyRuns('c'), { at: dayOf(0), server: 'a', ok: false, stage: 'worker', error: 'internal' }];
  assert.equal(analyse(rows).withOutage, 0);
});

test('counts tool errors and catalogue changes separately', () => {
  const rows = [
    ...healthyRuns('s'),
    ...healthyRuns('t', BASELINE_RUNS + 2),
    obs('s', BASELINE_RUNS, { toolError: true }),
    obs('s', BASELINE_RUNS + 1, { toolsHash: 'changed', profile: profile(100, 100, 'x5') }),
  ];
  const detail = analyse(rows).details.find((d) => d.server === 's');
  assert.equal(detail.toolErrors, 1);
  assert.equal(detail.catalogueChanges, 1);
});

test('notices a feed that serves the exact same data for days', () => {
  const rows = Array.from({ length: 6 }, (_, i) => obs('frozen', i, { profile: profile(10, 10, 'same') }));
  assert.equal(analyse(rows).details[0].unchangedRuns, 5);
});

test('a server with too little history is not judged', () => {
  const [detail] = analyse([obs('new', 0, { profile: profile(10, 10) })]).details;
  assert.equal(detail.baselineReady, false);
  assert.equal(detail.silentBreaks, 0);
});

// The method itself: simulate servers where nothing ever changes, and servers that really break.

function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROUNDS = 60;
const STEP_MS = 12 * 3_600_000;
const START = Date.UTC(2026, 10, 1);
const ISO = (ms) => new Date(ms).toISOString();

// A date column with a realistic life: refreshed every few hours, every week, or never.
function dateFor(kind, nowMs, random) {
  if (kind === 'hourly') return ISO(nowMs - random() * 6 * 3_600_000);
  if (kind === 'weekly') return ISO(nowMs - (nowMs - START) % (7 * 24 * 3_600_000));
  return ISO(START - 10 * 24 * 3_600_000);
}

function simulateServer(index, random, { breakAt } = {}) {
  const items = [20, 50, 200][index % 3];
  const coverage = [0.6, 0.8, 0.95, 1][index % 4];
  const dateKind = ['hourly', 'weekly', 'static'][index % 3];
  return Array.from({ length: ROUNDS }, (_, round) => {
    const nowMs = START + round * STEP_MS;
    const broken = breakAt !== undefined && round >= breakAt;
    const doc = Array.from({ length: items }, (_, i) => ({
      id: Math.floor(random() * 1e9),
      price: !broken && random() < coverage ? Math.floor(random() * 500) : null,
      updated_at: dateFor(dateKind, nowMs, random),
      seen: i,
    }));
    return { at: ISO(nowMs), server: `s${index}`, ok: true, stage: 'done', format: 'json', toolsHash: 'h', profile: profileDocument(doc, { now: new Date(nowMs), digestKey: 'k' }) };
  });
}

test('false alarms: 300 servers where nothing changes stay under 2% flagged', () => {
  const random = seededRandom(1);
  const rows = Array.from({ length: 300 }, (_, index) => simulateServer(index, random)).flat();
  const result = analyse(rows);
  assert.equal(result.withBaseline, 300);
  assert.ok(result.withSilentBreak <= 6, `${result.withSilentBreak} flagged: ${JSON.stringify(result.details.find((d) => d.silentBreaks)?.examples[0])}`);
});

test('sensitivity: servers whose prices really vanish are caught', () => {
  const random = seededRandom(2);
  const rows = Array.from({ length: 60 }, (_, index) => simulateServer(index, random, { breakAt: 40 })).flat();
  const result = analyse(rows);
  assert.ok(result.withSilentBreak >= 57, `${result.withSilentBreak} of 60 caught`);
});
