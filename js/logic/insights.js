// Insights for the TV: what's at stake, the race for the semi-finals, the
// position chart, head-to-head, averages and records. Pure: derived from the
// tournament state, never stored.
import { computeStandings } from './standings.js';
import { legsToWinFor } from './config.js';

const byFinish = (a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || a.order - b.order;
const nameOf = (state, id) => state.teams.find((t) => t.id === id)?.name ?? '?';
const winnerId = (f) => (f.homeLegs > f.awayLegs ? f.homeId : f.awayId);
const loserId = (f) => (f.homeLegs > f.awayLegs ? f.awayId : f.homeId);
const plays = (f, id) => f.homeId === id || f.awayId === id;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round2 = (n) => Math.round(n * 100) / 100;

/** Finished league matches in the order they were played. */
export const finishedLeague = (state) =>
  state.fixtures.filter((f) => f.stage === 'league' && f.status === 'done').sort(byFinish);

/** Every finished match (all stages) in the order they were played. */
const finishedAll = (state) => state.fixtures.filter((f) => f.status === 'done').sort(byFinish);

// ---------------------------------------------------------------- race for the semi-finals

/**
 * Mathematical qualification from finished league matches only.
 * Returns Map teamId -> { status: 'in' | 'out' | 'alive', needs, remaining }.
 * - 'in': can't finish below the qualifying places whatever happens.
 * - 'out': can't reach them.
 * - needs: wins (of the team's remaining league matches) that make sure of a
 *   place whatever else happens, or null if no number of wins guarantees it.
 * Deliberately cautious: a tie on points is never assumed to go our way.
 */
export function qualificationStatus(state, fixtures = state.fixtures) {
  const Q = state.config.qualifiers;
  const win = state.config.points?.win ?? 3;
  const loss = state.config.points?.loss ?? 0;
  const rows = computeStandings(state.teams, fixtures, state.config);
  const left = fixtures.filter((f) => f.stage === 'league' && f.status !== 'done');
  const out = new Map();
  const leagueOver = left.length === 0 && fixtures.some((f) => f.stage === 'league');

  const info = rows.map((r) => {
    const remaining = left.filter((f) => plays(f, r.teamId)).length;
    return { r, remaining, min: r.points + remaining * loss, max: r.points + remaining * win };
  });

  for (const x of info) {
    const others = info.filter((o) => o !== x);
    let status;
    let needs = null;
    if (state.teams.length <= Q) status = 'in';
    else if (leagueOver) status = x.r.position <= Q ? 'in' : 'out';
    else if (others.filter((o) => o.min > x.max).length >= Q) status = 'out';
    else if (others.filter((o) => o.max >= x.min).length <= Q - 1) status = 'in';
    else {
      status = 'alive';
      for (let k = 1; k <= x.remaining; k++) {
        const p = x.r.points + k * win + (x.remaining - k) * loss;
        if (others.filter((o) => o.max >= p).length <= Q - 1) { needs = k; break; }
      }
    }
    out.set(x.r.teamId, { status, needs, remaining: x.remaining });
  }
  return out;
}

// ---------------------------------------------------------------- what's at stake

/** The fixture list with `f` finished in favour of `side`, keeping the loser's legs. */
function withResult(state, f, side) {
  const need = legsToWinFor(state.config, f.stage);
  const homeWins = side === 'home';
  const loserLegs = Math.min(homeWins ? f.awayLegs : f.homeLegs, need - 1);
  return state.fixtures.map((x) => (x.id !== f.id ? x : {
    ...x,
    status: 'done',
    homeLegs: homeWins ? need : loserLegs,
    awayLegs: homeWins ? loserLegs : need,
    finishedAt: Number.MAX_SAFE_INTEGER,
  }));
}

export const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * What a match means for the table. Returns { lines, sides } where `lines`
 * are short sentences for the TV, most dramatic first, and `sides` holds
 * { teamId, now, ifWin, ifLose } positions (league matches only).
 * Positions count other matches being played as they stand.
 */
export function matchStakes(state, f) {
  if (!f?.homeId || !f?.awayId) return { lines: [], sides: [] };
  if (f.stage === 'semi') return { lines: ['The winner goes through to the final'], sides: [] };
  if (f.stage === 'final') return { lines: ['Winner takes the title'], sides: [] };
  if (f.stage === 'third') return { lines: ['Playing for third place'], sides: [] };

  const Q = state.config.qualifiers;
  const live = { includeLive: true };
  const without = state.fixtures.map((x) => (x.id === f.id ? { ...x, status: 'scheduled', homeLegs: 0, awayLegs: 0 } : x));
  const pos = (fixtures) => new Map(computeStandings(state.teams, fixtures, state.config, live).map((r) => [r.teamId, r.position]));
  const now = pos(without);
  const homeWin = withResult(state, f, 'home');
  const awayWin = withResult(state, f, 'away');
  const ifHomeWins = pos(homeWin);
  const ifAwayWins = pos(awayWin);
  const before = qualificationStatus(state);
  const afterHome = qualificationStatus(state, homeWin);
  const afterAway = qualificationStatus(state, awayWin);

  const sides = [];
  const found = [];
  for (const side of ['home', 'away']) {
    const id = side === 'home' ? f.homeId : f.awayId;
    const winMap = side === 'home' ? ifHomeWins : ifAwayWins;
    const loseMap = side === 'home' ? ifAwayWins : ifHomeWins;
    const afterWin = (side === 'home' ? afterHome : afterAway).get(id);
    const afterLose = (side === 'home' ? afterAway : afterHome).get(id);
    const s = { teamId: id, now: now.get(id), ifWin: winMap.get(id), ifLose: loseMap.get(id) };
    sides.push(s);
    const name = nameOf(state, id);
    const was = before.get(id)?.status;
    const add = (score, text) => found.push({ score, text, now: s.now });
    if (was === 'alive' && afterWin?.status === 'in') add(6, `A win seals a semi-final place for ${name}`);
    if (was === 'alive' && afterLose?.status === 'out') add(5, `${name} are out if they lose`);
    if (s.ifWin === 1 && s.now !== 1) add(4, `${name} go top with a win`);
    else if (s.now === 1 && s.ifLose > 1) add(3, `${name} lose top spot if they lose`);
    else if (s.now === 1) add(0.5, `${name} stay top whatever happens`);
    if (s.ifWin < s.now && s.ifWin !== 1) add(0.2 + (s.now - s.ifWin) / 100, `A win lifts ${name} to ${ordinal(s.ifWin)}`);
    if (state.teams.length > Q && was !== 'in' && was !== 'out') {
      if (s.ifWin <= Q && s.now > Q) add(2, `A win takes ${name} into the top ${Q}`);
      if (s.ifLose > Q && s.now <= Q) add(1, `${name} drop out of the top ${Q} if they lose`);
    }
  }
  found.sort((a, b) => b.score - a.score || a.now - b.now);
  const lines = found.map((x) => x.text);
  if (!lines.length) {
    const h = sides[0];
    const a = sides[1];
    lines.push(`With a win: ${nameOf(state, h.teamId)} ${ordinal(h.ifWin)} · ${nameOf(state, a.teamId)} ${ordinal(a.ifWin)}`);
  }
  return { lines, sides };
}

// ---------------------------------------------------------------- position history

const historyCache = { key: '', value: null };

/**
 * League position of every team after each finished league match.
 * Returns { fixtures, steps } where steps[i] is a Map teamId -> position
 * after fixtures[i]. Cached on the finished results.
 */
export function positionHistory(state) {
  const done = finishedLeague(state);
  const key = `${state.teams.map((t) => t.id + t.name).join()}|${JSON.stringify(state.config.points)}|${done.map((f) => `${f.id}:${f.homeLegs}-${f.awayLegs}`).join()}`;
  if (historyCache.key === key) return historyCache.value;
  const steps = done.map((_, i) => new Map(computeStandings(state.teams, done.slice(0, i + 1), state.config).map((r) => [r.teamId, r.position])));
  const value = { fixtures: done, steps };
  historyCache.key = key;
  historyCache.value = value;
  return value;
}

// ---------------------------------------------------------------- head-to-head

/** League matches between each pair: Map "a|b" -> fixtures (ordered), both key orders. */
export function headToHead(state) {
  const map = new Map();
  for (const f of state.fixtures.filter((x) => x.stage === 'league' && x.homeId && x.awayId).sort((a, b) => a.order - b.order)) {
    for (const k of [`${f.homeId}|${f.awayId}`, `${f.awayId}|${f.homeId}`]) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(f);
    }
  }
  return map;
}

