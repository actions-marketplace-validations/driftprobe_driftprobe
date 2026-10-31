import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRecorder, keyForRequest, normalisePath, targetUrl } from '../src/record.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function setup(t, handler) {
  const upstream = http.createServer(handler);
  t.after(() => upstream.close());
  const port = await listen(upstream);
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const file = join(dir, 'observed.jsonl');
  const recorder = await startRecorder({ upstream: `http://127.0.0.1:${port}`, port: 0, out: file });
  t.after(() => recorder.close());
  return { base: `http://127.0.0.1:${recorder.port}`, file };
}

const readLines = async (file) => (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

test('collapses identifiers in paths', () => {
  assert.equal(normalisePath('/users/42/orders/9f8a7b6c-1d2e-4f3a-8b9c-0d1e2f3a4b5c'), '/users/:id/orders/:id');
  assert.equal(normalisePath('/v1/products'), '/v1/products');
});

test('secrets in paths never become a contract name', () => {
  const paths = ['/bot123:AAHabc/getUpdates', '/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX', '/sk_live_abcdef/charges', '/jean.dupont/orders'];
  const stored = paths.map(normalisePath).join(' ');
  for (const leak of ['123', 'AAH', 'T000', 'XXXX', 'live', 'jean']) assert.ok(!stored.includes(leak), stored);
});

test('the request line can never change the target host, and an upstream prefix is kept', () => {
  for (const url of ['//evil.example/x', 'http://evil.example/x', '/x']) {
    assert.equal(targetUrl('https://api.example/base', url).host, 'api.example');
  }
  assert.equal(targetUrl('https://api.example/base', '/x').href, 'https://api.example/base/x');
  assert.equal(targetUrl('https://api.example/', '/x?a=1').href, 'https://api.example/x?a=1');
});

test('names MCP tool calls after the tool', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { q: 'x' } } });
  assert.equal(keyForRequest('POST', '/mcp', body), 'mcp:search');
  assert.equal(keyForRequest('POST', '/mcp', '{"method":"tools/list"}'), null);
  assert.equal(keyForRequest('GET', '/v1/items/12?token=abc', ''), 'GET /v1/items/:id');
});

test('passes the response through untouched and stores only its shape', async (t) => {
  const { base, file } = await setup(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-upstream', 'yes');
    res.end(JSON.stringify({ results: [{ email: 'secret.person@example.com', price: 12 }] }));
  });
  const response = await fetch(`${base}/v1/items?q=private-query`, { headers: { authorization: 'Bearer private-token' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-upstream'), 'yes');
  assert.deepEqual((await response.json()).results[0].price, 12);
  const [line] = await readLines(file);
  assert.equal(line.key, 'GET /v1/items');
  assert.equal(line.profile.itemCount, 1);
  const stored = JSON.stringify(line);
  for (const leak of ['secret.person', 'private-query', 'private-token']) assert.ok(!stored.includes(leak), leak);
});

test('forwards method, body and authorization to the upstream', async (t) => {
  const seen = {};
  const { base } = await setup(t, (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      Object.assign(seen, { method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
  });
  await fetch(`${base}/x?a=1`, { method: 'POST', headers: { authorization: 'Bearer t' }, body: 'hello' });
  assert.deepEqual(seen, { method: 'POST', url: '/x?a=1', auth: 'Bearer t', body: 'hello' });
});

test('profiles MCP tool results, including server-sent events', async (t) => {
  const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"results":[{"price":1},{"price":2}]}' }] } };
  const { base, file } = await setup(t, (req, res) => {
    req.resume();
    res.setHeader('content-type', 'text/event-stream');
    res.end(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`);
  });
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } };
  const response = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify(call) });
  assert.match(await response.text(), /event: message/);
  const [line] = await readLines(file);
  assert.equal(line.key, 'mcp:search');
  assert.equal(line.profile.itemCount, 2);
  assert.equal(line.profile.fields.price.usable, 2);
});

test('records nothing for non JSON responses and keeps serving', async (t) => {
  const { base, file } = await setup(t, (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html></html>');
  });
  assert.equal(await (await fetch(`${base}/page`)).text(), '<html></html>');
  await assert.rejects(readFile(file, 'utf8'));
});

test('refuses requests that do not come from this machine', async (t) => {
  const { base } = await setup(t, (req, res) => res.end('{}'));
  const { port } = new URL(base);
  const status = (headers) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/x', headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  assert.equal(await status({ host: 'attacker.example' }), 403);
  assert.equal(await status({ host: '127.0.0.1:' + port, origin: 'https://attacker.example' }), 403);
  assert.equal(await status({ host: '127.0.0.1:' + port }), 200);
});

test('keeps every Set-Cookie header', async (t) => {
  const { base } = await setup(t, (req, res) => {
    res.setHeader('set-cookie', ['a=1', 'b=2', 'c=3']);
    res.end('{}');
  });
  assert.deepEqual((await fetch(base + '/x')).headers.getSetCookie(), ['a=1', 'b=2', 'c=3']);
});

test('an upstream failing mid response is not handed over as a complete answer', async (t) => {
  const { base } = await setup(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.write('{"results":[');
    setTimeout(() => res.destroy(), 20);
  });
  await assert.rejects(async () => (await fetch(base + '/x')).text());
});

test('answers 502 when the upstream is down', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const recorder = await startRecorder({ upstream: 'http://127.0.0.1:9', port: 0, out: join(dir, 'o.jsonl'), onError: () => {} });
  t.after(() => recorder.close());
  assert.equal((await fetch(`http://127.0.0.1:${recorder.port}/x`)).status, 502);
});
