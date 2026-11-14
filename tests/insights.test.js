import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/logic/insights.js';
import * as T from '../js/logic/tournament.js';
import { loadDemoTeams, simulateUntil } from '../js/logic/simulate.js';
import { seededRandom } from '../js/logic/util.js';
import { config, teams, result } from './helpers.js';

const state = (names, fixtures) => ({ config, teams: teams(...names), fixtures, phase: 'league' });
const pending = (homeId, awayId, extra = {}) => ({ ...result(homeId, awayId, 0, 0), status: 'scheduled', ...extra });

test('qualification: clinched, eliminated and wins needed', () => {
  // 6 teams, top 4 qualify. A has 9 pts, F has 0 with one match left.
  const fx = [
    result('A', 'F', 2, 0), result('A', 'E', 2, 0), result('A', 'D', 2, 0),
    result('B', 'F', 2, 0), result('C', 'F', 2, 0), result('D', 'F', 2, 0),
    result('B', 'E', 2, 0), result('C', 'E', 2, 0),
    pending('E', 'F'), pending('B', 'C'), pending('D', 'E'),
  ];
  const q = I.qualificationStatus(state(['A', 'B', 'C', 'D', 'E', 'F'], fx));
  // A: 9 pts, nobody but B/C/D can reach 9 → at most 3 above → in.
  assert.equal(q.get('A').status, 'in');
  // F: max 3, and A,B,C,D already have ≥ 3 points... only strictly more counts: A 9, B 6, C 6, D 3 → 3 strictly above → alive.
  assert.equal(q.get('F').status, 'alive');
  assert.equal(q.get('F').needs, null);
  // E: 0 pts, two left (max 6). A 9 > 6, B 6, C 6 not strictly → alive.
  assert.equal(q.get('E').status, 'alive');
});

test('qualification: out when Q teams are already beyond reach', () => {
  const fx = [
    result('A', 'E', 2, 0), result('B', 'E', 2, 0), result('C', 'E', 2, 0), result('D', 'E', 2, 0),
    result('A', 'B', 2, 0), result('B', 'C', 2, 0), result('C', 'D', 2, 0), result('D', 'A', 2, 0),
    pending('E', 'A'),
  ];
  const q = I.qualificationStatus(state(['A', 'B', 'C', 'D', 'E'], fx));
  assert.equal(q.get('E').status, 'out'); // max 3; A, B, C and D all have 6
  assert.equal(q.get('A').status, 'in');
});

test('qualification: league over → by position', () => {
  const fx = [result('A', 'B', 2, 0), result('C', 'D', 2, 0), result('E', 'A', 2, 1)];
  const q = I.qualificationStatus(state(['A', 'B', 'C', 'D', 'E'], fx));
  const ins = [...q].filter(([, v]) => v.status === 'in').length;
  assert.equal(ins, 4);
  assert.equal([...q].filter(([, v]) => v.status === 'out').length, 1);
});

test('qualification: needs counts wins that guarantee a place', () => {
  // 5 teams; A 3 pts with 2 left; others: B 3, C 0, D 0, E 0 with some left.
  const fx = [
    result('A', 'C', 2, 0), result('B', 'D', 2, 0),
    pending('A', 'D'), pending('A', 'E'), pending('B', 'C'), pending('C', 'E'), pending('D', 'E'),
  ];
  const q = I.qualificationStatus(state(['A', 'B', 'C', 'D', 'E'], fx));
  // Two more wins → 9; others' max: B 6, C 6, D 6, E 9 → only E can tie → in.
  assert.equal(q.get('A').status, 'alive');
  assert.equal(q.get('A').needs, 2);
});

test('stakes: a win takes a team top / into the top 4', () => {
  const fx = [
    result('A', 'B', 2, 0), result('C', 'D', 2, 0), result('A', 'E', 2, 0), result('C', 'E', 2, 1),
    { ...pending('B', 'C'), status: 'live', homeLegs: 1, awayLegs: 0, board: 1 },
    pending('D', 'E'), pending('B', 'D'), pending('A', 'D'),
  ];
  const s = state(['A', 'B', 'C', 'D', 'E'], fx);
  const st = I.matchStakes(s, fx[4]);
  assert.equal(st.sides.length, 2);
  const c = st.sides.find((x) => x.teamId === 'C');
  assert.equal(c.ifWin, 1);
  assert.ok(st.lines.some((l) => /C go top with a win/.test(l)), st.lines.join(' | '));
});

test('stakes: knockout lines', () => {
  assert.deepEqual(I.matchStakes({ config, teams: [], fixtures: [] }, { stage: 'final', homeId: 'A', awayId: 'B' }).lines, ['Winner takes the title']);
  assert.deepEqual(I.matchStakes({ config, teams: [], fixtures: [] }, { stage: 'semi', homeId: null, awayId: 'B' }).lines, []);
});

test('stakes always say something for a league match', () => {
  let s = T.startLeague(loadDemoTeams(T.createTournament(), 8));
  s = simulateUntil(s, (x) => T.leagueProgress(x).played >= 30, seededRandom(3));
  for (const f of T.liveFixtures(s)) {
    const st = I.matchStakes(s, f);
    assert.ok(st.lines.length >= 1);
    assert.ok(st.sides.every((x) => x.ifWin <= x.ifLose));
  }
});

test('position history: one step per finished league match', () => {
  const fx = [result('A', 'B', 2, 0), result('B', 'C', 2, 0), result('C', 'A', 2, 0)];
  const h = I.positionHistory(state(['A', 'B', 'C'], fx));
  assert.equal(h.steps.length, 3);
  assert.equal(h.steps[0].get('A'), 1);
  assert.equal(h.steps[0].get('B'), 3);
});

