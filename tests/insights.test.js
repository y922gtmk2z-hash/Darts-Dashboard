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

test('result summary: league move, clinch and knockout wording', () => {
  const fx = [result('A', 'B', 2, 0), result('C', 'D', 2, 0), result('B', 'C', 2, 1)];
  const s = state(['A', 'B', 'C', 'D'], fx);
  const r = I.resultSummary(s, fx[2]);
  assert.equal(r.headline, 'B win 2–1');
  assert.equal(r.detail, 'B stay 3rd · C stay 2nd'); // A and C stay ahead on leg difference
  assert.equal(I.resultSummary(s, { ...result('A', 'B', 1, 2, 'semi') }).detail, 'B are through to the final');
  assert.equal(I.resultSummary(s, { ...result('A', 'B', 2, 0, 'final') }).headline, 'A are the champions!');
});

test('team spotlight: results, averages, next match', () => {
  const fx = [{ ...result('A', 'B', 2, 1), homeAvg: 50, awayAvg: 40 }, { ...result('C', 'A', 2, 0), homeAvg: 55, awayAvg: 45 }, pending('A', 'C')];
  const sp = I.teamSpotlight(state(['A', 'B', 'C'], fx), 'A');
  assert.equal(sp.results.length, 2);
  assert.deepEqual(sp.results.map((r) => r.won), [true, false]);
  assert.deepEqual(sp.averages, [50, 45]);
  assert.equal(sp.next, fx[2]);
  assert.equal(sp.row.points, 3);
});

test('tale of the tape: rows, better side and earlier meetings', () => {
  const fx = [
    { ...result('A', 'B', 2, 0), homeAvg: 60, awayAvg: 40 }, result('B', 'A', 2, 1), result('A', 'C', 2, 0), result('B', 'C', 2, 0),
    result('C', 'D', 2, 0), result('D', 'A', 0, 2),
  ];
  const s = { ...state(['A', 'B', 'C', 'D'], [...fx, { ...pending('A', 'B'), id: 'SF1', stage: 'semi' }]), seeds: ['A', 'B', 'C', 'D'], phase: 'knockout' };
  const tape = I.taleOfTheTape(s, s.fixtures.at(-1));
  assert.deepEqual(tape.seeds, { home: 1, away: 2 });
  const row = (l) => tape.rows.find((r) => r.label === l);
  assert.equal(row('League finish').better, 'home');
  assert.equal(row('3-dart average').home, '60.00');
  assert.equal(row('3-dart average').better, 'home');
  assert.equal(tape.meetings.length, 2);
  assert.deepEqual(tape.meetingsWon, { home: 1, away: 1 });
});

test('tale of the tape for the final: route, stat edge and bar shares', () => {
  const fx = [
    result('A', 'B', 2, 1), result('C', 'D', 2, 0), result('A', 'C', 2, 0), result('B', 'D', 2, 1),
    { ...result('A', 'D', 2, 1), id: 'SF1', stage: 'semi' },
    { ...result('C', 'B', 0, 2), id: 'SF2', stage: 'semi' },
    { ...pending('A', 'B'), id: 'F', stage: 'final' },
  ];
  const s = { ...state(['A', 'B', 'C', 'D'], fx), seeds: ['A', 'B', 'C', 'D'], phase: 'knockout' };
  const tape = I.taleOfTheTape(s, T.fixtureById(s, 'F'));
  assert.equal(tape.route.home.length, 1);
  assert.equal(tape.route.home[0].opponentId, 'D');
  assert.deepEqual([tape.route.home[0].forLegs, tape.route.home[0].againstLegs], [2, 1]);
  assert.equal(tape.route.away[0].opponentId, 'C');
  assert.ok(tape.route.away[0].won);
  assert.equal(tape.edge.home + tape.edge.away, tape.rows.filter((r) => r.better).length);
  const won = tape.rows.find((r) => r.label === 'Won – lost');
  assert.equal(won.share, 3 / 5); // all stages: A won 2 league + SF1, B 1 league + SF2
  assert.equal(tape.rows.find((r) => r.label === 'League finish').share, null);
  assert.equal(tape.meetings.length, 1);
});

test('form and stats count knockout matches; the league table does not', () => {
  const fx = [
    result('A', 'B', 2, 1), result('C', 'D', 2, 0), result('A', 'C', 2, 0), result('B', 'D', 2, 1),
    { ...result('A', 'D', 0, 2), homeAvg: 40, awayAvg: 90, id: 'SF1', stage: 'semi' },
    { ...result('C', 'B', 0, 2), id: 'SF2', stage: 'semi' },
    { ...pending('D', 'B'), id: 'F', stage: 'final' },
  ];
  const s = { ...state(['A', 'B', 'C', 'D'], fx), seeds: ['A', 'B', 'C', 'D'], phase: 'knockout' };
  const o = I.overallRecords(s);
  assert.deepEqual(o.get('A').form, ['W', 'W', 'L']);
  assert.equal(o.get('A').played, 3);
  assert.equal(o.get('A').legDiff, (2 - 1) + (2 - 0) + (0 - 2));
  assert.equal(o.get('D').avg, 90);
  // Tale of the tape for the final uses the overall record and form.
  const tape = I.taleOfTheTape(s, T.fixtureById(s, 'F'));
  assert.equal(tape.rows.find((r) => r.label === 'Won – lost').home, '1–2'); // D: lost twice in the league, won SF1
  assert.deepEqual(tape.form.home, ['L', 'L', 'W']);
  // Spotlight carries the overall record next to the league row.
  const sp = I.teamSpotlight(s, 'D');
  assert.equal(sp.overall.won, 1);
  assert.equal(sp.row.won, 0);
  // A seed-4 win over seed 1 in the semis is the biggest upset.
  const up = I.records(s).upset;
  assert.equal(up.fixture.id, 'SF1');
  assert.equal(up.gap, 3);
});
