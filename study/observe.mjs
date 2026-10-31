// One observation of one server: handshake, tool catalogue, one neutral read only call.
// Runs inside a worker (see isolated.mjs), so that a hostile server can only ever freeze a thread we can kill.
import { createHash } from 'node:crypto';
import { Agent, fetch as guardedFetch } from 'undici';
import { classifyError, listAllTools, payloadFromToolResult, withMcpClient } from '../src/mcp.mjs';
import { profileDocument } from '../src/profile.mjs';
import { buildArguments, guardedLookup, isPublicHttpsUrl, isPublicUrlShape, isSafeTool } from './safety.mjs';

export const STUDY_USER_AGENT = 'driftprobe-study/0.1 (read-only data contract research)';
export const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const dispatcher = new Agent({ connect: { lookup: guardedLookup } });

function capBody(response) {
  if (!response.body) return response;
  let total = 0;
  const limiter = new TransformStream({
    transform(chunk, controller) {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) controller.error(new Error('response too large'));
      else controller.enqueue(chunk);
    },
  });
  return new Response(response.body.pipeThrough(limiter), { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * The only way the study reaches the network: refuses private targets on every request and every
 * connection, refuses redirects (a public URL must not bounce us elsewhere) and caps response size.
 */
export async function studyFetch(input, init = {}) {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (!isPublicUrlShape(url)) throw Object.assign(new Error('blocked: not a public https url'), { code: 'EBLOCKED' });
  const headers = new Headers(init.headers);
  headers.set('user-agent', STUDY_USER_AGENT);
  return capBody(await guardedFetch(input, { ...init, headers, redirect: 'error', dispatcher }));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** Stable across key order, so that a backend flapping between serialisations is not a catalogue change. */
export function catalogueHash(tools) {
  const shape = tools
    .map((tool) => ({ name: tool.name, input: tool.inputSchema ?? null, output: tool.outputSchema ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(canonical(shape))).digest('hex').slice(0, 16);
}

export function connectionOptions(entry, timeoutMs = TIMEOUT_MS) {
  return { url: entry.url, transport: entry.transport, fetchImpl: studyFetch, timeoutMs };
}

/**
 * The safety policy is applied again on every round: a tool that was read only when the panel
 * was built may have changed since, and a call is only made on what the server declares today.
 */
export function planCall(tools, entry) {
  const tool = tools.find((candidate) => candidate.name === entry.tool);
  if (!tool) return { skip: 'tool_gone' };
  if (!isSafeTool(tool)) return { skip: 'tool_no_longer_safe' };
  const args = buildArguments(tool);
  if (!args) return { skip: 'arguments_no_longer_known' };
  return { args, argsChanged: JSON.stringify(canonical(args)) !== JSON.stringify(canonical(entry.args ?? {})) };
}

async function callAndProfile(client, entry, plan, { timeoutMs, now, digestKey }) {
  const result = await client.callTool({ name: entry.tool, arguments: plan.args }, undefined, { timeout: timeoutMs });
  if (result.isError) return { toolError: true };
  const { format, doc } = payloadFromToolResult(result);
  return { format, profile: profileDocument(doc, { itemsPath: entry.itemsPath, now, digestKey }) };
}

export async function observe(entry, { timeoutMs = TIMEOUT_MS, now = new Date(), digestKey } = {}) {
  const startedAt = Date.now();
  const base = { at: now.toISOString(), server: entry.name };
  if (!(await isPublicHttpsUrl(entry.url))) return { ...base, ok: false, stage: 'guard', error: 'not_public' };
  let stage = 'connect';
  try {
    return await withMcpClient(connectionOptions(entry, timeoutMs), async (client) => {
      stage = 'list';
      const tools = await listAllTools(client, timeoutMs);
      const listed = { toolCount: tools.length, toolsHash: catalogueHash(tools) };
      const plan = planCall(tools, entry);
      if (plan.skip) return { ...base, ok: true, stage: 'done', ms: Date.now() - startedAt, ...listed, skipped: plan.skip };
      stage = 'call';
      const called = await callAndProfile(client, entry, plan, { timeoutMs, now, digestKey });
      return { ...base, ok: true, stage: 'done', ms: Date.now() - startedAt, ...listed, ...(plan.argsChanged ? { argsChanged: true } : {}), ...called };
    });
  } catch (error) {
    return { ...base, ok: false, stage, error: classifyError(error), ms: Date.now() - startedAt };
  }
}