test('records: streaks, whitewashes and the biggest upset', () => {
  const fx = [
    result('A', 'D', 2, 0), result('B', 'C', 2, 1), result('A', 'C', 2, 0), result('B', 'D', 2, 1),
    result('A', 'B', 2, 1), result('C', 'D', 2, 0),
    result('D', 'A', 2, 1), // D (4th) beats A (1st)
    result('A', 'B', 2, 0, 'semi'),
  ];
  const r = I.records(state(['A', 'B', 'C', 'D'], fx));
  assert.deepEqual(r.longest, { length: 3, teamIds: ['A'] });
  assert.equal(r.streaks.get('A').current, 1);
  assert.deepEqual(r.hot, []);
  assert.deepEqual(r.whitewashes[0], { teamId: 'A', count: 3 });
  assert.equal(r.upset.winnerId, 'D');
  assert.equal(r.upset.loserId, 'A');
  assert.equal(r.upset.gap, 3);
});

test('averages: best match, season and most improved', () => {
  const withAvg = (f, h, a) => ({ ...f, homeAvg: h, awayAvg: a });
  const fx = [
    withAvg(result('A', 'B', 2, 0), 40, 50),
    withAvg(result('A', 'B', 2, 0), 41, 50),
    withAvg(result('B', 'A', 2, 0), 50, 60),
    withAvg(result('A', 'B', 2, 0), 62, 50),
    withAvg(result('A', 'B', 2, 0), 64, null),
  ];
  const b = I.averagesBoard(state(['A', 'B'], fx));
  assert.equal(b.bestMatch[0].avg, 64);
  assert.equal(b.season[0].teamId, 'A');
  assert.equal(b.season.find((x) => x.teamId === 'B').count, 4);
  assert.equal(b.improved.length, 1);
  assert.equal(b.improved[0].teamId, 'A');
  assert.equal(b.improved[0].change, 62 - 40.5);
});

test('matchup preview finds the last meeting', () => {
  const fx = [result('A', 'B', 2, 1), result('B', 'A', 2, 0), pending('A', 'B')];
  const p = I.matchupPreview(state(['A', 'B'], fx), fx[2]);
  assert.equal(p.last, fx[1]);
  assert.equal(p.home.points, 3);
});

test('head-to-head is keyed both ways', () => {
  const fx = [result('A', 'B', 2, 1), pending('B', 'A')];
  const h = I.headToHead(state(['A', 'B'], fx));
  assert.equal(h.get('A|B').length, 2);
  assert.deepEqual(h.get('B|A'), h.get('A|B'));
});

test('stakes: a climb is preferred over the plain fallback', () => {
  const fx = [
    result('A', 'B', 2, 0), result('A', 'C', 2, 0), result('B', 'C', 2, 0),
    { ...pending('C', 'D'), status: 'live', homeLegs: 0, awayLegs: 0, board: 1 },
  ];
  const st = I.matchStakes(state(['A', 'B', 'C', 'D'], fx), fx[3]);
  assert.ok(!st.lines[0].startsWith('With a win'), st.lines[0]);
});

test('finish estimate: pace of the evening, knockout added, null without data', () => {
  const MIN = 60000;
  const mk = (i, extra) => ({ id: `L${i}`, stage: 'league', round: 1, order: i, homeId: 'A', awayId: 'B', board: null, homeLegs: 2, awayLegs: 0, ...extra });
  // 4 matches finished 10 min apart (two boards) → one board takes 20 min a match.
  const done = [0, 1, 2, 3].map((i) => mk(i + 1, { status: 'done', startedAt: i * 10 * MIN, finishedAt: (i + 1) * 10 * MIN }));
  const todo = [5, 6, 7, 8].map((i) => mk(i, { status: 'scheduled', startedAt: null, finishedAt: null }));
  const s = { config, teams: teams('A', 'B'), phase: 'league', fixtures: [...done, ...todo] };
  assert.equal(I.boardSlot(s), 20 * MIN);
  const e = I.finishEstimate(s, 40 * MIN);
  // 4 league matches on 2 boards = 40 min, semis 20, final 20 (all best of 3).
  assert.equal(e.ms, 80 * MIN);
  assert.equal(e.finishAt, 120 * MIN);
  // Too little data, or results typed in all at once → no estimate.
  assert.equal(I.finishEstimate({ ...s, fixtures: [...done.slice(0, 2), ...todo] }), null);
  const burst = done.map((f, i) => ({ ...f, startedAt: 1000 + i, finishedAt: 2000 + i }));
  assert.equal(I.finishEstimate({ ...s, fixtures: [...burst, ...todo] }), null);
  // Burst entry, but some matches were scored live → median length + 3 min changeover.
  const mixed = [...burst, mk(9, { status: 'done', startedAt: 3000 - 15 * MIN, finishedAt: 3000 }), mk(10, { status: 'done', startedAt: 3001 - 17 * MIN, finishedAt: 3001 })];
  assert.equal(I.boardSlot({ ...s, fixtures: [...mixed, ...todo] }), 19 * MIN);
  // A live match counts for what is left of it.
  const live = mk(5, { status: 'live', startedAt: 35 * MIN, finishedAt: null });
  const e2 = I.finishEstimate({ ...s, fixtures: [...done, live, ...todo.slice(1)] }, 40 * MIN);
  assert.equal(e2.ms, ((15 + 60) / 2 + 40) * MIN);
  assert.equal(I.finishEstimate({ ...s, phase: 'complete' }), null);
});
