import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { loadDemoTeams, simulateStep, simulateUntil, simulateMatch } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const withTeams = (n, cfg = {}) => {
  let s = T.createTournament(cfg);
  for (let i = 1; i <= n; i++) s = T.addTeam(s, `Team ${i}`, [`P${i}a`, `P${i}b`]);
  return s;
};

test('new tournament defaults: setup, 3/0 points, best of 3 everywhere, double round robin', () => {
  const s = T.createTournament();
  assert.equal(s.phase, 'setup');
  assert.deepEqual(s.config.points, { win: 3, loss: 0 });
  assert.deepEqual(s.config.bestOf, { league: 3, semi: 3, third: 3, final: 3 });
  assert.equal(s.config.doubleRoundRobin, true);
});

test('teams: add, duplicate names refused, bulk paste with players, rename, remove', () => {
  let s = T.createTournament();
  s = T.addTeam(s, '  The   Flights ');
  assert.equal(s.teams[0].name, 'The Flights');
  assert.throws(() => T.addTeam(s, 'the flights'), /already/);
  assert.throws(() => T.addTeam(s, '   '), /empty/);
  const { state, skipped } = T.addTeamsBulk(s, 'Alpha: Ann & Bob\nBravo - Cat, Dan\n\nCharlie\nThe Flights');
  s = state;
  assert.equal(s.teams.length, 4);
  assert.equal(skipped.length, 1);
  assert.deepEqual(s.teams[1].players, ['Ann', 'Bob']);
  assert.deepEqual(s.teams[2].players, ['Cat', 'Dan']);
  s = T.updateTeam(s, s.teams[3].id, { name: 'Charlie 2' });
  assert.equal(s.teams[3].name, 'Charlie 2');
  s = T.removeTeam(s, s.teams[0].id);
  assert.equal(s.teams.length, 3);
});

test('actions never mutate their input', () => {
  const s = withTeams(4);
  const snapshot = JSON.stringify(s);
  T.startLeague(s);
  T.addTeam(s, 'New');
  assert.equal(JSON.stringify(s), snapshot);
});

test('league start needs 4 teams, locks the team list but allows renames', () => {
  assert.throws(() => T.startLeague(withTeams(3)), /at least 4/);
  let s = T.startLeague(withTeams(5));
  assert.equal(s.phase, 'league');
  assert.equal(s.fixtures.length, 20); // double round robin of 5
  assert.throws(() => T.addTeam(s, 'Late'), /before the league/);
  assert.throws(() => T.removeTeam(s, s.teams[0].id), /before the league/);
  s = T.updateTeam(s, s.teams[0].id, { name: 'Renamed' });
  assert.equal(s.teams[0].name, 'Renamed');
  assert.throws(() => T.updateConfig(s, { doubleRoundRobin: false }), /before the league/);
  s = T.backToSetup(s);
  assert.equal(s.phase, 'setup');
  s = T.startLeague(T.updateConfig(s, { doubleRoundRobin: false }));
  assert.equal(s.fixtures.length, 10);
});

test('nextUp gives each board a different match with no team clash', () => {
  const s = T.startLeague(withTeams(8));
  const n = T.nextUp(s);
  assert.ok(n[1] && n[2]);
  assert.notEqual(n[1].id, n[2].id);
  const t1 = [n[1].homeId, n[1].awayId];
  assert.ok(!t1.includes(n[2].homeId) && !t1.includes(n[2].awayId));
});

