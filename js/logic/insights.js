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

// ---------------------------------------------------------------- record over every stage

/**
 * Each team's record over every finished match, league and knockout:
 * Map teamId -> { played, won, lost, legsFor, legsAgainst, legDiff, avg, avgCount, form }.
 * form: the last 5 results (oldest first) across all stages. The league table
 * itself stays league-only (it decides the seeding); this is for form and stats.
 */
export function overallRecords(state) {
  const out = new Map(state.teams.map((t) => [t.id, { teamId: t.id, played: 0, won: 0, lost: 0, legsFor: 0, legsAgainst: 0, legDiff: 0, avg: null, avgCount: 0, avgSum: 0, form: [] }]));
  for (const f of finishedAll(state)) {
    for (const side of ['home', 'away']) {
      const r = out.get(f[`${side}Id`]);
      if (!r) continue;
      const mine = side === 'home' ? f.homeLegs : f.awayLegs;
      const theirs = side === 'home' ? f.awayLegs : f.homeLegs;
      r.played++;
      r.legsFor += mine;
      r.legsAgainst += theirs;
      if (mine > theirs) r.won++;
      else r.lost++;
      r.form.push(mine > theirs ? 'W' : 'L');
      const avg = f[`${side}Avg`];
      if (typeof avg === 'number') { r.avgSum += avg; r.avgCount++; }
    }
  }
  for (const r of out.values()) {
    r.legDiff = r.legsFor - r.legsAgainst;
    r.avg = r.avgCount ? round2(r.avgSum / r.avgCount) : null;
    r.form = r.form.slice(-5);
  }
  return out;
}

// ---------------------------------------------------------------- matchup preview

