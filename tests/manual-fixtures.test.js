import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { simulateUntil } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const withTeams = (n, cfg = {}) => {
  let s = T.createTournament(cfg);
  for (let i = 1; i <= n; i++) s = T.addTeam(s, `Team ${i}`);
  return s;
};
const id = (s, name) => s.teams.find((t) => t.name === name).id;

test('manual league starts empty; matches can be added, edited, swapped, removed', () => {
  let s = T.startLeague(withTeams(4), { manual: true });
  assert.equal(s.phase, 'league');
  assert.equal(s.fixtures.length, 0);
  s = T.addFixture(s, id(s, 'Team 1'), id(s, 'Team 2'));
  s = T.addFixture(s, id(s, 'Team 3'), id(s, 'Team 4'));
  assert.deepEqual(s.fixtures.map((f) => [f.id, f.order]), [['L1', 1], ['L2', 2]]);
  assert.throws(() => T.addFixture(s, id(s, 'Team 1'), id(s, 'Team 1')), /itself/);
  assert.throws(() => T.addFixture(s, 'nope', id(s, 'Team 1')), /two teams/);

  s = T.updateFixture(s, 'L2', { homeId: id(s, 'Team 4'), awayId: id(s, 'Team 1') });
  assert.equal(T.fixtureById(s, 'L2').homeId, id(s, 'Team 4'));
  s = T.swapHomeAway(s, 'L2');
  assert.equal(T.fixtureById(s, 'L2').homeId, id(s, 'Team 1'));
  s = T.removeFixture(s, 'L1');
  assert.deepEqual(s.fixtures.map((f) => f.id), ['L2']);
  s = T.addFixture(s, id(s, 'Team 2'), id(s, 'Team 3'));
  assert.equal(s.fixtures.at(-1).id, 'L3', 'ids never reused');
});

test('played and live matches are protected', () => {
  let s = T.startLeague(withTeams(4));
  const f = T.upcoming(s)[0];
  s = T.startMatch(s, f.id, 1);
  assert.throws(() => T.removeFixture(s, f.id), /not started/);
  assert.throws(() => T.updateFixture(s, f.id, { homeId: s.teams[2].id, awayId: s.teams[3].id }), /not started/);
  assert.throws(() => T.swapHomeAway(s, f.id), /not started/);
  const before = s.fixtures.length;
  s = T.clearUnplayedFixtures(s);
  assert.equal(s.fixtures.length, 1);
  assert.ok(before > 1);
  assert.throws(() => T.addFixture(withTeams(4), 'a', 'b'), /during the league/);
});

test('bulk paste fixtures: v / vs / dash, numbering, case-insensitive, reports bad lines', () => {
  let s = T.startLeague(withTeams(4), { manual: true });
  const { state, added, skipped } = T.addFixturesBulk(s, '1. team 1 v Team 2\nTeam 3 vs. TEAM 4\n- Team 1 - Team 3\nTeam 9 v Team 1\nnonsense\nTeam 2 v team 2');
  s = state;
  assert.equal(added, 3);
  assert.equal(skipped.length, 3);
  assert.deepEqual(s.fixtures.map((f) => [T.teamName(s, f.homeId), T.teamName(s, f.awayId)]), [
    ['Team 1', 'Team 2'], ['Team 3', 'Team 4'], ['Team 1', 'Team 3'],
  ]);
});

test('moveFixtureTo puts a match at an exact queue position', () => {
  let s = T.startLeague(withTeams(6));
  const q = T.upcoming(s);
  s = T.moveFixtureTo(s, q[7].id, 2);
  assert.equal(T.upcoming(s)[1].id, q[7].id);
  s = T.moveFixtureTo(s, q[0].id, 999);
  assert.equal(T.upcoming(s).at(-1).id, q[0].id);
  assert.equal(T.upcoming(s).length, q.length);
});

test('leagueBalance reports missing and extra pairings', () => {
  let s = T.startLeague(withTeams(4, { doubleRoundRobin: false }));
  let b = T.leagueBalance(s);
  assert.equal(b.complete, true);
  assert.equal(b.even, true);
  s = T.removeFixture(s, s.fixtures[0].id);
  s = T.addFixture(s, s.teams[0].id, s.teams[1].id);
  s = T.addFixture(s, s.teams[0].id, s.teams[1].id);
  b = T.leagueBalance(s);
  assert.equal(b.complete, false);
  assert.ok(b.extra.length >= 1 || b.missing.length >= 1);
  assert.equal(b.perTeam.get(s.teams[0].id) >= 3, true);
});

test('regenerateUnplayed keeps results and fills in only the meetings still owed', () => {
  const rand = seededRandom(5);
  let s = T.startLeague(withTeams(5));
  s = simulateUntil(s, (x) => T.leagueProgress(x).played >= 6 && T.liveFixtures(x).length === 0, rand);
  const played = s.fixtures.filter((f) => f.status === 'done').length;
  s = T.clearUnplayedFixtures(s);
  assert.equal(T.leagueBalance(s).complete, false);
  s = T.regenerateUnplayed(s);
  assert.equal(s.fixtures.filter((f) => f.status === 'done').length, played);
  assert.equal(s.fixtures.length, 20);
  assert.equal(T.leagueBalance(s).complete, true);
  assert.equal(new Set(s.fixtures.map((f) => f.id)).size, 20);
});

test('a hand-made league can be played through to a champion', () => {
  let s = T.startLeague(withTeams(4), { manual: true });
  s = T.addFixturesBulk(s, 'Team 1 v Team 2\nTeam 3 v Team 4\nTeam 1 v Team 3\nTeam 2 v Team 4').state;
  s = simulateUntil(s, (x) => x.phase === 'complete', seededRandom(9));
  assert.equal(s.phase, 'complete');
  assert.equal(T.leagueProgress(s).played, 4);
});
