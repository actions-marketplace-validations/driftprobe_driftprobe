import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { expandEnv, loadDocument, loadProfile, SourceError } from '../src/sources.mjs';
import { payloadFromToolResult, classifyError, listAllTools, withMcpClient } from '../src/mcp.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('expands environment variables and refuses missing ones', () => {
  assert.equal(expandEnv('Bearer ${DRIFTPROBE_TOKEN}', { DRIFTPROBE_TOKEN: 'abc' }), 'Bearer abc');
  assert.throws(() => expandEnv('${DRIFTPROBE_NOPE}', {}), /DRIFTPROBE_NOPE/);
});

test('reads a local file relative to the contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  await writeFile(join(dir, 'a.json'), '{"results":[{"x":1}]}');
  assert.deepEqual(await loadDocument({ type: 'file', path: 'a.json' }, { baseDir: dir }), { results: [{ x: 1 }] });
});

test('http source sends expanded headers and returns JSON', async (t) => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end('[{"a":1}]');
  });
  t.after(() => server.close());
  const port = await listen(server);
  const doc = await loadDocument(
    { type: 'http', url: `http://127.0.0.1:${port}/x`, headers: { Authorization: 'Bearer ${DRIFTPROBE_T}' } },
    { env: { DRIFTPROBE_T: 'tok' } },
  );
  assert.deepEqual(doc, [{ a: 1 }]);
  assert.equal(seen, 'Bearer tok');
});

test('http source reports a failing status and invalid JSON as SourceError', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/down') {
      res.statusCode = 503;
      res.end('nope');
    } else res.end('<html>maintenance</html>');
  });
  t.after(() => server.close());
  const port = await listen(server);
  await assert.rejects(loadDocument({ type: 'http', url: `http://127.0.0.1:${port}/down` }, {}), (e) => e instanceof SourceError && /503/.test(e.message));
  await assert.rejects(loadDocument({ type: 'http', url: `http://127.0.0.1:${port}/html` }, {}), (e) => e instanceof SourceError && /JSON/.test(e.message));
});

test('unwraps tool results in the order agents read them', () => {
  assert.deepEqual(payloadFromToolResult({ structuredContent: { a: 1 }, content: [] }).doc, { a: 1 });
  assert.deepEqual(payloadFromToolResult({ content: [{ type: 'text', text: '[{"a":1}]' }] }).doc, [{ a: 1 }]);
  const text = payloadFromToolResult({ content: [{ type: 'text', text: 'plain answer' }] });
  assert.equal(text.format, 'text');
  assert.deepEqual(text.doc, [{ text: 'plain answer' }]);
  assert.equal(payloadFromToolResult({ content: [{ type: 'image', data: 'x' }] }).format, 'other');
});

test('classifies failures without keeping their text', () => {
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 401 })), 'auth');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 402 })), 'payment');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 429 })), 'rate_limited');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 404 })), 'gone');
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 502 })), 'server_error');
  assert.equal(classifyError(Object.assign(new Error('Request timed out'), { code: -32001 })), 'timeout');
  assert.equal(classifyError(new TypeError('fetch failed')), 'unreachable');
  assert.equal(classifyError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'EBLOCKED' }) })), 'blocked');
  assert.equal(classifyError(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })), 'redirect');
  assert.equal(classifyError(Object.assign(new Error('bad args'), { code: -32602 })), 'invalid_params');
  assert.equal(classifyError(new TypeError('x is not a function')), 'internal');
  assert.equal(classifyError(new Error('whatever')), 'protocol');
});

test('mcp source calls a real tool through the protocol', async (t) => {
  const server = http.createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'fake', version: '1.0.0' });
    mcp.registerTool('search', { inputSchema: { q: z.string() } }, async ({ q }) => ({
      content: [{ type: 'text', text: JSON.stringify({ results: [{ title: q, price: 3 }] }) }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  t.after(() => server.close());
  const port = await listen(server);
  const contract = {
    items: 'results',
    source: { type: 'mcp', url: `http://127.0.0.1:${port}/mcp`, tool: 'search', arguments: { q: randomUUID() } },
  };
  const profile = await loadProfile(contract, {});
  assert.equal(profile.itemCount, 1);
  assert.equal(profile.fields.price.usable, 1);
});

test('a hostile output schema cannot freeze the client', async (t) => {
  // Validated with a backtracking regex, this pattern and value would block the event loop for minutes.
  const tool = {
    name: 'search',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } },
  };
  const answers = {
    initialize: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hostile', version: '1' } },
    'tools/list': { tools: [tool] },
    'tools/call': { content: [], structuredContent: { a: `${'a'.repeat(60)}!` } },
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end();
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    return req.on('end', () => {
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.statusCode = 202;
        return res.end();
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answers[message.method] }));
    });
  });
  t.after(() => server.close());
  const port = await listen(server);
  const started = Date.now();
  const result = await withMcpClient({ url: `http://127.0.0.1:${port}/mcp`, timeoutMs: 5000 }, async (client) => {
    await listAllTools(client, 5000);
    return client.callTool({ name: 'search', arguments: {} }, undefined, { timeout: 5000 });
  });
  assert.equal(result.structuredContent.a.length, 61);
  assert.ok(Date.now() - started < 3000);
});

test('a connection that never completes is given up on', async (t) => {
  const server = http.createServer(() => {});
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = await listen(server);
  const started = Date.now();
  await assert.rejects(withMcpClient({ url: `http://127.0.0.1:${port}/sse`, transport: 'sse', timeoutMs: 200 }, async () => {}), (e) => classifyError(e) === 'timeout');
  assert.ok(Date.now() - started < 3000);
});

test('observed source survives a half written last line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const file = join(dir, 'observed.jsonl');
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), key: 'k', profile: { itemCount: 7, fields: {} } }) + '\n{"at":"b","key":"k","prof');
  assert.equal((await loadProfile({ source: { type: 'observed', path: file, key: 'k' } }, {})).itemCount, 7);
});

test('observed source returns the newest profile for its key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'driftprobe-'));
  const file = join(dir, 'observed.jsonl');
  const line = (at, key, itemCount) => JSON.stringify({ at, key, profile: { itemCount, fields: {} } });
  await writeFile(file, [line('2026-10-01', 'GET /a', 1), line('2026-10-02', 'GET /a', 2), line('2026-10-03', 'GET /b', 3)].join('\n') + '\n');
  const profile = await loadProfile({ source: { type: 'observed', path: file, key: 'GET /a' } }, { now: new Date('2026-10-04') });
  assert.equal(profile.itemCount, 2);
  await assert.rejects(loadProfile({ source: { type: 'observed', path: file, key: 'GET /zzz' } }, {}), SourceError);
});
