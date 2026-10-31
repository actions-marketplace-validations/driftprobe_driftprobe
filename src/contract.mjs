// The contract is the YAML file a team keeps in its repo: what the agent needs from a source.
import { parse, stringify } from 'yaml';

export const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'array', 'object'];
const FIELD_RULES = ['type', 'min_coverage', 'max_age', 'min_distinct'];
const EXPECT_KEYS = ['min_items', 'fields'];
const SOURCE_TYPES = ['http', 'mcp', 'file', 'observed'];
const DURATION_RE = /^(\d+(?:\.\d+)?)(m|h|d)$/;
const HOURS_PER_UNIT = { m: 1 / 60, h: 1, d: 24 };

const MIN_KEPT_COVERAGE = 0.5;
const COVERAGE_MARGIN = 0.1;
const NOISE_SIGMAS = 3;
const MIN_TYPE_SHARE = 0.9;
const MIN_FRESHNESS_HOURS = 72;
const FRESHNESS_FACTOR = 3;
const MAX_LEARNED_AGE_HOURS = 24 * 7;
const MIN_RUNS_FOR_CADENCE = 3;
const MIN_ITEMS_FOR_DISTINCT = 5;
const FRESHNESS_KEY_RE = /updated|modified|published|posted|created|fetched|timestamp|date|time|_at$|At$/i;

export class ContractError extends Error {}

export function parseDurationHours(text, label = 'max_age') {
  const match = DURATION_RE.exec(String(text));
  if (!match) throw new ContractError(`invalid ${label} "${text}": use a number followed by m, h or d, like 48h`);
  return Number(match[1]) * HOURS_PER_UNIT[match[2]];
}

function validateField(name, rule) {
  if (rule === null || typeof rule !== 'object') throw new ContractError(`field "${name}": expected a mapping of rules`);
  const unknownRule = Object.keys(rule).find((key) => !FIELD_RULES.includes(key));
  if (unknownRule) throw new ContractError(`field "${name}": unknown rule "${unknownRule}" (expected ${FIELD_RULES.join(', ')})`);
  if (rule.type !== undefined && !FIELD_TYPES.includes(rule.type)) {
    throw new ContractError(`field "${name}": unknown type "${rule.type}" (expected ${FIELD_TYPES.join(', ')})`);
  }
  const coverage = rule.min_coverage;
  if (coverage !== undefined && !(typeof coverage === 'number' && coverage >= 0 && coverage <= 1)) {
    throw new ContractError(`field "${name}": min_coverage must be between 0 and 1, got ${coverage}`);
  }
  if (rule.max_age !== undefined) parseDurationHours(rule.max_age);
  if (rule.min_distinct !== undefined && !(Number.isInteger(rule.min_distinct) && rule.min_distinct >= 1)) {
    throw new ContractError(`field "${name}": min_distinct must be a positive integer`);
  }
}

function validateSource(source) {
  if (!source || !SOURCE_TYPES.includes(source.type)) {
    throw new ContractError(`source.type must be one of ${SOURCE_TYPES.join(', ')}`);
  }
  const required = { http: ['url'], mcp: ['url', 'tool'], file: ['path'], observed: ['path', 'key'] }[source.type];
  for (const key of required) {
    if (!source[key]) throw new ContractError(`source of type ${source.type} needs "${key}"`);
  }
  if (source.max_silence !== undefined) parseDurationHours(source.max_silence, 'max_silence');
}

export function parseContract(text) {
  let contract;
  try {
    contract = parse(text);
  } catch (error) {
    throw new ContractError(`invalid YAML: ${error.message}`);
  }
  if (!contract || typeof contract !== 'object') throw new ContractError('invalid YAML: expected a mapping');
  if (contract.version !== 1) throw new ContractError(`unsupported version "${contract.version}" (expected 1)`);
  if (!contract.name) throw new ContractError('missing name');
  validateSource(contract.source);
  const unknownKey = Object.keys(contract.expect ?? {}).find((key) => !EXPECT_KEYS.includes(key));
  if (unknownKey) throw new ContractError(`expect: unknown key "${unknownKey}" (expected ${EXPECT_KEYS.join(', ')})`);
  const minItems = contract.expect?.min_items;
  if (minItems !== undefined && !(Number.isInteger(minItems) && minItems >= 0)) {
    throw new ContractError('expect.min_items must be a non negative integer');
  }
  for (const [name, rule] of Object.entries(contract.expect?.fields ?? {})) validateField(name, rule);
  return contract;
}

