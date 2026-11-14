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

test('match length reads as "first to N"', async () => {
  const { legsFormat } = await import('../js/view.js');
  assert.equal(legsFormat(5), 'first to 3 legs (best of 5)');
  assert.equal(legsFormat(9, { capital: true }), 'First to 5 legs (best of 9)');
  assert.equal(legsFormat(3), 'first to 2 legs (best of 3)');
  assert.equal(legsFormat(1, { capital: true }), 'Single leg');
});

test('team names come with their players', async () => {
  const { teamText, teamBlock } = await import('../js/view.js');
  const state = { teams: [{ id: 'a', name: 'Double <Trouble>', players: ['Sam', 'Alex'] }, { id: 'b', name: 'Solo', players: ['', ''] }] };
  assert.equal(teamText(state, 'a'), 'Double <Trouble> (Sam & Alex)');
  assert.equal(teamText(state, 'b'), 'Solo');
  const html = teamBlock(state, 'a');
  assert.match(html, /who-name">Double &lt;Trouble&gt;</);
  assert.match(html, /who-players">Sam &amp; Alex</);
  assert.doesNotMatch(teamBlock(state, 'b'), /who-players/);
  assert.match(teamBlock(state, null, { fallback: 'Winner SF1' }), /Winner SF1/);
});
