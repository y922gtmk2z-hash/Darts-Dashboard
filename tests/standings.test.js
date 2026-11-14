import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStandings } from '../js/logic/standings.js';
import { normalizeConfig } from '../js/logic/config.js';
import { config, teams, result } from './helpers.js';

const order = (rows) => rows.map((r) => r.teamId);

test('empty table is alphabetical with zeros', () => {
  const rows = computeStandings(teams('Charlie', 'alpha', 'Bravo'), [], config);
  assert.deepEqual(order(rows), ['alpha', 'Bravo', 'Charlie']);
  assert.ok(rows.every((r) => r.played === 0 && r.points === 0));
  assert.deepEqual(rows.map((r) => r.position), [1, 2, 3]);
});

test('counts P/W/L/legs/points with 3 for a win, 0 for a loss', () => {
  const rows = computeStandings(teams('A', 'B', 'C'), [result('A', 'B', 2, 1), result('C', 'A', 2, 0)], config);
  const a = rows.find((r) => r.teamId === 'A');
  assert.deepEqual(
    { p: a.played, w: a.won, l: a.lost, lf: a.legsFor, la: a.legsAgainst, ld: a.legDiff, pts: a.points, form: a.form },
    { p: 2, w: 1, l: 1, lf: 2, la: 3, ld: -1, pts: 3, form: ['W', 'L'] },
  );
  assert.deepEqual(order(rows), ['C', 'A', 'B']);
});

test('points are configurable', () => {
  const cfg = normalizeConfig({ points: { win: 2, loss: 1 } });
  const rows = computeStandings(teams('A', 'B'), [result('A', 'B', 2, 0)], cfg);
  assert.deepEqual(rows.map((r) => r.points), [2, 1]);
});

test('ignores scheduled/live matches and knockout matches', () => {
  const live = { ...result('A', 'B', 1, 0), status: 'live' };
  const ko = result('B', 'A', 3, 0, 'semi');
  const rows = computeStandings(teams('A', 'B'), [live, ko], config);
  assert.ok(rows.every((r) => r.played === 0));
});

test('tiebreak 1: leg difference', () => {
  // A and B both one win; A won 2-0, B won 2-1.
  const rows = computeStandings(
    teams('A', 'B', 'C', 'D'),
    [result('A', 'C', 2, 0), result('B', 'D', 2, 1)],
    config,
  );
  assert.deepEqual(order(rows).slice(0, 2), ['A', 'B']);
});

test('tiebreak 2: legs won when points and leg diff equal', () => {
  // A: W 2-1, L 1-2 => +0, legs 3. B: W 2-0, L 0-2 => +0, legs 2.
  const rows = computeStandings(
    teams('A', 'B', 'X', 'Y'),
    [result('A', 'X', 2, 1), result('Y', 'A', 2, 1), result('B', 'X', 2, 0), result('Y', 'B', 2, 0)],
    config,
  );
  const a = rows.findIndex((r) => r.teamId === 'A');
  const b = rows.findIndex((r) => r.teamId === 'B');
  assert.ok(a < b, 'A above B on legs won');
});

test('tiebreak 3: head-to-head when points, leg diff and legs won are equal', () => {
  // Zed beats Abe 2-1; each also loses 1-2 to a third team and beats a fourth 2-1.
  // Both: 2W 1L... make them identical overall except their meeting decides it.
  const fixtures = [
    result('Zed', 'Abe', 2, 1),
    result('Abe', 'P', 2, 1),
    result('P', 'Zed', 2, 1),
  ];
  const rows = computeStandings(teams('Abe', 'Zed', 'P'), fixtures, config);
  // All three: 1W 1L, legs 3-3. Mini-league among all three is circular too, so h2h ties, then name.
  assert.deepEqual(order(rows), ['Abe', 'P', 'Zed']);
  assert.ok(rows[1].tiedWithPrev && rows[2].tiedWithPrev);

  // Two-way tie decided by h2h, against alphabetical order.
  const two = [result('Zed', 'Abe', 2, 1), result('Abe', 'Q', 2, 1), result('Q', 'Zed', 2, 1), result('R', 'Q', 2, 0), result('Q', 'R', 2, 0)];
  // Abe: W(Q 2-1) L(Zed 1-2) => 3 pts, legs 3-3. Zed: W(Abe) L(Q) => 3 pts, 3-3. Q: W(Zed) L(Abe) W(R) L(R) => 6.
  const rows2 = computeStandings(teams('Abe', 'Zed', 'Q', 'R'), two, config);
  const iZed = rows2.findIndex((r) => r.teamId === 'Zed');
  const iAbe = rows2.findIndex((r) => r.teamId === 'Abe');
  assert.ok(iZed < iAbe, 'Zed above Abe on head-to-head');
  assert.equal(rows2[iAbe].tiedWithPrev, false);
});

test('double round robin head-to-head uses both meetings', () => {
  // A and B split their two meetings but A won its win 2-0 and lost 1-2 => h2h legs +1.
  const fixtures = [result('A', 'B', 2, 0), result('B', 'A', 2, 1), result('C', 'A', 2, 1), result('B', 'C', 0, 2), result('A', 'C', 2, 0), result('C', 'B', 1, 2)];
  // A: W 2-0, L 1-2, L 1-2, W 2-0 => 6 pts, legs 6-4. B: L 0-2, W 2-1, L 0-2, W 2-1 => 6 pts, legs 4-6.
  const rows = computeStandings(teams('A', 'B', 'C'), fixtures, config);
  assert.equal(rows[0].teamId, 'A');
});

test('final tiebreak is name, case-insensitive, and flagged', () => {
  const rows = computeStandings(teams('beta', 'Alpha'), [], config);
  assert.deepEqual(order(rows), ['Alpha', 'beta']);
  assert.equal(rows[1].tiedWithPrev, true);
});

test('live table: legs in matches being played count towards +/- and order straight away', async () => {
  const T = await import('../js/logic/tournament.js');
  const { loadDemoTeams } = await import('../js/logic/simulate.js');
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 4));
  const f = T.upcoming(s)[0];
  s = T.startMatch(s, f.id, 1);
  s = T.adjustLegs(s, f.id, 'away', 1);
  const live = T.liveStandings(s);
  const away = live.find((r) => r.teamId === f.awayId);
  const home = live.find((r) => r.teamId === f.homeId);
  assert.deepEqual([away.legDiff, away.legsFor, away.points, away.played, away.live, away.liveLegDiff], [1, 1, 0, 0, true, 1]);
  assert.equal(home.legDiff, -1);
  assert.equal(live[0].teamId, f.awayId, 'leading team goes top on leg difference');
  // The finished-only table (used for knockout seeding) ignores the live match.
  assert.ok(T.standings(s).every((r) => r.legDiff === 0 && !r.live));
  // Once finished, points arrive and the live markers go.
  s = T.finishMatch(T.adjustLegs(s, f.id, 'away', 1), f.id);
  const done = T.liveStandings(s).find((r) => r.teamId === f.awayId);
  assert.deepEqual([done.points, done.played, done.legDiff, done.live], [3, 1, 2, false]);
});
