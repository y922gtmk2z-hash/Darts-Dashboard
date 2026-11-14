import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { normalizeConfig } from '../js/logic/config.js';
import { loadDemoTeams, simulateUntil, simulateStep } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const semisDone = (x) => x.phase === 'knockout' && ['SF1', 'SF2'].every((id) => T.fixtureById(x, id).status === 'done');

test('final waits for the 3rd place match by default', () => {
  let s = loadDemoTeams(T.createTournament({ thirdPlace: true }), 4);
  s = simulateUntil(s, semisDone, seededRandom(3));
  const next = T.nextUp(s);
  assert.deepEqual([next[1]?.id, next[2]?.id], ['3P', undefined]);
  assert.throws(() => T.startMatch(s, 'F', 2), /on its own/);
  s = T.startMatch(s, '3P', 1);
  assert.throws(() => T.startMatch(s, 'F', 2), /on its own/);
  s = simulateUntil(s, (x) => T.fixtureById(x, '3P').status === 'done', seededRandom(4));
  assert.equal(T.nextUp(s)[1]?.id ?? T.nextUp(s)[2]?.id, 'F');
});

test('finalAlone can be turned off to play the final alongside the 3rd place match', () => {
  let s = loadDemoTeams(T.createTournament({ thirdPlace: true, finalAlone: false }), 4);
  s = simulateUntil(s, semisDone, seededRandom(3));
  const next = T.nextUp(s);
  assert.deepEqual(new Set([next[1]?.id, next[2]?.id]), new Set(['3P', 'F']));
});

test('old saved tournaments with the generic title pick up the new name', () => {
  assert.equal(normalizeConfig({ title: 'Doubles Darts Tournament' }).title, 'James Watkins Invitational');
  assert.equal(normalizeConfig({ title: 'Friday Cup' }).title, 'Friday Cup');
  assert.equal(normalizeConfig({}).showLogo, true);
});

test('validateState accepts real tournaments at every step', () => {
  const rand = seededRandom(11);
  let s = loadDemoTeams(T.createTournament({ thirdPlace: true }), 7);
  for (let i = 0; i < 5000 && s.phase !== 'complete'; i++) {
    s = simulateStep(s, rand);
    assert.deepEqual(T.validateState(s), [], `step ${i} (${s.phase})`);
  }
  assert.equal(s.phase, 'complete');
});

test('validateState rejects inconsistent backups', () => {
  const raw = {
    phase: 'league',
    teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'a' }],
    fixtures: [
      { id: 'L1', stage: 'league', homeId: 'a', awayId: 'b', status: 'done', homeLegs: 5, awayLegs: 5 },
      { id: 'L2', stage: 'league', homeId: 'a', awayId: 'ghost', status: 'live', board: 1 },
      { id: 'L2', stage: 'league', homeId: 'b', awayId: 'a', status: 'live', board: 1 },
      { id: 'L3', stage: 'league', homeId: 'c', awayId: 'b', status: 'done', homeLegs: 1, awayLegs: 1 },
    ],
  };
  const problems = T.validateState(T.normalizeState(raw)).join('\n');
  for (const re of [/twice/, /doesn't exist/, /no winner/, /Two matches are live on board 1/, /two matches at once/, /more legs/, /called/]) {
    assert.match(problems, re);
  }
  assert.match(T.validateState(T.normalizeState({ phase: 'knockout', teams: [], fixtures: [] })).join(), /no semi-finals/);
});
