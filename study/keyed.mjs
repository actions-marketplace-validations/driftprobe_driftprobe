// One observation of one API that needs a key. Same row format as observe.mjs, so that analyse.mjs reads both.
// The key is only ever placed in the outgoing request: a row holds shapes and short error codes, nothing else.
import { classifyError } from '../src/mcp.mjs';
import { profileDocument } from '../src/profile.mjs';
import { studyFetch, TIMEOUT_MS } from './observe.mjs';

// Those say something about our key or our quota, never about what the provider delivers.
const ACCOUNT_ERRORS = { 401: 'key_refused', 403: 'key_refused', 402: 'quota', 429: 'quota' };
// Some providers answer 400 to a bad key. Any other 400 may be the drift being measured: the body decides, and is not kept.
const NAMES_THE_KEY = /api[_ -]?key/i;

async function httpError(response) {
  if (ACCOUNT_ERRORS[response.status]) return ACCOUNT_ERRORS[response.status];
  if (response.status === 400 && NAMES_THE_KEY.test(await response.text())) return 'key_refused';
  return classifyError({ code: response.status });
}

export function parseKeys(text) {
  const keys = new Map();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (line.startsWith('#') || separator < 1) continue;
    const value = line.slice(separator + 1).trim();
    if (value) keys.set(line.slice(0, separator).trim(), value);
  }
  return keys;
}

export function buildRequest(source, key) {
  const url = new URL(source.url);
  if (source.keyParam) url.searchParams.set(source.keyParam, key);
  const headers = { accept: 'application/json', ...source.headers };
  if (source.keyHeader) headers[source.keyHeader] = `${source.keyPrefix ?? ''}${key}`;
  const init = { method: source.method ?? 'GET', headers };
  if (source.body) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(source.body);
  }
  return { url: url.href, init };
}

async function readJson(response) {
  try {
    return { doc: await response.json() };
  } catch (error) {
    if (error instanceof SyntaxError) return { notJson: true };
    throw error;
  }
}

export async function observeKeyed(source, key, { fetchImpl = studyFetch, now = new Date(), digestKey, timeoutMs = TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const base = { at: now.toISOString(), server: source.name };
  const failure = (stage, error) => ({ ...base, ok: false, stage, error, ms: Date.now() - startedAt });
  const { url, init } = buildRequest(source, key);
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return failure('http', await httpError(response));
    const { doc, notJson } = await readJson(response);
    if (notJson) return failure('parse', 'not_json');
    const profile = profileDocument(doc, { itemsPath: source.itemsPath, now, digestKey });
    return { ...base, ok: true, stage: 'done', ms: Date.now() - startedAt, profile };
  } catch (error) {
    return failure('fetch', classifyError(error));
  }
}
