// Compares an observed profile with a contract. Pure: no network, no clock.
import { parseDurationHours } from './contract.mjs';

const MIN_TYPE_SHARE = 0.9;
const MIN_ITEMS_FOR_DISTINCT = 5;

const percent = (share) => `${Math.round(share * 100)}%`;
const violation = (field, rule, expected, actual, message) => ({ field, rule, expected, actual, message });
const readableAge = (hours) => (hours >= 72 ? `${Math.round(hours / 24)} days` : `${hours} hours`);

function checkCoverage(name, rule, stats, itemCount) {
  if (rule.min_coverage === undefined) return null;
  const coverage = stats ? stats.usable / itemCount : 0;
  if (coverage >= rule.min_coverage) return null;
  const rounded = Math.round(coverage * 100) / 100;
  return violation(
    name,
    'min_coverage',
    rule.min_coverage,
    rounded,
    `${name}: only ${percent(coverage)} of ${itemCount} items carry a value (contract: at least ${percent(rule.min_coverage)})`,
  );
}

function checkType(name, rule, stats) {
  if (!rule.type || !stats?.usable) return null;
  const share = (stats.kinds[rule.type] ?? 0) / stats.usable;
  if (share >= MIN_TYPE_SHARE) return null;
  const seen = Object.keys(stats.kinds).filter((kind) => kind !== 'null' && kind !== 'empty').join(', ');
  return violation(name, 'type', rule.type, seen, `${name}: expected ${rule.type}, found ${seen}`);
}

function checkFreshness(name, rule, stats) {
  if (rule.max_age === undefined || !stats?.usable) return null;
  const limit = parseDurationHours(rule.max_age);
  if (stats.ageHours === undefined) {
    return violation(name, 'max_age', rule.max_age, null, `${name}: no past date found to measure freshness (contract: ${rule.max_age})`);
  }
  if (stats.ageHours <= limit) return null;
  return violation(name, 'max_age', rule.max_age, stats.ageHours, `${name}: newest value is ${readableAge(stats.ageHours)} old (contract: ${rule.max_age})`);
}

function checkDistinct(name, rule, stats) {
  if (rule.min_distinct === undefined || !stats || stats.usable < MIN_ITEMS_FOR_DISTINCT) return null;
  if (stats.distinct >= rule.min_distinct) return null;
  return violation(
    name,
    'min_distinct',
    rule.min_distinct,
    stats.distinct,
    `${name}: ${stats.usable} items share ${stats.distinct} distinct value(s) (contract: at least ${rule.min_distinct})`,
  );
}

function checkField(name, rule, profile) {
  const stats = profile.fields[name];
  return [
    checkCoverage(name, rule, stats, profile.itemCount),
    checkType(name, rule, stats),
    checkFreshness(name, rule, stats),
    checkDistinct(name, rule, stats),
  ].filter(Boolean);
}

export function checkProfile(contract, profile) {
  const { min_items: minItems = 1, fields = {} } = contract.expect ?? {};
  const violations = [];
  if (profile.itemCount < minItems) {
    const reason = profile.itemsMissing ? `"${contract.items}" is missing from the response` : `got ${profile.itemCount}`;
    violations.push(violation(null, 'min_items', minItems, profile.itemCount, `expected at least ${minItems} items, ${reason}`));
  }
  if (profile.itemCount > 0) {
    for (const [name, rule] of Object.entries(fields)) violations.push(...checkField(name, rule, profile));
  }
  return { ok: violations.length === 0, itemCount: profile.itemCount, violations };
}