test('scoring flow: start, legs, auto-decide, finish, undo-able via previous state', () => {
  let s = T.startLeague(withTeams(4));
  const { 1: m1 } = T.nextUp(s);
  s = T.startMatch(s, m1.id, 1);
  assert.throws(() => T.startMatch(s, m1.id, 2), /not waiting/);
  assert.throws(() => T.finishMatch(s, m1.id), /enough legs/);
  s = T.adjustLegs(s, m1.id, 'home', 1);
  s = T.adjustLegs(s, m1.id, 'away', 1);
  s = T.adjustLegs(s, m1.id, 'away', -1);
  s = T.adjustLegs(s, m1.id, 'away', -1); // clamps at 0
  s = T.adjustLegs(s, m1.id, 'home', 1);
  assert.equal(T.matchIsDecided(s, m1.id), true);
  const before = s;
  s = T.adjustLegs(s, m1.id, 'away', 1); // already decided: ignored
  assert.equal(T.fixtureById(s, m1.id).awayLegs, 0);
  s = T.finishMatch(s, m1.id);
  const f = T.fixtureById(s, m1.id);
  assert.equal(f.status, 'done');
  assert.equal(f.board, null);
  const table = T.standings(s);
  assert.equal(table[0].teamId, m1.homeId);
  assert.equal(table[0].points, 3);
  assert.equal(T.fixtureById(before, m1.id).status, 'live');
});

test('board and team clashes are refused', () => {
  let s = T.startLeague(withTeams(6));
  const q = T.upcoming(s);
  s = T.startMatch(s, q[0].id, 1);
  assert.throws(() => T.startMatch(s, q[1].id, 1), /busy/);
  const clash = q.find((f) => f !== q[0] && (f.homeId === q[0].homeId || f.awayId === q[0].homeId));
  assert.throws(() => T.startMatch(s, clash.id, 2), /already playing/);
  s = T.cancelMatch(s, q[0].id);
  assert.equal(T.fixtureById(s, q[0].id).status, 'scheduled');
});

test('reorder upcoming matches', () => {
  let s = T.startLeague(withTeams(6));
  const q = T.upcoming(s);
  s = T.moveFixture(s, q[0].id, 1);
  assert.deepEqual(T.upcoming(s).slice(0, 2).map((f) => f.id), [q[1].id, q[0].id]);
  s = T.playNext(s, q[5].id);
  assert.equal(T.upcoming(s)[0].id, q[5].id);
  assert.equal(T.upcoming(s).length, q.length);
});

test('edit and un-play a result recalculates the table', () => {
  let s = T.startLeague(withTeams(4));
  const m = T.upcoming(s)[0];
  s = T.startMatch(s, m.id, 1);
  s = T.adjustLegs(T.adjustLegs(s, m.id, 'home', 1), m.id, 'home', 1);
  s = T.finishMatch(s, m.id);
  assert.equal(T.standings(s)[0].teamId, m.homeId);
  assert.throws(() => T.editResult(s, m.id, 2, 2), /valid/);
  assert.throws(() => T.editResult(s, m.id, 1, 1), /valid/);
  s = T.editResult(s, m.id, 1, 2);
  assert.equal(T.standings(s)[0].teamId, m.awayId);
  s = T.unplayMatch(s, m.id);
  assert.equal(T.standings(s)[0].points, 0);
  assert.equal(T.upcoming(s).length, 12);
});

test('knockout: needs league done, seeds 1v4 2v3, final fills, complete when done', () => {
  const rand = seededRandom(7);
  let s = simulateUntil(T.startLeague(withTeams(6)), (x) => T.canStartKnockout(x), rand);
  assert.equal(T.leagueProgress(s).played, 30);
  const seeds = T.standings(s).slice(0, 4).map((r) => r.teamId);
  s = T.startKnockout(s, seeds);
  assert.equal(s.phase, 'knockout');
  const sf1 = T.fixtureById(s, 'SF1');
  assert.deepEqual([sf1.homeId, sf1.awayId], [seeds[0], seeds[3]]);
  assert.throws(() => T.startMatch(s, 'F', 1), /not known/);
  s = T.backToLeague(s);
  assert.equal(s.phase, 'league');
  s = T.startKnockout(s, seeds);
  s = simulateUntil(s, (x) => x.phase === 'complete', rand);
  assert.equal(s.phase, 'complete');
  const champ = T.matchWinnerId(T.fixtureById(s, 'F'));
  assert.ok(seeds.includes(champ));
});

