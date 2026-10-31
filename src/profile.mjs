// A profile describes the shape of a response without keeping any of its values.
// Everything else in driftprobe (learn, check, record, the study) works from profiles.
import { createHmac } from 'node:crypto';

const MAX_DEPTH = 5;
const MAX_ITEMS = 5000;
const MAX_FIELDS = 300;
const MAX_NESTED_ITEMS = 50;
const MAX_DISTINCT = 10000;
const SEARCH_DEPTH = 3;
const HOUR_MS = 3_600_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_KEY_RE = /(?:^|_)(?:date|time|timestamp|at|updated|modified|published|posted|created)(?:$|_)|(?:At|Date|Time)$/;
// A key that does not look like a schema name may be data ("jean.dupont", an email, an id).
const SCHEMA_KEY_RE = /^[A-Za-z_$][\w$-]{0,63}$/;
const ID_LIKE_KEY_RE = /\d{4,}|^[0-9a-f]{16,}$/i;
const MAX_NAMED_KEYS = 40;
const MIN_EPOCH_S = 946_684_800; // 2000-01-01
const MAX_EPOCH_S = 4_102_444_800; // 2100-01-01

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSchemaKey = (key) => SCHEMA_KEY_RE.test(key) && !ID_LIKE_KEY_RE.test(key);
const normaliseKey = (key) => (isSchemaKey(key) ? key : '*');
// An object with this many keys is a map keyed by data, not a record with a schema.
function namedEntries(object) {
  const entries = Object.entries(object);
  const safeName = entries.length > MAX_NAMED_KEYS ? () => '*' : normaliseKey;
  return entries.map(([key, value]) => [safeName(key), key, value]);
}
const join = (path, key) => (path ? `${path}.${key}` : key);

function epochMs(value) {
  const seconds = value > MAX_EPOCH_S ? value / 1000 : value;
  return seconds >= MIN_EPOCH_S && seconds <= MAX_EPOCH_S ? seconds * 1000 : null;
}

function dateMs(value, key) {
  if (typeof value === 'string') {
    if (!DATE_RE.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return typeof value === 'number' && DATE_KEY_RE.test(key) ? epochMs(value) : null;
}

function kindOf(value, key) {
  if (value === null || value === undefined) return 'null';
  if (dateMs(value, key) !== null) return 'date';
  if (typeof value === 'string') return value.trim() === '' ? 'empty' : 'string';
  if (typeof value === 'number' || typeof value === 'boolean') return typeof value;
  if (Array.isArray(value)) return value.length ? 'array' : 'empty';
  return Object.keys(value).length ? 'object' : 'empty';
}

const isUsable = (kind) => kind !== 'null' && kind !== 'empty';

function remember(seen, path, kind, value, key) {
  const previous = seen.get(path);
  if (previous && isUsable(previous.kind)) return;
  seen.set(path, { kind, value, key });
}

// Walks one item. A field counts once per item, however many nested values carry it.
function collect(value, path, key, depth, seen) {
  const kind = kindOf(value, key);
  if (kind === 'object' && depth < MAX_DEPTH) {
    for (const [safeKey, childKey, child] of namedEntries(value)) {
      collect(child, join(path, safeKey), childKey, depth + 1, seen);
    }
    return;
  }
  remember(seen, path, kind, value, key);
  if (kind !== 'array' || depth >= MAX_DEPTH) return;
  for (const element of value.filter(isObject).slice(0, MAX_NESTED_ITEMS)) {
    for (const [safeKey, childKey, child] of namedEntries(element)) {
      collect(child, `${path}[].${safeKey}`, childKey, depth + 1, seen);
    }
  }
}

function walkPath(doc, itemsPath) {
  if (itemsPath === '.') return doc;
  return itemsPath.split('.').reduce((node, part) => (isObject(node) ? node[part] : undefined), doc);
}

function largestArray(node, path, depth) {
  let best = null;
  for (const [key, value] of Object.entries(node)) {
    // The path is stored: it must never go through a key that may be data.
    if (!isSchemaKey(key)) continue;
    const childPath = join(path, key);
    if (Array.isArray(value) && value.some(isObject) && value.length > (best?.items.length ?? 0)) {
      best = { path: childPath, items: value };
    } else if (isObject(value) && depth < SEARCH_DEPTH) {
      const nested = largestArray(value, childPath, depth + 1);
      if (nested && nested.items.length > (best?.items.length ?? 0)) best = nested;
    }
  }
  return best;
}

/** Locates the list of records in a response. Returns null when an explicit path leads nowhere. */
export function findItems(doc, itemsPath) {
  if (doc === null || doc === undefined) return null;
  if (itemsPath) {
    const node = walkPath(doc, itemsPath);
    if (Array.isArray(node)) return { path: itemsPath, items: node };
    // A named path leads to records: null or "maintenance" in their place means the list is gone.
    return isObject(node) || itemsPath === '.' ? { path: itemsPath, items: [node] } : null;
  }
  if (Array.isArray(doc)) return { path: '.', items: doc };
  if (!isObject(doc)) return { path: '.', items: [doc] };
  return largestArray(doc, '', 0) ?? { path: '.', items: [doc] };
}

function newField() {
  return { usable: 0, kinds: {}, distinctValues: new Set(), newestMs: null };
}

function addToField(field, { kind, value, key }, nowMs) {
  field.kinds[kind] = (field.kinds[kind] ?? 0) + 1;
  if (!isUsable(kind)) return;
  field.usable += 1;
  if (field.distinctValues.size < MAX_DISTINCT) {
    field.distinctValues.add(typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (kind !== 'date') return;
  const ms = dateMs(value, key);
  if (ms <= nowMs && (field.newestMs === null || ms > field.newestMs)) field.newestMs = ms;
}

function finishField(field, nowMs) {
  const done = { usable: field.usable, kinds: field.kinds, distinct: field.distinctValues.size };
  if (field.newestMs !== null) done.ageHours = Math.round(((nowMs - field.newestMs) / HOUR_MS) * 10) / 10;
  return done;
}

function profileItems(items, nowMs) {
  const fields = new Map();
  for (const item of items) {
    const seen = new Map();
    if (isObject(item)) collect(item, '', '', 0, seen);
    else remember(seen, '$value', kindOf(item, ''), item, '');
    for (const [path, entry] of seen) {
      if (!fields.has(path) && fields.size >= MAX_FIELDS) continue;
      if (!fields.has(path)) fields.set(path, newField());
      addToField(fields.get(path), entry, nowMs);
    }
  }
  const sorted = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sorted.map(([path, field]) => [path, finishField(field, nowMs)]));
}

/** Turns a parsed response into a value free description of its shape. */
export function profileDocument(doc, { itemsPath, now = new Date(), digestKey } = {}) {
  const found = findItems(doc, itemsPath);
  if (!found) return { itemsPath, itemsMissing: true, itemCount: 0, fields: {} };
  const items = found.items.slice(0, MAX_ITEMS);
  const profile = {
    itemsPath: found.path,
    itemCount: items.length,
    fields: profileItems(items, now.getTime()),
  };
  // Keyed, so that a small payload cannot be recovered from the digest by brute force.
  if (digestKey) profile.digest = createHmac('sha256', digestKey).update(JSON.stringify(items)).digest('hex').slice(0, 16);
  if (found.items.length > MAX_ITEMS) profile.truncated = true;
  return profile;
}
