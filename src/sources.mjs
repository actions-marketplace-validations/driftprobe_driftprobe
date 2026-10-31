// Fetches what a contract points at. Secrets only ever come from the environment.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseDurationHours } from './contract.mjs';
import { profileDocument } from './profile.mjs';
import { classifyError, payloadFromToolResult, withMcpClient } from './mcp.mjs';
import { parseJsonLines } from './jsonl.mjs';
import { ENV_PREFIX } from './secrets.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METHOD_KEEPING_REDIRECTS = new Set([307, 308]);
const DEFAULT_MAX_SILENCE_HOURS = 24 * 7;
const HOUR_MS = 3_600_000;

export class SourceError extends Error {}

export function expandEnv(text, env = process.env) {
  return String(text).replace(/\$\{(\w+)\}/g, (_, name) => {
    // A contract may come from a clone or a pull request: it must not reach the other secrets of the machine.
    if (!name.startsWith(ENV_PREFIX)) throw new SourceError(`\${${name}} refused: a contract only reads variables starting with ${ENV_PREFIX}`);
    if (env[name] === undefined) throw new SourceError(`environment variable ${name} is not set`);
    return env[name];
  });
}

export function expandDeep(value, env = process.env) {
  if (typeof value === 'string') return expandEnv(value, env);
  if (Array.isArray(value)) return value.map((entry) => expandDeep(entry, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandDeep(entry, env)]));
  }
  return value;
}

function expandHeaders(headers, env) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key, expandEnv(value, env)]));
}

function limitSize(response, maxBytes) {
  if (!response.body) return response;
  let seen = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > maxBytes) controller.error(new Error('response too large'));
      else controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limiter), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// fetch alone would hand custom headers, which may hold a secret, to whatever host a redirect names.
async function fetchSameOrigin(url, init, maxBytes) {
  let current = new URL(url);
  let request = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, { ...request, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return limitSize(response, maxBytes);
    await response.body?.cancel();
    const next = new URL(response.headers.get('location') ?? '', current);
    if (next.origin !== current.origin) throw new SourceError(`the source redirected to another host (${next.host}): point the contract at it directly`);
    if (!METHOD_KEEPING_REDIRECTS.has(response.status)) request = { ...request, method: 'GET', body: undefined };
    current = next;
  }
  throw new SourceError('the source sent too many redirects');
}

async function loadHttp(source, { env, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES }) {
  const body = source.body === undefined ? undefined : typeof source.body === 'string' ? expandEnv(source.body, env) : JSON.stringify(expandDeep(source.body, env));
  const url = expandEnv(source.url, env);
  const init = { method: source.method ?? (body ? 'POST' : 'GET'), headers: expandHeaders(source.headers, env), body, signal: AbortSignal.timeout(timeoutMs) };
  let text;
  try {
    const response = await fetchSameOrigin(url, init, maxResponseBytes);
    if (!response.ok) throw new SourceError(`the source answered HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(`could not reach the source: ${classifyError(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('the source did not answer valid JSON');
  }
}

async function loadMcp(source, { env, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES }) {
  const fetchImpl = async (url, init) => limitSize(await fetch(url, { ...init, redirect: 'error' }), maxResponseBytes);
  const options = { url: expandEnv(source.url, env), transport: source.transport, headers: expandHeaders(source.headers, env), timeoutMs, fetchImpl };
  const args = expandDeep(source.arguments ?? {}, env);
  try {
    const result = await withMcpClient(options, (client) =>
      client.callTool({ name: source.tool, arguments: args }, undefined, { timeout: timeoutMs }),
    );
    if (result.isError) throw new SourceError(`tool ${source.tool} returned an error result`);
    return payloadFromToolResult(result).doc;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError(`could not call tool ${source.tool}: ${classifyError(error)}`);
  }
}

async function loadFile(source, { baseDir = process.cwd() }) {
  const path = isAbsolute(source.path) ? source.path : resolve(baseDir, source.path);
  const text = await readFile(path, 'utf8').catch((error) => {
    throw new SourceError(`could not read ${path}: ${error.code}`);
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError(`${path} is not valid JSON`);
  }
}

export async function loadDocument(source, options = {}) {
  const loaders = { http: loadHttp, mcp: loadMcp, file: loadFile };
  return loaders[source.type](source, options);
}

// The profile was measured when it was recorded: a date in it has aged since.
function withElapsedTime(profile, hours) {
  const fields = Object.entries(profile.fields ?? {}).map(([name, stats]) => [
    name,
    stats.ageHours === undefined ? stats : { ...stats, ageHours: Math.round((stats.ageHours + hours) * 10) / 10 },
  ]);
  return { ...profile, fields: Object.fromEntries(fields) };
}

const readableDelay = (hours) => (hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`);

async function latestObserved(source, { baseDir = process.cwd(), now = new Date() }) {
  const path = isAbsolute(source.path) ? source.path : resolve(baseDir, source.path);
  const text = await readFile(path, 'utf8').catch((error) => {
    throw new SourceError(`could not read ${path}: ${error.code}`);
  });
  const newest = parseJsonLines(text).rows.findLast((entry) => entry.key === source.key);
  if (!newest) throw new SourceError(`no observation for "${source.key}" in ${path}`);
  const silenceHours = (now.getTime() - Date.parse(newest.at)) / HOUR_MS;
  if (Number.isNaN(silenceHours)) throw new SourceError(`the last observation of "${source.key}" has no valid date`);
  const limit = source.max_silence === undefined ? DEFAULT_MAX_SILENCE_HOURS : parseDurationHours(source.max_silence, 'max_silence');
  if (silenceHours > limit) {
    throw new SourceError(`the last observation of "${source.key}" dates from ${readableDelay(silenceHours)} ago: is the proxy still running? Set source.max_silence to allow longer gaps`);
  }
  return withElapsedTime(newest.profile, Math.max(0, silenceHours));
}

export async function loadProfile(contract, options = {}) {
  if (contract.source.type === 'observed') return latestObserved(contract.source, options);
  const doc = await loadDocument(contract.source, options);
  return profileDocument(doc, { itemsPath: contract.items, now: options.now ?? new Date() });
}
