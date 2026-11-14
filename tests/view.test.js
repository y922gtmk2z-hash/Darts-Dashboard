import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, stageName, timeAgo } from '../js/view.js';

test('esc neutralises HTML in team names', () => {
  assert.equal(esc(`<img src=x onerror="alert(1)">&'`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(3), '3');
});

test('stage names', () => {
  assert.equal(stageName({ stage: 'league', order: 7 }), 'League · Match 7');
  assert.equal(stageName({ stage: 'semi', id: 'SF2' }, { short: true }), 'SF2');
  assert.equal(stageName({ stage: 'final' }), 'Final');
});

test('timeAgo', () => {
  assert.equal(timeAgo(null), 'never');
  assert.equal(timeAgo(1000, 3000), 'just now');
  assert.equal(timeAgo(1000, 31000), '30s ago');
  assert.equal(timeAgo(1000, 1000 + 5 * 60000), '5 min ago');
});
