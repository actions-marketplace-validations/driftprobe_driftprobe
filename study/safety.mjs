// The study talks to servers we do not run. These rules keep it harmless: public endpoints only,
// no credentials, and only tools that declare themselves read only and are named like a read.
import { lookup as dnsCallbackLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
];
// Includes every form that can embed an IPv4 address: compatible, NAT64 and 6to4.
const PRIVATE_V6 = [['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]];
const blocked = new BlockList();
for (const [network, prefix] of PRIVATE_V4) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of PRIVATE_V6) blocked.addSubnet(network, prefix, 'ipv6');

const LOCAL_HOST_RE = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal)$/i;
const ALLOWED_PORTS = new Set(['', '443', '8443']);

// A tool must start with a read verb. A denylist alone would let through sendMessage or issues.create.
const READ_VERBS = new Set(['get', 'list', 'search', 'find', 'lookup', 'query', 'fetch', 'read', 'browse', 'retrieve', 'show', 'describe']);
const RISKY_WORDS = new Set([
  'add', 'buy', 'cancel', 'charge', 'clear', 'create', 'delete', 'deploy', 'drop', 'edit', 'exec', 'execute', 'insert', 'invite', 'kill', 'merge',
  'mint', 'modify', 'order', 'pay', 'post', 'publish', 'purchase', 'put', 'remove', 'reset', 'restart', 'run', 'save', 'sell', 'send', 'set', 'sign',
  'start', 'stop', 'submit', 'swap', 'trade', 'transfer', 'trigger', 'update', 'upload', 'write',
  'generate', 'image', 'video', 'audio', 'speech', 'token', 'tokens', 'secret', 'secrets', 'key', 'keys', 'password', 'credential', 'credentials', 'login', 'auth',
  'user', 'users', 'account', 'accounts', 'email', 'emails', 'contact', 'contacts', 'customer', 'customers', 'person', 'people', 'profile', 'profiles', 'phone', 'address', 'addresses',
]);
const FORBIDDEN_PARAM_RE = /url|uri|link|domain|host|path|file|email|phone|id$|_id|uuid|token|key|secret|password|auth|user|account|address|code|command|script|sql|dry|confirm|force|commit|apply|execute/i;
const UNSAFE_VALUE_RE = /:\/\/|@/;
const SEARCH_PARAM_RE = /^(?:q|query|search|keyword|keywords|term|terms|text|topic|name|title)$|^search[_-]?(?:term|query|text)$/i;
const PLACE_PARAM_RE = /^(?:city|location|place)$/i;
const LANGUAGE_PARAM_RE = /^(?:lang|language|locale)$/i;
const BOUND_PARAM_RE = /^(?:limit|count|num|num_results|per_page|page_size|pagesize|max_results|maxresults|top_k)$/i;
const NEUTRAL_QUERY = 'coffee';
const BOUND_VALUE = 20;

export function isPrivateIp(ip) {
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Checks scheme, port and literal addresses. Cheap enough to run on every request. */
export function isPublicUrlShape(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (!ALLOWED_PORTS.has(url.port) || LOCAL_HOST_RE.test(url.hostname)) return false;
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(bare) ? !isPrivateIp(bare) : true;
}

export async function isPublicHttpsUrl(text, resolver = (host) => lookup(host, { all: true })) {
  if (!isPublicUrlShape(text)) return false;
  const { hostname } = new URL(text);
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return true;
  try {
    const addresses = await resolver(hostname);
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

/** Used for every connection, so that a host cannot resolve to something else later (DNS rebinding). */
export function guardedLookup(hostname, options, callback, resolver = dnsCallbackLookup) {
  resolver(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (addresses.some(({ address }) => isPrivateIp(address))) {
      return callback(Object.assign(new Error('blocked: private address'), { code: 'EBLOCKED' }));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const nameWords = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The MCP default for an unannotated tool is "may write", so no annotation means no call. */
export function isSafeTool(tool) {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint !== true || hints.destructiveHint === true) return false;
  const words = nameWords(tool.name);
  return READ_VERBS.has(words[0]) && !words.some((word) => RISKY_WORDS.has(word));
}

function declaredValue(schema) {
  if (schema.type === 'object' || schema.type === 'array') return undefined;
  const value = schema.default ?? schema.enum?.[0] ?? (typeof schema.examples?.[0] !== 'object' ? schema.examples?.[0] : undefined);
  return typeof value === 'string' && UNSAFE_VALUE_RE.test(value) ? undefined : value;
}

function valueFor(name, schema) {
  if (FORBIDDEN_PARAM_RE.test(name)) return undefined;
  const declared = declaredValue(schema);
  if (declared !== undefined) return declared;
  if (schema.type === 'string') {
    if (SEARCH_PARAM_RE.test(name)) return NEUTRAL_QUERY;
    if (PLACE_PARAM_RE.test(name)) return 'Paris';
    if (LANGUAGE_PARAM_RE.test(name)) return 'en';
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (BOUND_PARAM_RE.test(name)) return BOUND_VALUE;
    if (schema.minimum !== undefined) return schema.minimum;
  }
  return undefined;
}

/** Returns the arguments for a neutral call, or null when a required value would have to be invented. */
export function buildArguments(tool) {
  const properties = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const args = {};
  for (const name of required) {
    const value = valueFor(name, properties[name] ?? {});
    if (value === undefined) return null;
    args[name] = value;
  }
  for (const [name, schema] of Object.entries(properties)) {
    if (!required.has(name) && BOUND_PARAM_RE.test(name) && (schema.type === 'integer' || schema.type === 'number')) args[name] = BOUND_VALUE;
  }
  return args;
}

const needsCredentials = (remote) => (remote.headers ?? []).some((header) => header.isRequired);

/** Picks an endpoint usable as is: no required header, no URL template. Prefers the current transport. */
export function usableRemote(server) {
  const candidates = (server.remotes ?? []).filter((remote) => !needsCredentials(remote) && !/[{}]/.test(remote.url ?? ''));
  return candidates.find((remote) => remote.type === 'streamable-http') ?? candidates.find((remote) => remote.type === 'sse') ?? null;
}
