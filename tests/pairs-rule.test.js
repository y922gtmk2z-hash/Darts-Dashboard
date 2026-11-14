// "2 on, 1 off": every team plays 2 matches in a row, then rests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { planBlocks, scoreBlocks, idealRest } from '../js/logic/blocks.js';
import { loadDemoTeams, simulateUntil, simulateStep } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const slotsOf = (matches) => {
  const by = new Map();
  for (const m of matches) by.set(m.round, [...(by.get(m.round) ?? []), m]);
  return [...by.keys()].sort((a, b) => a - b).map((k) => by.get(k));
};
const pattern = (slots, t) => slots.map((sl) => (sl.some((m) => m.homeId === t || m.awayId === t) ? 'X' : '.')).join('');

test('6 teams, twice each: exactly 2 on, 1 off for everyone, both boards always busy', () => {
  const { matches, quality } = planBlocks(ids(6), { double: true });
  assert.equal(matches.length, 30);
  assert.equal(quality.score, 0);
  const slots = slotsOf(matches);
  assert.ok(slots.every((sl) => sl.length === 2));
  for (const t of ids(6)) {
    const p = pattern(slots, t).replace(/^\.+|\.+$/g, '');
    // Allowed: one single anywhere (the start needs it), otherwise XX.XX.XX…
    assert.ok(!/XXX/.test(p), `${t}: ${p}`);
    assert.ok(!/\.\./.test(p), `${t} rests more than 1: ${p}`);
    // One single is allowed, plus a single as the team's very last match.
    const singles = (p.replace(/\.X$/, '').match(/(^|\.)X(?=\.|$)/g) ?? []).length;
    assert.ok(singles <= 1, `${t} singles: ${p}`);
  }
});

for (const n of [7, 8, 9, 10, 12, 16]) {
  for (const double of [true, false]) {
    test(`${n} teams, ${double ? 'twice' : 'once'}: nobody plays 3 in a row, matches in pairs, rest ≥ 1`, () => {
      const { matches, quality } = planBlocks(ids(n), { double });
      assert.equal(matches.length, ((n * (n - 1)) / 2) * (double ? 2 : 1));
      assert.equal(quality.tooMany, 0);
      assert.equal(quality.extraSingles, 0);
      const slots = slotsOf(matches);
      for (const sl of slots) assert.equal(new Set(sl.flatMap((m) => [m.homeId, m.awayId])).size, sl.length * 2, 'no team on both boards at once');
      if (double) {
        const boards = new Map();
        for (const m of matches) { const k = [m.homeId, m.awayId].sort().join(); boards.set(k, [...(boards.get(k) ?? []), m.plannedBoard].sort()); }
        for (const b of boards.values()) assert.deepEqual(b, [1, 2], 'each pair once on each board');
      }
    });
  }
}

test('ideal rest grows with the league size', () => {
  assert.deepEqual([6, 8, 10, 12, 16].map(idealRest), [1, 2, 3, 4, 6]);
});

test('switching the rule on: fixtures, report, and boards wait for their planned match', () => {
  let s = loadDemoTeams(T.createTournament({ fixtureRule: 'pairs' }), 6);
  s = T.startLeague(s);
  const report = T.pairsRuleReport(s);
  assert.equal(report.ok, true);
  assert.deepEqual(report.threeInRow, []);
  // Start slot 1 on both boards, finish Board 1 only: Board 1's next match
  // includes a team still playing on Board 2, so Board 1 waits.
  let next = T.nextUp(s);
  s = T.startMatch(T.startMatch(s, next[1].id, 1), next[2].id, 2);
  const b1 = T.liveOnBoard(s, 1);
  s = T.finishMatch(T.adjustLegs(T.adjustLegs(s, b1.id, 'home', 1), b1.id, 'home', 1), b1.id);
  next = T.nextUp(s);
  const live2 = T.liveOnBoard(s, 2);
  const queue1 = T.upcoming(s).filter((f) => f.plannedBoard === 1);
  if ([queue1[0].homeId, queue1[0].awayId].some((t) => t === live2.homeId || t === live2.awayId)) {
    assert.equal(next[1], null);
    assert.equal(next.waiting[1].id, queue1[0].id);
  } else {
    assert.equal(next[1].id, queue1[0].id, 'never jumps ahead of the planned order');
  }
});

test('a "2 on, 1 off" league plays through to a champion, keeping the rule', () => {
  for (const n of [6, 8]) {
    let s = loadDemoTeams(T.createTournament({ fixtureRule: 'pairs' }), n);
    s = simulateUntil(s, (x) => x.phase === 'complete', seededRandom(n));
    assert.equal(s.phase, 'complete');
    assert.equal(T.pairsRuleReport(s).tooMany, 0, `${n} teams`);
  }
});

test('balancing boards in "2 on, 1 off" keeps each time slot\'s matches together', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament({ fixtureRule: 'pairs' }), 8));
  for (const f of T.upcoming(s).slice(0, 6)) s = T.setFixtureBoard(s, f.id, 1);
  assert.equal(T.pairsRuleReport(s).ok, false);
  s = T.autoAssignBoards(s);
  assert.equal(T.pairsRuleReport(s).ok, true);
  assert.equal(T.leagueBalance(s).notOnBothBoards.length, 0);
});

test('the rule is off by default and reports nothing', () => {
  const s = T.startLeague(loadDemoTeams(T.createTournament(), 6));
  assert.equal(s.config.fixtureRule, 'spread');
  assert.equal(T.pairsRuleReport(s), null);
});