export function serializeContract(contract) {
  return stringify(contract);
}

// A spread would overflow the stack on a very long observation log.
const minOf = (values) => values.reduce((lowest, value) => Math.min(lowest, value), Infinity);
const maxOf = (values) => values.reduce((highest, value) => Math.max(highest, value), -Infinity);
const floor2 = (value) => Math.floor(value * 100 + 1e-9) / 100;
const coverageOf = (profile, name) => (profile.itemCount ? (profile.fields[name]?.usable ?? 0) / profile.itemCount : 0);

function dominantType(profiles, name) {
  const counts = {};
  for (const profile of profiles) {
    for (const [kind, count] of Object.entries(profile.fields[name]?.kinds ?? {})) {
      if (FIELD_TYPES.includes(kind)) counts[kind] = (counts[kind] ?? 0) + count;
    }
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const [kind, count] = Object.entries(counts).sort(([, a], [, b]) => b - a)[0] ?? [];
  return kind && count / total >= MIN_TYPE_SHARE ? kind : undefined;
}

function learnedMaxAge(profiles, name) {
  if (!FRESHNESS_KEY_RE.test(name)) return undefined;
  const ages = profiles.map((profile) => profile.fields[name]?.ageHours);
  if (ages.some((age) => age === undefined)) return undefined;
  // With several observations, require proof that this column does get refreshed:
  // a date that only grows older is a static dataset or a cadence longer than what we saw.
  if (ages.length >= MIN_RUNS_FOR_CADENCE && !ages.some((age, i) => i > 0 && age <= ages[i - 1])) return undefined;
  const oldest = maxOf(ages);
  if (oldest > MAX_LEARNED_AGE_HOURS) return undefined;
  const hours = Math.ceil(Math.max(MIN_FRESHNESS_HOURS, oldest * FRESHNESS_FACTOR));
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

// The margin grows with sampling noise: 16 values out of 20 say much less than 800 out of 1000.
function coverageFloor(profiles, name) {
  const floors = profiles.map((profile) => {
    const share = coverageOf(profile, name);
    const noise = NOISE_SIGMAS * Math.sqrt((share * (1 - share)) / Math.max(profile.itemCount, 1));
    return share - Math.max(COVERAGE_MARGIN, noise);
  });
  return Math.max(0.01, floor2(minOf(floors)));
}

function learnField(profiles, name) {
  const rule = { min_coverage: coverageFloor(profiles, name) };
  const type = dominantType(profiles, name);
  if (type) rule.type = type;
  if (type === 'date') {
    const maxAge = learnedMaxAge(profiles, name);
    if (maxAge) rule.max_age = maxAge;
  }
  const enoughItems = profiles.every((profile) => (profile.fields[name]?.usable ?? 0) >= MIN_ITEMS_FOR_DISTINCT);
  if (enoughItems && profiles.every((profile) => profile.fields[name].distinct >= 3)) rule.min_distinct = 2;
  return rule;
}

function chooseFields(profiles, wanted) {
  const observed = new Set(profiles.flatMap((profile) => Object.keys(profile.fields)));
  if (wanted) {
    const unknown = wanted.filter((name) => !observed.has(name));
    if (unknown.length) throw new ContractError(`never observed: ${unknown.join(', ')} (seen: ${[...observed].join(', ')})`);
    return wanted;
  }
  return [...observed].filter((name) => minOf(profiles.map((profile) => coverageOf(profile, name))) >= MIN_KEPT_COVERAGE);
}

/** Builds a contract from one or more observations, keeping a margin under the worst one. */
export function learnContract(profiles, { name, source, fields }) {
  if (!profiles.length) throw new ContractError('nothing to learn from');
  const minItems = minOf(profiles.map((profile) => profile.itemCount));
  const chosen = chooseFields(profiles, fields);
  return {
    version: 1,
    name,
    source,
    items: profiles[0].itemsPath,
    expect: {
      min_items: Math.max(1, Math.floor(minItems / 2)),
      fields: Object.fromEntries(chosen.map((field) => [field, learnField(profiles, field)])),
    },
  };
}
