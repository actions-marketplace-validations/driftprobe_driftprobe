// Fetches what a contract points at. Secrets only ever come from the environment.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { profileDocument } from './profile.mjs';
import { classifyError, payloadFromToolResult, withMcpClient } from './mcp.mjs';
import { parseJsonLines } from './jsonl.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export class SourceError extends Error {}

export function expandEnv(text, env = process.env) {
  return String(text).replace(/\$\{(\w+)\}/g, (_, name) => {
    if (env[name] === undefined) throw new SourceError(`environment variable ${name} is not set`);
    return env[name];
  });
}

function expandHeaders(headers, env) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key, expandEnv(value, env)]));
}

async function loadHttp(source, { env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const body = source.body === undefined ? undefined : typeof source.body === 'string' ? expandEnv(source.body, env) : JSON.stringify(source.body);
  const url = expandEnv(source.url, env);
  const response = await fetch(url, {
    method: source.method ?? (body ? 'POST' : 'GET'),
    headers: expandHeaders(source.headers, env),
    body,
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    throw new SourceError(`could not reach the source: ${classifyError(error)}`);
  });
  if (!response.ok) throw new SourceError(`the source answered HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SourceError('the source did not answer valid JSON');
  }
}

async function loadMcp(source, { env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const options = { url: expandEnv(source.url, env), transport: source.transport, headers: expandHeaders(source.headers, env), timeoutMs };
  try {
    const result = await withMcpClient(options, (client) =>
      client.callTool({ name: source.tool, arguments: source.arguments ?? {} }, undefined, { timeout: timeoutMs }),
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

async function latestObserved(source, { baseDir = process.cwd() }) {
  const path = isAbsolute(source.path) ? source.path : resolve(baseDir, source.path);
  const text = await readFile(path, 'utf8').catch((error) => {
    throw new SourceError(`could not read ${path}: ${error.code}`);
  });
  const newest = parseJsonLines(text).rows.findLast((entry) => entry.key === source.key);
  if (newest) return newest.profile;
  throw new SourceError(`no observation for "${source.key}" in ${path}`);
}

export async function loadProfile(contract, options = {}) {
  if (contract.source.type === 'observed') return latestObserved(contract.source, options);
  const doc = await loadDocument(contract.source, options);
  return profileDocument(doc, { itemsPath: contract.items, now: options.now ?? new Date() });
}
