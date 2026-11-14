import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { loadDemoTeams, simulateUntil } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const league = (n = 6, cfg = {}) => T.startLeague(loadDemoTeams(T.createTournament(cfg), n));

test('a result can be typed straight in for a match that was never started', () => {
  let s = league();
  const f = T.upcoming(s).find((x) => x.plannedBoard === 2);
  s = T.recordResult(s, f.id, 1, 2, { homeAvg: '48.5', awayAvg: 52 });
  const d = T.fixtureById(s, f.id);
  assert.deepEqual([d.status, d.homeLegs, d.awayLegs, d.homeAvg, d.awayAvg, d.plannedBoard, d.board], ['done', 1, 2, 48.5, 52, 2, null]);
  assert.equal(T.standings(s).find((r) => r.teamId === f.awayId).points, 3);
  assert.deepEqual(T.validateState(s), []);
});

test('typed results are validated', () => {
  const s = league();
  const f = T.upcoming(s)[0];
  assert.throws(() => T.recordResult(s, f.id, 1, 1), /exactly 2 legs/);
  assert.throws(() => T.recordResult(s, f.id, 2, 2), /exactly 2 legs/);
  assert.throws(() => T.recordResult(s, f.id, 2, 0, { homeAvg: 'abc' }), /0 to 180/);
  const done = T.recordResult(s, f.id, 2, 0);
  assert.throws(() => T.recordResult(done, f.id, 2, 1), /Edit/);
});

test('a live match can be finished with a typed result, and legs set directly', () => {
  let s = league();
  const f = T.upcoming(s)[0];
  s = T.startMatch(s, f.id, 1);
  s = T.setLegs(s, f.id, 1, 1);
  assert.deepEqual([T.fixtureById(s, f.id).homeLegs, T.fixtureById(s, f.id).awayLegs], [1, 1]);
  assert.throws(() => T.setLegs(s, f.id, 2, 2), /Only one team/);
  s = T.setLegs(s, f.id, 9, 0);
  assert.equal(T.fixtureById(s, f.id).homeLegs, 2, 'clamped');
  s = T.recordResult(s, f.id, 2, 1, { homeAvg: '60' });
  assert.equal(T.fixtureById(s, f.id).status, 'done');
  assert.equal(T.fixtureById(s, f.id).homeAvg, 60);
});

test('typed knockout results advance the bracket; the final still waits for the 3rd place match', () => {
  let s = loadDemoTeams(T.createTournament({ thirdPlace: true }), 4);
  s = simulateUntil(s, (x) => x.phase === 'knockout', seededRandom(2));
  s = T.recordResult(s, 'SF1', 2, 0);
  s = T.recordResult(s, 'SF2', 0, 2);
  assert.ok(T.fixtureById(s, 'F').homeId && T.fixtureById(s, 'F').awayId);
  assert.throws(() => T.recordResult(s, 'F', 2, 0), /on its own/);
  s = T.recordResult(s, '3P', 2, 1);
  s = T.recordResult(s, 'F', 1, 2);
  assert.equal(s.phase, 'complete');
});
