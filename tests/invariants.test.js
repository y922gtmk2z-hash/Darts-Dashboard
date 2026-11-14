// Random sequences of organiser actions (including invalid ones) must never
// leave the tournament in an impossible state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { legsToWinFor } from '../js/logic/config.js';
import { loadDemoTeams } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';
import { knockoutSeeding } from '../js/logic/bracket.js';

function checkInvariants(s) {
  assert.deepEqual(T.validateState(s), []);
  const live = T.liveFixtures(s);
  assert.ok(live.length <= 2);
  for (const f of s.fixtures) {
    const need = legsToWinFor(s.config, f.stage);
    assert.ok(f.homeLegs <= need && f.awayLegs <= need);
    if (f.status !== 'live') assert.equal(f.board, null);
  }
  if (s.phase === 'complete') assert.ok(s.fixtures.filter((f) => f.stage !== 'league').every((f) => f.status === 'done'));
  if (s.config.finalAlone) {
    const final = T.fixtureById(s, 'F');
    if (final && final.status === 'live') assert.equal(live.length, 1, 'final played alone');
  }
}

function randomAction(s, rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const f = pick(s.fixtures.length ? s.fixtures : [{ id: 'none' }]);
  const t = () => pick(s.teams).id;
  const actions = [
    () => T.startMatch(s, f.id, pick([1, 2])),
    () => T.adjustLegs(s, f.id, pick(['home', 'away']), pick([1, 1, 1, -1])),
    () => T.finishMatch(s, f.id),
    () => T.cancelMatch(s, f.id),
    () => T.editResult(s, f.id, Math.floor(rand() * 3), Math.floor(rand() * 3)),
    () => T.unplayMatch(s, f.id),
    () => T.moveFixture(s, f.id, pick([-1, 1])),
    () => T.moveFixtureTo(s, f.id, 1 + Math.floor(rand() * 10)),
    () => T.playNext(s, f.id),
    () => T.swapHomeAway(s, f.id),
    () => T.removeFixture(s, f.id),
    () => T.addFixture(s, t(), t()),
    () => T.updateFixture(s, f.id, { homeId: t(), awayId: t() }),
    () => T.startKnockout(s, knockoutSeeding(T.standings(s)).seeds, { force: rand() < 0.3 }),
    () => T.backToLeague(s),
    () => T.updateConfig(s, { thirdPlace: rand() < 0.5 }),
    () => T.updateConfig(s, { bestOf: { final: pick([1, 3, 5]) } }),
  ];
  // Bias towards progress so runs reach the knockout.
  const next = T.nextUp(s);
  for (const b of [1, 2]) if (!T.liveOnBoard(s, b) && next[b] && rand() < 0.5) return T.startMatch(s, next[b].id, b);
  const decided = T.liveFixtures(s).find((x) => T.matchIsDecided(s, x.id));
  if (decided && rand() < 0.6) return T.finishMatch(s, decided.id);
  return pick(actions)();
}

for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  test(`random action sequence keeps invariants (seed ${seed})`, () => {
    const rand = seededRandom(seed);
    let s = loadDemoTeams(T.createTournament({ doubleRoundRobin: seed % 2 === 0, thirdPlace: seed % 3 === 0 }), 4 + (seed % 5));
    s = T.startLeague(s);
    let errors = 0;
    for (let i = 0; i < 1500; i++) {
      try {
        s = randomAction(s, rand);
      } catch (e) {
        assert.ok(e instanceof Error && e.message.length > 0, 'actions fail with a readable message');
        errors++;
      }
      checkInvariants(s);
    }
    assert.ok(errors > 0, 'invalid actions were exercised');
  });
}
