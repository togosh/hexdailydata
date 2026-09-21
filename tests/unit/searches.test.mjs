import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearch,
  readSearches,
  rememberSearch,
  recentSearchKey,
} from '../../src/web/searches.ts';
test('search normalizes address and optional hash stake ID without unsafe coercion', () => {
  assert.equal(normalizeSearch(' #12345 '), '12345');
  assert.equal(normalizeSearch('0x' + 'AB'.repeat(20)), '0x' + 'ab'.repeat(20));
  for (const value of ['#01', '##1', '1e3', '-1', '1099511627776', '0x123', ''])
    assert.equal(normalizeSearch(value), null);
  assert.equal(normalizeSearch('#0'), '0');
});
test('recent searches are normalized, deduplicated, bounded and resilient to disabled or corrupt storage', () => {
  let data = '[]';
  const storage = {
    getItem: () => data,
    setItem: (key, value) => {
      assert.equal(key, recentSearchKey);
      data = value;
    },
  };
  for (let n = 1; n <= 7; n++) rememberSearch(storage, '#' + n);
  assert.deepEqual(readSearches(storage), ['7', '6', '5', '4', '3']);
  assert.deepEqual(rememberSearch(storage, '5'), ['5', '7', '6', '4', '3']);
  assert.deepEqual(rememberSearch(storage, 'bad'), ['5', '7', '6', '4', '3']);
  data = '["#1","1",null,"invalid","0x' + 'AB'.repeat(20) + '"]';
  assert.deepEqual(readSearches(storage), ['1', '0x' + 'ab'.repeat(20)]);
  data = 'bad';
  assert.deepEqual(readSearches(storage), []);
  const blocked = {
    getItem: () => {
      throw Error('blocked');
    },
    setItem: () => {
      throw Error('blocked');
    },
  };
  assert.deepEqual(rememberSearch(blocked, '#3'), ['3']);
});
