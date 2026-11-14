import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { loadDemoTeams, simulateUntil } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const live = () => {
  const s = T.startLeague(loadDemoTeams(T.createTournament(), 4));
  const f = T.upcoming(s)[0];
  return { s: T.startMatch(s, f.id, 1), f };
};

test('parseAverage accepts what organisers type', () => {
  assert.equal(T.parseAverage('54.3'), 54.3);
  assert.equal(T.parseAverage(' 61,25 '), 61.25);
  assert.equal(T.parseAverage('45.678'), 45.68);
  assert.equal(T.parseAverage('180'), 180);
  assert.equal(T.parseAverage(''), null);
  for (const bad of ['181', '-3', 'abc', '5e1', '1.2.3']) assert.ok(Number.isNaN(T.parseAverage(bad)), bad);
});

test('averages are recorded per team on a live match and kept when it finishes', () => {
  let { s, f } = live();
  s = T.setAverage(s, f.id, 'home', '54.3');
  s = T.setAverage(s, f.id, 'away', 48);
  assert.throws(() => T.setAverage(s, f.id, 'home', '200'), /0 to 180/);
  s = T.adjustLegs(T.adjustLegs(s, f.id, 'home', 1), f.id, 'home', 1);
  s = T.finishMatch(s, f.id);
  const done = T.fixtureById(s, f.id);
  assert.deepEqual([done.homeAvg, done.awayAvg], [54.3, 48]);
  s = T.setAverage(s, f.id, 'away', '');
  assert.equal(T.fixtureById(s, f.id).awayAvg, null, 'cleared after the match');
  assert.deepEqual(T.validateState(s), []);
});

test('averages cannot be set before a match starts and are wiped by cancel / un-play', () => {
  let { s, f } = live();
  const other = T.upcoming(s).find((x) => x.id !== f.id);
  assert.throws(() => T.setAverage(s, other.id, 'home', '50'), /started/);
  s = T.cancelMatch(T.setAverage(s, f.id, 'home', '50'), f.id);
  assert.equal(T.fixtureById(s, f.id).homeAvg, null);
  s = T.startMatch(s, f.id, 1);
  s = T.setAverage(s, f.id, 'home', '50');
  s = T.finishMatch(T.adjustLegs(T.adjustLegs(s, f.id, 'away', 1), f.id, 'away', 1), f.id);
  s = T.unplayMatch(s, f.id);
  assert.equal(T.fixtureById(s, f.id).homeAvg, null);
});

test('league table shows each team\'s mean of recorded match averages', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament({ doubleRoundRobin: false }), 4));
  const team = s.teams[0].id;
  const recorded = [];
  for (const f of s.fixtures.filter((x) => x.homeId === team || x.awayId === team)) {
    s = T.startMatch(s, f.id, 1);
    const side = f.homeId === team ? 'home' : 'away';
    if (recorded.length < 2) {
      const v = [50, 61.5][recorded.length];
      s = T.setAverage(s, f.id, side, v);
      recorded.push(v);
    }
    s = T.finishMatch(T.adjustLegs(T.adjustLegs(s, f.id, side, 1), f.id, side, 1), f.id);
  }
  const row = T.standings(s).find((r) => r.teamId === team);
  assert.equal(row.avgCount, 2, 'matches without an average are ignored');
  assert.equal(row.avg, 55.75);
  assert.equal(T.standings(s).find((r) => r.teamId !== team && r.played > 0).avg, null);
});

test('backups with impossible averages are refused; old backups without averages load fine', () => {
  const s = simulateUntil(T.startLeague(loadDemoTeams(T.createTournament(), 4)), (x) => T.leagueProgress(x).played >= 2 && !T.liveFixtures(x).length, seededRandom(3));
  const done = s.fixtures.find((f) => f.status === 'done');
  const bad = JSON.parse(JSON.stringify(s));
  bad.fixtures.find((f) => f.id === done.id).homeAvg = 250;
  assert.match(T.validateState(T.normalizeState(bad)).join(), /impossible 3-dart average/);
  const old = JSON.parse(JSON.stringify(s));
  for (const f of old.fixtures) { delete f.homeAvg; delete f.awayAvg; }
  const loaded = T.normalizeState(old);
  assert.deepEqual(T.validateState(loaded), []);
  assert.equal(loaded.fixtures[0].homeAvg, null);
});

test('rehearsal simulator fills in realistic averages', () => {
  const s = simulateUntil(T.startLeague(loadDemoTeams(T.createTournament(), 4)), (x) => x.phase === 'complete', seededRandom(9));
  for (const f of s.fixtures) {
    assert.ok(f.homeAvg >= 35 && f.homeAvg <= 80 && f.awayAvg >= 35 && f.awayAvg <= 80);
  }
  assert.ok(T.standings(s).every((r) => r.avg !== null));
});
