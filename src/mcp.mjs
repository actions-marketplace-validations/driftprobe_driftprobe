// Thin wrapper over the official MCP client: one call per connection, no retries.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export const CLIENT_INFO = { name: 'driftprobe', version: '0.1.0' };
const REQUEST_TIMEOUT_CODE = -32001;
const INVALID_PARAMS_CODE = -32602;
const MAX_TOOL_PAGES = 5;
const NETWORK_CODE_RE = /^(?:E[A-Z]+|UND_ERR_\w+|CERT_\w+|\w*_CERT_\w*|ERR_TLS_\w+|ERR_SSL_\w+)$/;

// The client would otherwise compile server supplied JSON schemas: a hostile pattern can freeze
// the event loop. Conformance to the tool's schema is not what a contract tests anyway.
const noValidation = { getValidator: () => (input) => ({ valid: true, data: input, errorMessage: undefined }) };

function createTransport({ url, transport, headers, fetchImpl }) {
  const options = { requestInit: { headers: headers ?? {} } };
  if (fetchImpl) options.fetch = fetchImpl;
  const Transport = transport === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
  return new Transport(new URL(url), options);
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function withMcpClient({ url, transport, headers, fetchImpl, timeoutMs = 20_000 }, run) {
  const client = new Client(CLIENT_INFO, { jsonSchemaValidator: noValidation });
  try {
    // connect() does not enforce its timeout on every transport.
    await withDeadline(client.connect(createTransport({ url, transport, headers, fetchImpl }), { timeout: timeoutMs }), timeoutMs);
    return await run(client);
  } finally {
    // Also stops SSE reconnection attempts after a failed connect. A failed goodbye changes nothing.
    await client.close().catch(() => {});
  }
}

export async function listAllTools(client, timeoutMs) {
  const tools = [];
  let cursor;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function tryParse(text) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Reads a tool result the way an agent would: structured content first, then JSON in text blocks. */
export function payloadFromToolResult(result) {
  if (result.structuredContent) return { format: 'json', doc: result.structuredContent };
  const texts = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text);
  if (!texts.length) return { format: 'other', doc: [] };
  const parsed = texts.map(tryParse);
  if (parsed.every(Boolean)) {
    const values = parsed.map((entry) => entry.value);
    return { format: 'json', doc: values.length === 1 ? values[0] : values };
  }
  return { format: 'text', doc: [{ text: texts.join('\n') }] };
}

function causeChain(error) {
  const chain = [];
  for (let current = error; current && chain.length < 5; current = current.cause) chain.push(current);
  return chain;
}

function classifyNetworkFailure(error) {
  const chain = causeChain(error);
  if (chain.some((entry) => entry.code === 'EBLOCKED')) return 'blocked';
  if (chain.some((entry) => /redirect/i.test(entry.message ?? ''))) return 'redirect';
  if (chain.some((entry) => /response too large/.test(entry.message ?? ''))) return 'too_large';
  if (chain.some((entry) => entry.name === 'TimeoutError' || entry.code === 'UND_ERR_CONNECT_TIMEOUT' || entry.code === 'ETIMEDOUT')) return 'timeout';
  const isNetwork = error.message === 'fetch failed' || chain.some((entry) => NETWORK_CODE_RE.test(String(entry.code ?? '')));
  return isNetwork ? 'unreachable' : null;
}

/**
 * Reduces any failure to a short category, so that remote error text is never stored.
 * "internal" means our own code broke: it must never be counted against a server.
 */
export function classifyError(error) {
  const code = error?.code;
  if (code === 401 || code === 403 || error?.name === 'UnauthorizedError') return 'auth';
  if (code === 402) return 'payment';
  if (code === 429) return 'rate_limited';
  if (code === 404 || code === 410) return 'gone';
  if (typeof code === 'number' && code >= 500 && code < 600) return 'server_error';
  if (code === INVALID_PARAMS_CODE) return 'invalid_params';
  if (code === REQUEST_TIMEOUT_CODE || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const network = classifyNetworkFailure(error ?? {});
  if (network) return network;
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) return 'internal';
  return 'protocol';
}
