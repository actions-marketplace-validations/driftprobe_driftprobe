import test from 'node:test';
import assert from 'node:assert/strict';
import { findItems, profileDocument } from '../src/profile.mjs';

const NOW = new Date('2026-10-31T12:00:00Z');

test('picks the largest array of objects when no path is given', () => {
  const doc = { meta: { tags: [{ a: 1 }] }, data: { results: [{ a: 1 }, { a: 2 }] } };
  assert.deepEqual(findItems(doc).path, 'data.results');
});

test('treats a root array and a plain object as items', () => {
  assert.equal(findItems([{ a: 1 }]).path, '.');
  const single = findItems({ a: 1 });
  assert.equal(single.path, '.');
  assert.equal(single.items.length, 1);
});

test('an explicit path that points to nothing yields no items', () => {
  assert.equal(findItems({ error: 'boom' }, 'results'), null);
  assert.equal(findItems({ results: [] }, 'results').items.length, 0);
});

test('counts how many items really carry a value for each field', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ name: `p${i}`, price: i < 15 ? i + 1 : null }));
  const profile = profileDocument({ results: items }, { now: NOW });
  assert.equal(profile.itemsPath, 'results');
  assert.equal(profile.itemCount, 100);
  assert.equal(profile.fields.price.usable, 15);
  assert.equal(profile.fields.price.kinds.null, 85);
  assert.equal(profile.fields.name.usable, 100);
});

test('empty strings, arrays and objects are not usable values', () => {
  const profile = profileDocument([{ a: '  ', b: [], c: {} }], { now: NOW });
  for (const field of ['a', 'b', 'c']) assert.equal(profile.fields[field].usable, 0);
});

test('never stores values, only their shape', () => {
  const doc = [{ email: 'secret.person@example.com', note: 'private-note', price: 987654 }];
  const stored = JSON.stringify(profileDocument(doc, { now: NOW }));
  for (const leak of ['secret.person', 'private-note', '987654']) assert.ok(!stored.includes(leak), leak);
});

test('collapses dynamic keys so identifiers cannot leak through field names', () => {
  const doc = [{ 'jane@example.com': { score: 1 }, 12345: { score: 2 } }];
  const stored = JSON.stringify(profileDocument(doc, { now: NOW }));
  assert.ok(!stored.includes('jane@example.com'));
  assert.ok(!stored.includes('12345'));
  assert.equal(profileDocument(doc, { now: NOW }).fields['*.score'].usable, 1);
});

test('recognises dates and keeps the age of the newest one', () => {
  const doc = [{ updated_at: '2026-10-31T00:00:00Z' }, { updated_at: '2026-10-30T12:00:00Z' }];
  const field = profileDocument(doc, { now: NOW }).fields.updated_at;
  assert.equal(field.kinds.date, 2);
  assert.equal(field.ageHours, 12);
});

test('reads epoch numbers as dates only when the key says so', () => {
  const seconds = Math.floor(NOW.getTime() / 1000) - 3600;
  const fields = profileDocument([{ created_at: seconds, views: seconds }], { now: NOW }).fields;
  assert.equal(fields.created_at.kinds.date, 1);
  assert.equal(fields.created_at.ageHours, 1);
  assert.equal(fields.views.kinds.number, 1);
});

test('ignores future dates when computing freshness', () => {
  const doc = [{ date: '2030-01-01' }, { date: '2026-10-31' }];
  assert.equal(profileDocument(doc, { now: NOW }).fields.date.ageHours, 12);
});

test('flattens nested objects and arrays of objects', () => {
  const doc = [{ seller: { city: 'Lyon' }, offers: [{ price: null }, { price: 12 }] }, { seller: {}, offers: [] }];
  const fields = profileDocument(doc, { now: NOW }).fields;
  assert.equal(fields['seller.city'].usable, 1);
  assert.equal(fields['offers[].price'].usable, 1);
  assert.equal(fields.offers.usable, 1);
});

test('counts distinct values so an all-identical column stands out', () => {
  const doc = Array.from({ length: 10 }, (_, i) => ({ price: 0, id: i }));
  const fields = profileDocument(doc, { now: NOW }).fields;
  assert.equal(fields.price.distinct, 1);
  assert.equal(fields.id.distinct, 10);
});

test('a missing items path is reported, not guessed', () => {
  const profile = profileDocument({ error: 'boom' }, { itemsPath: 'results', now: NOW });
  assert.equal(profile.itemCount, 0);
  assert.equal(profile.itemsMissing, true);
});

test('the digest is keyed, follows the content and not the observation time', () => {
  const later = new Date(NOW.getTime() + 3600_000);
  const digestKey = 'local-secret';
  const a = profileDocument([{ a: 1 }], { now: NOW, digestKey }).digest;
  assert.equal(profileDocument([{ a: 1 }], { now: later, digestKey }).digest, a);
  assert.notEqual(profileDocument([{ a: 2 }], { now: NOW, digestKey }).digest, a);
  assert.notEqual(profileDocument([{ a: 1 }], { now: NOW, digestKey: 'other' }).digest, a);
  assert.equal(profileDocument([{ a: 1 }], { now: NOW }).digest, undefined);
});

test('keys that look like data never reach the field names or the items path', () => {
  const doc = { 'orders_of_jean.dupont@acme.com': [{ a: 1 }, { a: 2 }], 'jean.dupont': { balance: 12 } };
  const stored = JSON.stringify(profileDocument(doc, { now: NOW }));
  assert.ok(!stored.includes('jean.dupont'), stored);
});

test('an object with very many keys is treated as a map', () => {
  const map = Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['person_' + String.fromCharCode(97 + (i % 26)) + i, { score: i }]));
  const fields = profileDocument([map], { now: NOW }).fields;
  assert.deepEqual(Object.keys(fields), ['*.score']);
});