/** Table position, points and form of both teams, plus their last meeting. */
export function matchupPreview(state, f) {
  const rows = new Map(computeStandings(state.teams, state.fixtures, state.config, { includeLive: true }).map((r) => [r.teamId, r]));
  const overall = overallRecords(state);
  const side = (id) => {
    const r = rows.get(id);
    return r ? { teamId: id, position: r.position, points: r.points, played: r.played, form: overall.get(id)?.form ?? r.form } : null;
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
 * - upset: the win with the biggest gap in table position beforehand: league
 *   matches (both teams had played at least 2 league matches) and knockout
 *   matches (by seed, i.e. league finish), or null
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
  // Knockout: a lower seed (league finish) beating a higher one counts too.
  const seedOf = (id) => (state.seeds ?? []).indexOf(id) + 1;
  for (const f of finishedAll(state).filter((x) => x.stage !== 'league')) {
    const wp = seedOf(winnerId(f));
    const lp = seedOf(loserId(f));
    if (wp && lp && wp - lp > 0 && (!upset || wp - lp > upset.gap)) upset = { fixture: f, winnerId: winnerId(f), loserId: loserId(f), winnerPos: wp, loserPos: lp, gap: wp - lp };
  }
  return { streaks, longest, hot, whitewashes, upset };
}

// ---------------------------------------------------------------- estimated finish

const MIN = 60000;
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * How long one board takes per league match, changeovers included (ms), or null.
 * Main source: the pace of the evening, the time between the last finishes
 * (up to 12), doubled because two boards run at once. If results came in a
 * burst (typed in afterwards) that pace is meaningless, so fall back to the
 * median length of matches that were really scored live, plus 3 minutes.
 */
export function boardSlot(state) {
  const cfg = state.config;
  const factor = (f) => (cfg.bestOf[f.stage] ?? 3) / (cfg.bestOf.league ?? 3);
  const done = state.fixtures.filter((f) => f.status === 'done' && f.finishedAt).sort(byFinish);
  const recent = done.slice(-12);
  if (recent.length >= 3) {
    const gap = (recent[recent.length - 1].finishedAt - recent[0].finishedAt) / (recent.length - 1);
    const perMatch = gap / mean(recent.map(factor)); // in league-match units
    if (perMatch >= 2 * MIN && perMatch <= 60 * MIN) return perMatch * 2;
  }
  const lengths = done.filter((f) => f.startedAt && f.finishedAt - f.startedAt >= 2 * MIN)
    .slice(-12).map((f) => (f.finishedAt - f.startedAt) / factor(f));
  if (lengths.length >= 2) return median(lengths) + 3 * MIN;
  return null;
}

/**
 * Estimated time left in the tournament: { ms, finishAt } or null when there
 * isn't enough to go on (fewer than 3 results, or none scored live) or nothing
 * is left. League matches share the two boards; the semi-finals run side by
 * side; the final (and 3rd place play-off) after them. A match being played
 * counts for what's left of its usual length.
 */
export function finishEstimate(state, now = Date.now()) {
  if (state.phase !== 'league' && state.phase !== 'knockout') return null;
  const slot = boardSlot(state);
  if (!slot) return null;
  const cfg = state.config;
  const len = (stage) => slot * ((cfg.bestOf[stage] ?? 3) / (cfg.bestOf.league ?? 3));
  const left = (f) => {
    if (f.status === 'done') return 0;
    const full = len(f.stage);
    if (f.status === 'live' && f.startedAt) return Math.max(full * 0.15, full - (now - f.startedAt));
    return full;
  };
  // League: total board time shared by the two boards.
  const league = state.fixtures.filter((f) => f.stage === 'league');
  let ms = league.reduce((t, f) => t + left(f), 0) / 2;
  // Knockout: placeholders until it starts.
  const ko = (stage, id) => state.fixtures.find((f) => f.id === id) ?? { stage, status: 'scheduled' };
  const semis = Math.max(left(ko('semi', 'SF1')), left(ko('semi', 'SF2')));
  const final = left(ko('final', 'F'));
  const third = cfg.thirdPlace ? left(ko('third', '3P')) : 0;
  ms += semis + (cfg.finalAlone ? third + final : Math.max(third, final));
  if (ms <= 0) return null;
  return { ms, finishAt: now + ms };
}

// ---------------------------------------------------------------- result banner

const STAGE_TITLE = { semi: 'the semi-final', third: 'the 3rd place play-off', final: 'the final' };

/**
 * What a just-finished match meant, for the TV's result banner:
 * { winnerId, loserId, score: '2–1', headline, detail } where headline says
 * who won and detail what it changed (league position, qualification, the
 * final). Knockout results say what the winner goes on to.
 */
export function resultSummary(state, f) {
  const w = winnerId(f);
  const l = loserId(f);
  const score = `${Math.max(f.homeLegs, f.awayLegs)}–${Math.min(f.homeLegs, f.awayLegs)}`;
  const out = { winnerId: w, loserId: l, score, headline: `${nameOf(state, w)} win ${score}`, detail: '' };
  if (f.stage === 'semi') { out.detail = `${nameOf(state, w)} are through to the final`; return out; }
  if (f.stage === 'third') { out.detail = `${nameOf(state, w)} take third place`; return out; }
  if (f.stage === 'final') { out.headline = `${nameOf(state, w)} are the champions!`; out.detail = `Beat ${nameOf(state, l)} ${score} in the final`; return out; }
  // League: position before (this match not played) and after, finished results only.
  const without = state.fixtures.map((x) => (x.id === f.id ? { ...x, status: 'scheduled' } : x));
  const pos = (fx) => new Map(computeStandings(state.teams, fx, state.config).map((r) => [r.teamId, r.position]));
  const before = pos(without);
  const after = pos(state.fixtures);
  const qBefore = qualificationStatus(state, without);
  const qAfter = qualificationStatus(state);
  const move = (id) => {
    const a = before.get(id);
    const b = after.get(id);
    if (b < a) return `up to ${ordinal(b)} ▲`;
    if (b > a) return `down to ${ordinal(b)} ▼`;
    return `stay ${ordinal(b)}`;
  };
  if (qBefore.get(w)?.status !== 'in' && qAfter.get(w)?.status === 'in' && state.teams.length > state.config.qualifiers) {
    out.detail = `${nameOf(state, w)} are sure of a semi-final place!`;
  } else if (qBefore.get(l)?.status !== 'out' && qAfter.get(l)?.status === 'out') {
    out.detail = `${nameOf(state, w)} ${move(w)} · ${nameOf(state, l)} can no longer make the top ${state.config.qualifiers}`;
  } else {
    out.detail = `${nameOf(state, w)} ${move(w)} · ${nameOf(state, l)} ${move(l)}`;
  }
  out.stage = STAGE_TITLE[f.stage] ?? '';
  return out;
}

// ---------------------------------------------------------------- team spotlight

/**
 * One team's night: { teamId, row (live league table), overall (record over
 * every stage, see overallRecords), results [{ f, opponentId, won,
 * forLegs, againstLegs, avg }], averages [numbers in order], live, next }.
 */
export function teamSpotlight(state, teamId) {
  const row = computeStandings(state.teams, state.fixtures, state.config, { includeLive: true }).find((r) => r.teamId === teamId) ?? null;
  const results = finishedAll(state).filter((f) => plays(f, teamId)).map((f) => {
    const home = f.homeId === teamId;
    const forLegs = home ? f.homeLegs : f.awayLegs;
    const againstLegs = home ? f.awayLegs : f.homeLegs;
    return { f, opponentId: home ? f.awayId : f.homeId, won: forLegs > againstLegs, forLegs, againstLegs, avg: home ? f.homeAvg : f.awayAvg };
  });
  const averages = results.map((r) => r.avg).filter((a) => typeof a === 'number');
  const live = state.fixtures.find((f) => f.status === 'live' && plays(f, teamId)) ?? null;
  const next = state.fixtures.filter((f) => f.status === 'scheduled' && plays(f, teamId) && f.homeId && f.awayId)
    .sort((a, b) => a.order - b.order)[0] ?? null;
  const overall = overallRecords(state).get(teamId) ?? null;
  return { teamId, row, overall, results, averages, live, next };
}

// ---------------------------------------------------------------- knockout: tale of the tape

/**
 * Side-by-side comparison of the two teams in a knockout match. Rows are
 * { label, home, away, better: 'home' | 'away' | null, share } with display
 * values (share: the home side's part of a two-way bar, or null); `edge`
 * counts the rows each side wins; `route` lists each side's earlier knockout
 * matches; `meetings` are their earlier matches tonight (any stage), oldest first.
 */
export function taleOfTheTape(state, f) {
  const league = computeStandings(state.teams, state.fixtures, state.config);
  const byId = new Map(league.map((r) => [r.teamId, r]));
  const avgs = averagesBoard(state, { top: 99 });
  const seasonAvg = new Map(avgs.season.map((x) => [x.teamId, x.avg]));
  const bestAvg = new Map();
  for (const e of avgs.bestMatch) if (!bestAvg.has(e.teamId)) bestAvg.set(e.teamId, e.avg);
  const { streaks } = records(state);
  const seed = (id) => (state.seeds ?? []).indexOf(id) + 1 || null;
  const cmp = (a, b, higher = true) => (a == null || b == null || a === b ? null : (a > b) === higher ? 'home' : 'away');
  const h = byId.get(f.homeId);
  const a = byId.get(f.awayId);
  // Record, leg difference and form count every stage played so far (league + knockout).
  const overall = overallRecords(state);
  const oh = overall.get(f.homeId);
  const oa = overall.get(f.awayId);
  const fmt2 = (n) => (typeof n === 'number' ? n.toFixed(2) : '–');
  const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
  const rows = [];
  if (h && a) {
    rows.push({ label: 'League finish', home: ordinal(h.position), away: ordinal(a.position), better: cmp(h.position, a.position, false) });
  }
  if (oh && oa) {
    rows.push({ label: 'Won – lost', home: `${oh.won}–${oh.lost}`, away: `${oa.won}–${oa.lost}`, better: cmp(oh.won - oh.lost, oa.won - oa.lost) });
    rows.push({ label: 'Leg difference', home: signed(oh.legDiff), away: signed(oa.legDiff), better: cmp(oh.legDiff, oa.legDiff) });
  }
  const ah = seasonAvg.get(f.homeId) ?? null;
  const aa = seasonAvg.get(f.awayId) ?? null;
  rows.push({ label: '3-dart average', home: fmt2(ah), away: fmt2(aa), better: cmp(ah, aa) });
  const bh = bestAvg.get(f.homeId) ?? null;
  const ba = bestAvg.get(f.awayId) ?? null;
  rows.push({ label: 'Best match average', home: fmt2(bh), away: fmt2(ba), better: cmp(bh, ba) });
  const lh = streaks.get(f.homeId)?.longest ?? 0;
  const la = streaks.get(f.awayId)?.longest ?? 0;
  rows.push({ label: 'Longest winning run', home: String(lh), away: String(la), better: cmp(lh, la) });
  // Share of a two-way bar for the home side (0..1) where both values are counts or averages.
  const share = (x, y) => (typeof x === 'number' && typeof y === 'number' && x >= 0 && y >= 0 && x + y > 0 ? x / (x + y) : null);
  const shares = { 'Won – lost': oh && oa ? share(oh.won, oa.won) : null, '3-dart average': share(ah, aa), 'Best match average': share(bh, ba), 'Longest winning run': share(lh, la) };
  for (const row of rows) row.share = shares[row.label] ?? null;
  const meetings = finishedAll(state).filter((x) => x.id !== f.id && plays(x, f.homeId) && plays(x, f.awayId));
  const homeWins = meetings.filter((x) => winnerId(x) === f.homeId).length;
  // Earlier knockout wins: how each team got here ("beat X 2–1 in the semi-final").
  const route = (id) => finishedAll(state).filter((x) => x.stage !== 'league' && x.id !== f.id && plays(x, id)).map((x) => {
    const home = x.homeId === id;
    const forLegs = home ? x.homeLegs : x.awayLegs;
    const againstLegs = home ? x.awayLegs : x.homeLegs;
    return { f: x, opponentId: home ? x.awayId : x.homeId, won: forLegs > againstLegs, forLegs, againstLegs, avg: home ? x.homeAvg : x.awayAvg };
  });
  const edge = { home: rows.filter((r) => r.better === 'home').length, away: rows.filter((r) => r.better === 'away').length };
  return {
    seeds: { home: seed(f.homeId), away: seed(f.awayId) },
    form: { home: oh?.form ?? [], away: oa?.form ?? [] },
    rows,
    edge,
    route: { home: route(f.homeId), away: route(f.awayId) },
    meetings,
    meetingsWon: { home: homeWins, away: meetings.length - homeWins },
  };
}
