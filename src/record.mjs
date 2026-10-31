// A local reverse proxy placed between an agent and a source. It forwards everything untouched
// and writes down the shape of each response: this is how a contract is learned from real calls.
import http from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { profileDocument } from './profile.mjs';
import { classifyError, payloadFromToolResult } from './mcp.mjs';
import { TOKEN_PREFIX_RE } from './secrets.mjs';

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_OBSERVED_BYTES = 50 * 1024 * 1024;
// Only segments that read as route names survive: an id or a token in a URL must not become a contract name.
const ROUTE_WORD_RE = /^(?:[a-z][a-z_-]{0,19}|v\d+(?:\.\d+)?)$/i;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'trailer', 'host', 'content-length']);
// fetch has already decoded the body, so its original encoding headers no longer apply.
const DROP_FROM_RESPONSE = new Set([...HOP_BY_HOP, 'content-encoding', 'set-cookie']);

const isRouteWord = (segment) => ROUTE_WORD_RE.test(segment) && !TOKEN_PREFIX_RE.test(segment);

export function normalisePath(path) {
  return path.split('/').map((segment) => (segment === '' || isRouteWord(segment) ? segment : ':id')).join('/');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Groups calls: one contract per tool or per route. Returns null for traffic worth no contract. */
export function keyForRequest(method, url, body) {
  const path = new URL(url, 'http://local').pathname;
  const rpc = method === 'POST' ? parseJson(body) : undefined;
  if (rpc?.jsonrpc || rpc?.method) return rpc.method === 'tools/call' && rpc.params?.name ? `mcp:${rpc.params.name}` : null;
  return `${method} ${normalisePath(path)}`;
}

function lastEventData(text) {
  const events = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
  return events.length ? parseJson(events[events.length - 1].slice(5).trim()) : undefined;
}

function documentFromResponse(key, contentType, text) {
  const body = contentType.includes('text/event-stream') ? lastEventData(text) : contentType.includes('json') ? parseJson(text) : undefined;
  if (body === undefined) return undefined;
  if (!key.startsWith('mcp:')) return body;
  return body.result ? payloadFromToolResult(body.result).doc : undefined;
}

/** Whatever the request line says, the target stays the configured upstream. */
export function targetUrl(upstream, requestUrl) {
  const target = new URL(upstream);
  const { pathname, search } = new URL(requestUrl.replace(/^\/+/, '/'), 'http://local');
  target.pathname = `${target.pathname.replace(/\/$/, '')}${pathname}`;
  target.search = search;
  return target;
}

// The proxy holds the agent's credentials: a web page reaching it through DNS rebinding must get nothing.
function isLocalRequest(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return false;
  if (!req.headers.origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(req.headers.origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function forward(upstream, req, body, signal) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
  return fetch(targetUrl(upstream, req.url), {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
    redirect: 'manual',
    signal,
  });
}

async function relay(response, res) {
  const chunks = [];
  let captured = 0;
  for await (const chunk of response.body ?? []) {
    if (!res.write(chunk)) await once(res, 'drain');
    if (captured < MAX_CAPTURE_BYTES) chunks.push(chunk);
    captured += chunk.length;
  }
  return captured <= MAX_CAPTURE_BYTES ? Buffer.concat(chunks).toString('utf8') : null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function writeResponseHead(response, res) {
  const headers = Object.fromEntries([...response.headers].filter(([name]) => !DROP_FROM_RESPONSE.has(name)));
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
}

function refuse(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// Keeps one previous generation, so that a proxy left running cannot fill the disk.
async function appendObservation(out, line, maxBytes) {
  const size = await stat(out).then((stats) => stats.size, () => 0);
  if (size >= maxBytes) {
    await rename(out, `${out}.1`).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  await appendFile(out, line);
}

async function recordShape({ req, body, response, text, out, maxObservedBytes }) {
  const key = keyForRequest(req.method, req.url, body.toString('utf8'));
  if (!key || text === null || !response.ok) return;
  const doc = documentFromResponse(key, response.headers.get('content-type') ?? '', text);
  if (doc === undefined) return;
  await appendObservation(out, `${JSON.stringify({ at: new Date().toISOString(), key, profile: profileDocument(doc) })}\n`, maxObservedBytes);
}

async function handle({ upstream, out, onError, maxObservedBytes }, req, res) {
  if (!isLocalRequest(req)) return refuse(res, 403, 'driftprobe only answers local requests');
  const body = await readBody(req);
  const abort = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  let response;
  try {
    response = await forward(upstream, req, body, abort.signal);
  } catch (error) {
    onError(new Error(`could not reach the upstream: ${classifyError(error)}`));
    return refuse(res, 502, 'driftprobe could not reach the upstream');
  }
  writeResponseHead(response, res);
  let text;
  try {
    text = await relay(response, res);
  } catch (error) {
    // Ending cleanly would hand the agent truncated JSON that looks complete.
    if (!abort.signal.aborted) onError(new Error(`upstream failed mid response: ${classifyError(error)}`));
    res.destroy();
    return undefined;
  }
  // Written before the response ends: once the agent has its answer, the observation exists.
  await recordShape({ req, body, response, text, out, maxObservedBytes }).catch(onError);
  res.end();
  return undefined;
}

/** Listens on loopback only: the proxy sees the agent's credentials and must not be reachable from outside. */
export async function startRecorder({ upstream, port = 8787, out, maxObservedBytes = MAX_OBSERVED_BYTES, onError = (error) => console.error(`driftprobe: ${error.message}`) }) {
  await mkdir(dirname(out), { recursive: true });
  const server = http.createServer((req, res) => {
    handle({ upstream, out, onError, maxObservedBytes }, req, res).catch((error) => {
      onError(error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}