// ---------------------------------------------------------------- matchup preview

/** Table position, points and form of both teams, plus their last meeting. */
export function matchupPreview(state, f) {
  const rows = new Map(computeStandings(state.teams, state.fixtures, state.config, { includeLive: true }).map((r) => [r.teamId, r]));
  const side = (id) => {
    const r = rows.get(id);
    return r ? { teamId: id, position: r.position, points: r.points, played: r.played, form: r.form } : null;
  };
  const last = finishedAll(state).filter((x) => plays(x, f.homeId) && plays(x, f.awayId)).pop() ?? null;
  return { home: side(f.homeId), away: side(f.awayId), last };
}

// ---------------------------------------------------------------- averages

/**
 * 3-dart averages over every finished match (all stages).
 * bestMatch: highest single-match averages; season: each team's mean;
 * improved: biggest rise of the last 3 recorded over the earlier ones (needs 5+).
 */
export function averagesBoard(state, { top = 5 } = {}) {
  const entries = [];
  for (const f of finishedAll(state)) {
    for (const side of ['home', 'away']) {
      const avg = f[`${side}Avg`];
      if (typeof avg === 'number') entries.push({ teamId: f[`${side}Id`], avg, fixture: f });
    }
  }
  const bestMatch = [...entries].sort((a, b) => b.avg - a.avg).slice(0, top);
  const perTeam = new Map();
  for (const e of entries) {
    if (!perTeam.has(e.teamId)) perTeam.set(e.teamId, []);
    perTeam.get(e.teamId).push(e.avg);
  }
  const season = [...perTeam].map(([teamId, xs]) => ({ teamId, avg: round2(mean(xs)), count: xs.length }))
    .sort((a, b) => b.avg - a.avg).slice(0, top);
  const improved = [...perTeam].filter(([, xs]) => xs.length >= 5).map(([teamId, xs]) => {
    const recent = round2(mean(xs.slice(-3)));
    const earlier = round2(mean(xs.slice(0, -3)));
    return { teamId, recent, earlier, change: round2(recent - earlier) };
  }).filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, 3);
  return { bestMatch, season, improved, count: entries.length };
}

