import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knockoutSeeding, createKnockoutFixtures, resolveKnockout, bracketView, isDecided } from '../js/logic/bracket.js';
import { computeStandings } from '../js/logic/standings.js';
import { config, teams, result } from './helpers.js';

test('seeds are top four; semis are 1v4 and 2v3', () => {
  const rows = computeStandings(
    teams('A', 'B', 'C', 'D', 'E'),
    [result('A', 'B', 2, 0), result('A', 'C', 2, 0), result('A', 'D', 2, 0), result('B', 'C', 2, 0), result('B', 'D', 2, 0), result('C', 'D', 2, 0), result('E', 'D', 0, 2)],
    config,
  );
  const { seeds, tie } = knockoutSeeding(rows);
  assert.deepEqual(seeds, ['A', 'B', 'C', 'D']);
  assert.equal(tie, false);
  const ko = createKnockoutFixtures(seeds);
  assert.deepEqual(ko.map((f) => [f.id, f.homeId, f.awayId]), [
    ['SF1', 'A', 'D'],
    ['SF2', 'B', 'C'],
    ['F', null, null],
  ]);
});

test('flags a tie at 4th place that only the name separates', () => {
  const rows = computeStandings(teams('A', 'B', 'C', 'D', 'E'), [result('A', 'B', 2, 0), result('C', 'A', 0, 2)], config);
  // A 6 pts; D, E 0 pts (leg diff 0); B, C 0 pts (leg diff -2, never met) -> 4th/5th = B/C.
  assert.deepEqual(rows.map((r) => r.teamId), ['A', 'D', 'E', 'B', 'C']);
  const s = knockoutSeeding(rows);
  assert.equal(s.tie, true);
  assert.deepEqual(new Set(s.tiedTeams), new Set(['B', 'C']));
});

test('no tie flag when 4th and 5th are separated on head-to-head', () => {
  const fixtures = [];
  for (const t of ['A', 'B', 'C']) fixtures.push(result(t, 'Z', 2, 0), result('Z', t, 0, 2));
  // D and E: identical overall (3 pts, 3-3 legs) but D won their meeting.
  fixtures.push(result('D', 'E', 2, 1), result('Z', 'D', 2, 1), result('E', 'Z', 2, 1));
  const rows = computeStandings(teams('A', 'B', 'C', 'E', 'D', 'Z'), fixtures, config);
  assert.deepEqual(rows.slice(3, 5).map((r) => r.teamId), ['D', 'E']);
  const s = knockoutSeeding(rows);
  assert.equal(s.tie, false);
  assert.deepEqual(s.seeds, ['A', 'B', 'C', 'D']);
});

test('third place match is optional and sits before the final', () => {
  const ko = createKnockoutFixtures(['A', 'B', 'C', 'D'], { thirdPlace: true, startOrder: 10 });
  assert.deepEqual(ko.map((f) => f.id), ['SF1', 'SF2', '3P', 'F']);
  assert.deepEqual(ko.map((f) => f.order), [10, 11, 12, 13]);
});

test('rejects bad seeds', () => {
  assert.throws(() => createKnockoutFixtures(['A', 'B', 'C']));
  assert.throws(() => createKnockoutFixtures(['A', 'A', 'C', 'D']));
});

test('semi winners advance to the final, losers to 3rd place', () => {
  let ko = createKnockoutFixtures(['A', 'B', 'C', 'D'], { thirdPlace: true });
  ko = ko.map((f) => (f.id === 'SF1' ? { ...f, status: 'done', homeLegs: 1, awayLegs: 2 } : f));
  ko = resolveKnockout(ko);
  let v = bracketView(ko);
  assert.equal(v.final.homeId, 'D');
  assert.equal(v.final.awayId, null);
  assert.equal(v.third.homeId, 'A');
  ko = resolveKnockout(ko.map((f) => (f.id === 'SF2' ? { ...f, status: 'done', homeLegs: 2, awayLegs: 0 } : f)));
  v = bracketView(ko);
  assert.deepEqual([v.final.homeId, v.final.awayId], ['D', 'B']);
  assert.deepEqual([v.third.homeId, v.third.awayId], ['A', 'C']);
  ko = ko.map((f) => (f.id === 'F' ? { ...f, status: 'done', homeLegs: 0, awayLegs: 2 } : f));
  v = bracketView(ko);
  assert.equal(v.championId, 'B');
  assert.equal(v.runnerUpId, 'D');
});

test('editing a semi after the final has started is refused', () => {
  let ko = createKnockoutFixtures(['A', 'B', 'C', 'D']);
  ko = ko.map((f) => (f.stage === 'semi' ? { ...f, status: 'done', homeLegs: 2, awayLegs: 0 } : f));
  ko = resolveKnockout(ko).map((f) => (f.id === 'F' ? { ...f, status: 'live' } : f));
  const edited = ko.map((f) => (f.id === 'SF1' ? { ...f, homeLegs: 0, awayLegs: 2 } : f));
  assert.throws(() => resolveKnockout(edited), /final/);
});

test('isDecided respects best-of per stage', () => {
  const f = (stage, h, a) => ({ stage, homeLegs: h, awayLegs: a });
  assert.equal(isDecided(f('league', 2, 1), config), true);
  assert.equal(isDecided(f('league', 1, 1), config), false);
  assert.equal(isDecided(f('league', 2, 2), config), false);
  const bo5 = { ...config, bestOf: { ...config.bestOf, final: 5 } };
  assert.equal(isDecided(f('final', 2, 0), bo5), false);
  assert.equal(isDecided(f('final', 3, 2), bo5), true);
});