test('cannot start knockout early unless forced', () => {
  const s = T.startLeague(withTeams(5));
  assert.throws(() => T.startKnockout(s, s.teams.slice(0, 4).map((t) => t.id)), /Not all/);
  const forced = T.startKnockout(s, s.teams.slice(0, 4).map((t) => t.id), { force: true });
  assert.equal(forced.phase, 'knockout');
  assert.equal(T.leagueFixtures(forced).length, 0);
});

test('third place playoff can be toggled until it starts', () => {
  const rand = seededRandom(3);
  let s = simulateUntil(T.startLeague(withTeams(4)), (x) => x.phase === 'knockout', rand);
  assert.equal(T.fixtureById(s, '3P'), null);
  s = T.updateConfig(s, { thirdPlace: true });
  const third = T.fixtureById(s, '3P');
  assert.ok(third);
  assert.ok(third.order < T.fixtureById(s, 'F').order);
  s = simulateUntil(s, (x) => x.phase === 'complete', rand);
  assert.equal(T.fixtureById(s, '3P').status, 'done');
});

test('best-of can change for a stage only before its first match', () => {
  let s = T.startLeague(withTeams(4));
  s = T.updateConfig(s, { bestOf: { final: 5 } });
  assert.equal(s.config.bestOf.final, 5);
  s = T.startMatch(s, T.upcoming(s)[0].id, 1);
  assert.throws(() => T.updateConfig(s, { bestOf: { league: 5 } }), /cannot change/);
  // Even numbers are bumped to odd.
  assert.equal(T.updateConfig(s, { bestOf: { semi: 4 } }).config.bestOf.semi, 5);
});

test('normalizeState repairs partial / old data and rejects junk', () => {
  assert.equal(T.normalizeState(null), null);
  assert.equal(T.normalizeState({ teams: 'x' }), null);
  const s = T.normalizeState({ teams: [{ id: 'a', name: 'A' }], fixtures: [], config: { points: { win: 5 } } });
  assert.equal(s.config.points.win, 5);
  assert.equal(s.config.points.loss, 0);
  assert.deepEqual(s.teams[0].players, ['', '']);
  assert.equal(s.phase, 'setup');
});

test('reset keeps teams and settings by default', () => {
  const s = T.startLeague(withTeams(4, { title: 'Cup' }));
  const r = T.resetTournament(s);
  assert.equal(r.phase, 'setup');
  assert.equal(r.teams.length, 4);
  assert.equal(r.config.title, 'Cup');
  assert.equal(r.fixtures.length, 0);
  assert.notEqual(r.id, s.id);
  const empty = T.resetTournament(s, { keepTeams: false, keepConfig: false });
  assert.equal(empty.teams.length, 0);
  assert.equal(empty.config.title, 'Doubles Darts Tournament');
});

for (const n of [4, 5, 7, 8, 9, 12, 16]) {
  for (const double of [true, false]) {
    test(`full simulation reaches a champion: ${n} teams, ${double ? 'twice' : 'once'}`, () => {
      const rand = seededRandom(n * 31 + (double ? 1 : 0));
      let s = T.createTournament({ doubleRoundRobin: double });
      s = loadDemoTeams(s, n);
      assert.equal(s.teams.length, n);
      s = simulateUntil(s, (x) => x.phase === 'complete', rand);
      assert.equal(s.phase, 'complete');
      const games = (n * (n - 1)) / 2 * (double ? 2 : 1);
      assert.equal(T.leagueProgress(s).played, games);
      assert.ok(s.fixtures.every((f) => f.status === 'done'));
    });
  }
}

test('simulateMatch plays exactly one more match', () => {
  const rand = seededRandom(1);
  let s = T.startLeague(withTeams(8));
  s = simulateMatch(s, rand);
  assert.equal(T.leagueProgress(s).played, 1);
  assert.equal(simulateStep(T.createTournament(), rand).phase, 'league');
});
