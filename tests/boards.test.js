import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/tournament.js';
import { generateLeagueFixtures, sideBySideClashes, backToBackCount } from '../js/logic/fixtures.js';
import { loadDemoTeams, simulateUntil } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
const pairKey = (f) => [f.homeId, f.awayId].sort().join('|');

for (let n = 4; n <= 16; n++) {
  test(`twice each, ${n} teams: every pair plays once on Board 1 and once on Board 2`, () => {
    const f = generateLeagueFixtures(ids(n), { double: true });
    const byPair = new Map();
    for (const x of f) byPair.set(pairKey(x), [...(byPair.get(pairKey(x)) ?? []), x.plannedBoard]);
    assert.equal(byPair.size, (n * (n - 1)) / 2);
    for (const boards of byPair.values()) assert.deepEqual(boards.sort(), [1, 2]);
    // ...so every team plays exactly half its matches on each board.
    for (const t of ids(n)) {
      const mine = f.filter((x) => x.homeId === t || x.awayId === t);
      assert.equal(mine.filter((x) => x.plannedBoard === 1).length, n - 1);
      assert.equal(mine.filter((x) => x.plannedBoard === 2).length, n - 1);
    }
    // The k-th match on each board run side by side: never the same team on both.
    assert.equal(sideBySideClashes(f), 0);
    if (n >= 8) assert.equal(backToBackCount(f, 2), 0, 'full rest between matches');
  });

  test(`once each, ${n} teams: each team at most one match off an even board split, no side-by-side clash`, () => {
    const f = generateLeagueFixtures(ids(n), { double: false });
    // With 4 teams every round uses all four on the two boards, which forces one team to 3–0.
    const allowed = n === 4 ? 3 : 2;
    for (const t of ids(n)) {
      const mine = f.filter((x) => x.homeId === t || x.awayId === t);
      const b1 = mine.filter((x) => x.plannedBoard === 1).length;
      assert.ok(Math.abs(b1 - (mine.length - b1)) <= allowed, `${t}: ${b1} v ${mine.length - b1}`);
    }
    assert.equal(sideBySideClashes(f), 0);
  });
}

test('each board suggests the next match from its own queue', () => {
  const s = T.startLeague(loadDemoTeams(T.createTournament(), 8));
  const next = T.nextUp(s);
  assert.equal(next[1].plannedBoard, 1);
  assert.equal(next[2].plannedBoard, 2);
  assert.equal(next[1].id, T.upcoming(s).find((f) => f.plannedBoard === 1).id);
});

test('a board with nothing left in its own queue borrows from the other', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 4), { manual: true });
  s = T.addFixturesBulk(s, 'Double Trouble v The Bullseyes (Board 1)\nTreble Makers v Arrows of Fury (Board 1)').state;
  const next = T.nextUp(s);
  assert.equal(next[1].plannedBoard, 1);
  assert.ok(next[2], 'board 2 is not left idle');
});

test('organiser can set, change and clear the board of an unplayed match', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 6));
  const f = T.upcoming(s)[0];
  s = T.setFixtureBoard(s, f.id, 2);
  assert.equal(T.fixtureById(s, f.id).plannedBoard, 2);
  s = T.setFixtureBoard(s, f.id, null);
  assert.equal(T.fixtureById(s, f.id).plannedBoard, null);
  assert.throws(() => T.setFixtureBoard(s, f.id, 3), /Board must/);
  s = T.updateFixture(s, f.id, { homeId: f.homeId, awayId: f.awayId, board: 1 });
  assert.equal(T.fixtureById(s, f.id).plannedBoard, 1);
  s = T.startMatch(s, f.id, 2); // started on the other board after all
  assert.equal(T.fixtureById(s, f.id).plannedBoard, 2, 'records where it was really played');
  assert.throws(() => T.setFixtureBoard(s, f.id, 1), /not started/);
});

test('adding a match puts a pair\'s second meeting on the other board', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 4), { manual: true });
  const [a, b] = s.teams.map((t) => t.id);
  s = T.addFixture(s, a, b, { board: 2 });
  s = T.addFixture(s, b, a);
  assert.deepEqual(s.fixtures.map((f) => f.plannedBoard), [2, 1]);
});

test('pasted fixture lists can name the board', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 4), { manual: true });
  const r = T.addFixturesBulk(s, [
    'Double Trouble v The Bullseyes (Board 2)',
    'Treble Makers vs Arrows of Fury [B1]',
    'Double Trouble - Treble Makers on board 1',
    'The Bullseyes v Arrows of Fury',
  ].join('\n'));
  assert.equal(r.added, 4);
  assert.deepEqual(r.state.fixtures.map((f) => f.plannedBoard).slice(0, 3), [2, 1, 1]);
  assert.ok([1, 2].includes(r.state.fixtures[3].plannedBoard), 'unnamed board is picked automatically');
});

test('fixture check flags pairs not on both boards; auto-assign fixes it', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 6));
  assert.equal(T.leagueBalance(s).notOnBothBoards.length, 0);
  assert.equal(T.leagueBalance(s).boardsEven, true);
  for (const f of T.upcoming(s).slice(0, 10)) s = T.setFixtureBoard(s, f.id, 1);
  assert.ok(T.leagueBalance(s).notOnBothBoards.length > 0);
  s = T.autoAssignBoards(s);
  const b = T.leagueBalance(s);
  assert.equal(b.notOnBothBoards.length, 0);
  assert.equal(b.boardsEven, true);
});

test('regenerating unplayed matches keeps "once on each board" after some are played', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 6));
  s = simulateUntil(s, (x) => T.leagueProgress(x).played >= 7 && !T.liveFixtures(x).length, seededRandom(2));
  s = T.regenerateUnplayed(T.clearUnplayedFixtures(s));
  const b = T.leagueBalance(s);
  assert.equal(b.complete, true);
  assert.equal(b.notOnBothBoards.length, 0);
});

test('old saved tournaments without planned boards still work (either board)', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 6));
  const raw = JSON.parse(JSON.stringify(s));
  for (const f of raw.fixtures) delete f.plannedBoard;
  s = T.normalizeState(raw);
  assert.ok(s.fixtures.every((f) => f.plannedBoard === null));
  const next = T.nextUp(s);
  assert.ok(next[1] && next[2]);
  assert.equal(simulateUntil(s, (x) => x.phase === 'complete', seededRandom(5)).phase, 'complete');
});

test('reordering within one board\'s queue leaves the other board alone', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 8));
  const b1 = () => T.upcoming(s).filter((f) => f.plannedBoard === 1).map((f) => f.id);
  const b2Before = T.upcoming(s).filter((f) => f.plannedBoard === 2).map((f) => f.id);
  const [first, second, third] = b1();
  s = T.moveFixture(s, first, 1, { sameBoard: true });
  assert.deepEqual(b1().slice(0, 2), [second, first]);
  s = T.playNext(s, third, { sameBoard: true });
  assert.equal(b1()[0], third);
  assert.deepEqual(T.upcoming(s).filter((f) => f.plannedBoard === 2).map((f) => f.id), b2Before);
  assert.equal(T.nextUp(s)[1].id, third);
});
