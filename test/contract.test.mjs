import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContract, learnContract, serializeContract, parseDurationHours, ContractError } from '../src/contract.mjs';
import { checkProfile } from '../src/check.mjs';
import { profileDocument } from '../src/profile.mjs';

const NOW = new Date('2026-10-31T12:00:00Z');
const product = (i, overrides = {}) => ({
  id: i,
  name: `product ${i}`,
  price: 10 + i,
  updated_at: '2026-10-31T06:00:00Z',
  ...overrides,
});
const catalogue = (count, overrides) => ({ results: Array.from({ length: count }, (_, i) => product(i, overrides?.(i))) });
const profileOf = (doc, itemsPath) => profileDocument(doc, { itemsPath, now: NOW });

const VALID = `
version: 1
name: products
source:
  type: file
  path: products.json
items: results
expect:
  min_items: 10
  fields:
    price: { type: number, min_coverage: 0.9 }
    updated_at: { type: date, max_age: 48h }
`;

test('parses a valid contract', () => {
  const contract = parseContract(VALID);
  assert.equal(contract.name, 'products');
  assert.equal(contract.expect.fields.price.min_coverage, 0.9);
});

test('rejects a contract with a readable message', () => {
  const broken = [
    [VALID.replace('name: products', ''), /name/],
    [VALID.replace('min_coverage: 0.9', 'min_coverage: 90'), /min_coverage/],
    [VALID.replace('type: number', 'type: money'), /type/],
    [VALID.replace('max_age: 48h', 'max_age: soon'), /max_age/],
    [VALID.replace('version: 1', 'version: 9'), /version/],
    [VALID.replace('type: file', 'type: ftp'), /source/],
    ['a: [', /YAML/],
  ];
  for (const [text, message] of broken) assert.throws(() => parseContract(text), (e) => e instanceof ContractError && message.test(e.message));
});

test('parses durations', () => {
  assert.equal(parseDurationHours('30m'), 0.5);
  assert.equal(parseDurationHours('48h'), 48);
  assert.equal(parseDurationHours('7d'), 168);
});

test('learns a contract that the observed data passes', () => {
  const profile = profileOf(catalogue(20));
  const contract = learnContract([profile], { name: 'products', source: { type: 'file', path: 'x.json' } });
  assert.equal(contract.items, 'results');
  assert.equal(contract.expect.min_items, 10);
  assert.equal(contract.expect.fields.price.type, 'number');
  assert.equal(contract.expect.fields.price.min_coverage, 0.9);
  assert.equal(contract.expect.fields.updated_at.type, 'date');
  assert.ok(contract.expect.fields.updated_at.max_age);
  assert.equal(checkProfile(contract, profile).ok, true);
});

test('a learned contract survives a YAML round trip', () => {
  const contract = learnContract([profileOf(catalogue(20))], { name: 'products', source: { type: 'file', path: 'x.json' } });
  assert.deepEqual(parseContract(serializeContract(contract)), contract);
});

test('learning uses the worst observation and leaves out rare fields', () => {
  const sparse = catalogue(20, (i) => ({ rare: i === 0 ? 'x' : null, price: i < 16 ? 1 + i : null }));
  const contract = learnContract([profileOf(catalogue(20)), profileOf(sparse)], { name: 'n', source: { type: 'file', path: 'x' } });
  assert.equal(contract.expect.fields.rare, undefined);
  assert.equal(contract.expect.fields.price.min_coverage, 0.53);
});

test('--fields keeps only what the agent really uses', () => {
  const contract = learnContract([profileOf(catalogue(20))], { name: 'n', source: { type: 'file', path: 'x' }, fields: ['price'] });
  assert.deepEqual(Object.keys(contract.expect.fields), ['price']);
});

test('--fields refuses a field that was never observed', () => {
  assert.throws(
    () => learnContract([profileOf(catalogue(20))], { name: 'n', source: { type: 'file', path: 'x' }, fields: ['prcie'] }),
    /prcie/,
  );
});

test('a date column that never moves is not given a freshness rule', () => {
  const old = catalogue(20, () => ({ updated_at: '2019-01-01' }));
  const contract = learnContract([profileOf(old)], { name: 'n', source: { type: 'file', path: 'x' } });
  assert.equal(contract.expect.fields.updated_at.max_age, undefined);
});

test('a date that only grows older across observations gets no freshness rule', () => {
  const at = (hours) => ({ ...profileOf(catalogue(20)), fields: { updated_at: { usable: 20, kinds: { date: 20 }, distinct: 1, ageHours: hours } } });
  const source = { type: 'file', path: 'x' };
  const growing = learnContract([at(10), at(22), at(34)], { name: 'n', source });
  assert.equal(growing.expect.fields.updated_at.max_age, undefined);
  const refreshed = learnContract([at(10), at(22), at(2)], { name: 'n', source });
  assert.equal(refreshed.expect.fields.updated_at.max_age, '3d');
});

const contract = learnContract([profileOf(catalogue(100))], { name: 'n', source: { type: 'file', path: 'x' } });
const rulesBroken = (doc, itemsPath = 'results') => checkProfile(contract, profileOf(doc, itemsPath)).violations.map((v) => `${v.field ?? ''}:${v.rule}`);

test('the headline case: same schema, 200 OK, but 85% of the prices are gone', () => {
  const doc = catalogue(100, (i) => ({ price: i < 15 ? 5 : null }));
  const report = checkProfile(contract, profileOf(doc, 'results'));
  assert.equal(report.ok, false);
  const violation = report.violations.find((v) => v.field === 'price' && v.rule === 'min_coverage');
  assert.equal(violation.actual, 0.15);
  assert.match(violation.message, /15%/);
});

test('catches an API that returns an empty list instead of an error', () => {
  assert.deepEqual(rulesBroken({ results: [] }), [':min_items']);
});

test('catches a payload where the items disappeared altogether', () => {
  assert.deepEqual(rulesBroken({ error: 'quota exceeded' }), [':min_items']);
});

test('catches a type change', () => {
  assert.ok(rulesBroken(catalogue(100, () => ({ price: '12,50 EUR' }))).includes('price:type'));
});

test('catches a feed that stopped updating', () => {
  assert.ok(rulesBroken(catalogue(100, () => ({ updated_at: '2026-09-01T00:00:00Z' }))).includes('updated_at:max_age'));
});

test('catches a column frozen on one value', () => {
  assert.ok(rulesBroken(catalogue(100, () => ({ price: 0 }))).includes('price:min_distinct'));
});

test('catches a field that vanished', () => {
  const doc = { results: catalogue(100).results.map(({ price, ...rest }) => rest) };
  assert.ok(rulesBroken(doc).includes('price:min_coverage'));
});

test('passes healthy data', () => {
  assert.deepEqual(rulesBroken(catalogue(100)), []);
});

test('min_items defaults to one', () => {
  const minimal = parseContract('version: 1\nname: n\nsource: { type: file, path: x }\nexpect: { fields: {} }\n');
  assert.equal(checkProfile(minimal, profileOf([])).ok, false);
});