// ---------------------------------------------------------------- streaks & records

/**
 * Win streaks (all stages), whitewashes and the biggest league upset.
 * - streaks: Map teamId -> { current, longest } (consecutive wins)
 * - longest: the best run(s) so far, { teamIds, length }
 * - hot: teams on 3+ wins in a row now, longest first
 * - whitewashes: wins without dropping a leg (only when a match is more than one leg)
 * - upset: league win with the biggest gap in table position beforehand
 *   (both teams had played at least 2 league matches), or null
 */
export function records(state) {
  const streaks = new Map(state.teams.map((t) => [t.id, { current: 0, longest: 0 }]));
  const sweeps = new Map();
  for (const f of finishedAll(state)) {
    const w = winnerId(f);
    const l = loserId(f);
    const sw = streaks.get(w);
    const sl = streaks.get(l);
    if (sw) { sw.current++; sw.longest = Math.max(sw.longest, sw.current); }
    if (sl) sl.current = 0;
    if (Math.min(f.homeLegs, f.awayLegs) === 0 && Math.max(f.homeLegs, f.awayLegs) >= 2) sweeps.set(w, (sweeps.get(w) ?? 0) + 1);
  }
  const best = Math.max(0, ...[...streaks.values()].map((s) => s.longest));
  const longest = { length: best, teamIds: best ? [...streaks].filter(([, s]) => s.longest === best).map(([id]) => id) : [] };
  const hot = [...streaks].filter(([, s]) => s.current >= 3).map(([teamId, s]) => ({ teamId, length: s.current }))
    .sort((a, b) => b.length - a.length);
  const whitewashes = [...sweeps].map(([teamId, count]) => ({ teamId, count })).sort((a, b) => b.count - a.count);

  const { fixtures, steps } = positionHistory(state);
  const playedBefore = new Map();
  let upset = null;
  fixtures.forEach((f, i) => {
    const w = winnerId(f);
    const l = loserId(f);
    if (i > 0 && (playedBefore.get(w) ?? 0) >= 2 && (playedBefore.get(l) ?? 0) >= 2) {
      const wp = steps[i - 1].get(w);
      const lp = steps[i - 1].get(l);
      if (wp - lp > 0 && (!upset || wp - lp > upset.gap)) upset = { fixture: f, winnerId: w, loserId: l, winnerPos: wp, loserPos: lp, gap: wp - lp };
    }
    for (const id of [f.homeId, f.awayId]) playedBefore.set(id, (playedBefore.get(id) ?? 0) + 1);
  });
  return { streaks, longest, hot, whitewashes, upset };
}
