// Tournament state + pure actions. Every action takes a state and returns a
// NEW state (or throws an Error with a message fit to show the organiser).
// Standings and bracket are derived, never stored.

import { DEFAULT_CONFIG, MIN_TEAMS, MAX_TEAMS, STAGES, normalizeConfig, legsToWinFor } from './config.js';
import { generateLeagueFixtures } from './fixtures.js';
import { computeStandings } from './standings.js';
import { createKnockoutFixtures, resolveKnockout, isDecided, winnerOf } from './bracket.js';
import { uid, clone } from './util.js';

export const PHASES = ['setup', 'league', 'knockout', 'complete'];
export const SCHEMA_VERSION = 1;

export function createTournament(config = DEFAULT_CONFIG, teams = []) {
  return {
    schema: SCHEMA_VERSION,
    id: uid('t'),
    rev: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    config: normalizeConfig(config),
    phase: 'setup',
    teams: clone(teams),
    fixtures: [],
    seeds: null,
  };
}

/** Accept anything that looks like a saved tournament; fill gaps; reject junk. */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.teams) || !Array.isArray(raw.fixtures)) return null;
  const teams = raw.teams
    .filter((t) => t && typeof t.id === 'string')
    .map((t) => ({ id: t.id, name: String(t.name ?? '').slice(0, 60) || 'Team', players: normalizePlayers(t.players) }));
  const fixtures = raw.fixtures
    .filter((f) => f && typeof f.id === 'string' && STAGES.includes(f.stage))
    .map((f) => ({
      id: f.id,
      stage: f.stage,
      round: f.round ?? null,
      homeId: f.homeId ?? null,
      awayId: f.awayId ?? null,
      board: f.board === 1 || f.board === 2 ? f.board : null,
      status: ['scheduled', 'live', 'done'].includes(f.status) ? f.status : 'scheduled',
      homeLegs: Math.max(0, Number(f.homeLegs) || 0),
      awayLegs: Math.max(0, Number(f.awayLegs) || 0),
      homeAvg: storedAverage(f.homeAvg),
      awayAvg: storedAverage(f.awayAvg),
      order: Number(f.order) || 0,
      startedAt: f.startedAt ?? null,
      finishedAt: f.finishedAt ?? null,
    }));
  return {
    schema: SCHEMA_VERSION,
    id: typeof raw.id === 'string' ? raw.id : uid('t'),
    rev: Number(raw.rev) || 0,
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
    config: normalizeConfig(raw.config),
    phase: PHASES.includes(raw.phase) ? raw.phase : 'setup',
    teams,
    fixtures,
    seeds: Array.isArray(raw.seeds) ? raw.seeds.slice(0, 4) : null,
  };
}

/**
 * Consistency check for a normalised state (used before importing a backup).
 * Returns a list of human-readable problems; empty means it is safe to use.
 */
export function validateState(state) {
  const problems = [];
  const teamIds = new Set();
  for (const t of state.teams) {
    if (teamIds.has(t.id)) problems.push(`Team id “${t.id}” is used twice.`);
    teamIds.add(t.id);
  }
  const names = new Set();
  for (const t of state.teams) {
    const n = t.name.toLowerCase();
    if (names.has(n)) problems.push(`Two teams are called “${t.name}”.`);
    names.add(n);
  }
  const fixtureIds = new Set();
  const boards = new Map();
  const playing = new Map();
  for (const f of state.fixtures) {
    const label = `Match ${f.id}`;
    if (fixtureIds.has(f.id)) problems.push(`${label} appears twice.`);
    fixtureIds.add(f.id);
    for (const id of [f.homeId, f.awayId]) {
      if (id !== null && !teamIds.has(id)) problems.push(`${label} refers to a team that doesn't exist.`);
    }
    if (f.homeId && f.homeId === f.awayId) problems.push(`${label} has a team playing itself.`);
    if (f.status !== 'scheduled' && (!f.homeId || !f.awayId)) problems.push(`${label} has started but its teams are not known.`);
    const need = legsToWinFor(state.config, f.stage);
    if (f.homeLegs > need || f.awayLegs > need) problems.push(`${label} has more legs than best of ${state.config.bestOf[f.stage]} allows.`);
    if (f.status === 'done' && !isDecided(f, state.config)) problems.push(`${label} is finished but has no winner (${f.homeLegs}–${f.awayLegs}).`);
    for (const k of ['homeAvg', 'awayAvg']) {
      const v = f[k];
      if (v !== null && v !== undefined && (typeof v !== 'number' || !(v >= 0 && v <= MAX_AVERAGE))) problems.push(`${label} has an impossible 3-dart average (${v}).`);
      if (v != null && f.status === 'scheduled') problems.push(`${label} has an average but hasn't been played.`);
    }
    if (f.status === 'live') {
      if (f.board !== 1 && f.board !== 2) problems.push(`${label} is live but not on a board.`);
      else if (boards.has(f.board)) problems.push(`Two matches are live on board ${f.board}.`);
      else boards.set(f.board, f.id);
      for (const id of [f.homeId, f.awayId]) {
        if (playing.has(id)) problems.push(`A team is live in two matches at once.`);
        playing.set(id, f.id);
      }
    }
  }
  const ko = state.fixtures.filter((f) => f.stage !== 'league');
  if ((state.phase === 'knockout' || state.phase === 'complete') && !ko.some((f) => f.id === 'SF1')) {
    problems.push(`Phase is “${state.phase}” but there are no semi-finals.`);
  }
  if (state.phase === 'setup' && state.fixtures.length) problems.push('Phase is “setup” but fixtures exist.');
  if (state.seeds && state.seeds.some((id) => !teamIds.has(id))) problems.push('Knockout seeds refer to unknown teams.');
  return [...new Set(problems)];
}

function normalizePlayers(p) {
  if (!Array.isArray(p)) return ['', ''];
  return [String(p[0] ?? '').slice(0, 40), String(p[1] ?? '').slice(0, 40)];
}

// ---------- queries ----------

export const teamById = (state, id) => state.teams.find((t) => t.id === id) ?? null;
export const teamName = (state, id, fallback = 'TBD') => teamById(state, id)?.name ?? fallback;
export const fixtureById = (state, id) => state.fixtures.find((f) => f.id === id) ?? null;
export const byOrder = (a, b) => a.order - b.order;

export const standings = (state) => computeStandings(state.teams, state.fixtures, state.config);
export const liveFixtures = (state) => state.fixtures.filter((f) => f.status === 'live');
export const liveOnBoard = (state, board) => state.fixtures.find((f) => f.status === 'live' && f.board === board) ?? null;
export const leagueFixtures = (state) => state.fixtures.filter((f) => f.stage === 'league');
export const knockoutFixtures = (state) => state.fixtures.filter((f) => f.stage !== 'league');

export function leagueProgress(state) {
  const league = leagueFixtures(state);
  return { played: league.filter((f) => f.status === 'done').length, total: league.length };
}

export function recentResults(state, n = 5) {
  return state.fixtures
    .filter((f) => f.status === 'done')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0) || b.order - a.order)
    .slice(0, n);
}

/** Scheduled matches with both teams known, in play order. */
export function upcoming(state) {
  return state.fixtures.filter((f) => f.status === 'scheduled' && f.homeId && f.awayId).sort(byOrder);
}

/**
 * Suggested next match for each board. Free boards pick first. A match is not
 * suggested if one of its teams is playing on (or lined up for) another board.
 * Returns {1: fixture|null, 2: fixture|null}.
 */
export function nextUp(state) {
  const queue = upcoming(state);
  const result = { 1: null, 2: null };
  const boards = [1, 2].sort((a, b) => Number(!!liveOnBoard(state, a)) - Number(!!liveOnBoard(state, b)));
  const taken = new Set();
  const reserved = new Set();
  for (const board of boards) {
    const busyElsewhere = new Set(
      liveFixtures(state)
        .filter((f) => f.board !== board)
        .flatMap((f) => [f.homeId, f.awayId]),
    );
    const pick = queue.find(
      (f) =>
        !taken.has(f.id) &&
        !finalMustWait(state, f, taken) &&
        ![f.homeId, f.awayId].some((t) => busyElsewhere.has(t) || reserved.has(t)),
    );
    if (pick) {
      result[board] = pick;
      taken.add(pick.id);
      reserved.add(pick.homeId).add(pick.awayId);
    }
  }
  return result;
}

/**
 * With config.finalAlone the final only starts once every other knockout
 * match is finished, so it gets the room's full attention. `alsoTaken` lets
 * nextUp treat matches it has just suggested as occupying a board.
 */
export function finalMustWait(state, f, alsoTaken = new Set()) {
  if (f.stage !== 'final' || !state.config.finalAlone) return false;
  return state.fixtures.some((x) => x.stage !== 'league' && x.id !== f.id && (x.status !== 'done' || alsoTaken.has(x.id)));
}

export function matchWinnerId(f) {
  return winnerOf(f);
}

export function canStartKnockout(state) {
  const { played, total } = leagueProgress(state);
  return state.phase === 'league' && total > 0 && played === total && liveFixtures(state).length === 0;
}

// ---------- helpers ----------

function fail(message) {
  throw new Error(message);
}

function cleanName(name) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) fail('Team name cannot be empty.');
  return n;
}

function mutate(state, fn) {
  const next = clone(state);
  fn(next);
  return next;
}

function getFixture(state, id) {
  return state.fixtures.find((f) => f.id === id) ?? fail('Match not found.');
}

function assertUniqueName(state, name, exceptId) {
  if (state.teams.some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase())) {
    fail(`There is already a team called “${name}”.`);
  }
}

function updatePhaseAfterKnockout(s) {
  const ko = s.fixtures.filter((f) => f.stage !== 'league');
  if (!ko.length) return;
  s.phase = ko.every((f) => f.status === 'done') ? 'complete' : 'knockout';
}

// ---------- teams ----------

export function addTeam(state, name, players = ['', '']) {
  if (state.phase !== 'setup') fail('Teams can only be added before the league starts.');
  if (state.teams.length >= MAX_TEAMS) fail(`Maximum ${MAX_TEAMS} teams.`);
  const clean = cleanName(name);
  assertUniqueName(state, clean);
  return mutate(state, (s) => {
    s.teams.push({ id: uid('team'), name: clean, players: normalizePlayers(players) });
  });
}

/**
 * Bulk paste, one team per line. Optional players after a separator:
 * "Team name: Player A & Player B" (also accepts " - ", "|", tab, or "," between players).
 */
export function parseBulkTeams(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(.*?)\s*(?::|\||\t| - )\s*(.+)$/);
      if (!m) return { name: line, players: ['', ''] };
      const players = m[2].split(/\s*(?:&|\+|,|\/| and )\s*/i).filter(Boolean);
      return { name: m[1], players: [players[0] ?? '', players.slice(1).join(' & ')] };
    });
}

export function addTeamsBulk(state, text) {
  let s = state;
  const skipped = [];
  for (const t of parseBulkTeams(text)) {
    try {
      s = addTeam(s, t.name, t.players);
    } catch (e) {
      skipped.push(`${t.name}: ${e.message}`);
    }
  }
  return { state: s, skipped };
}

export function updateTeam(state, id, { name, players } = {}) {
  return mutate(state, (s) => {
    const t = s.teams.find((x) => x.id === id) ?? fail('Team not found.');
    if (name !== undefined) {
      const clean = cleanName(name);
      assertUniqueName(s, clean, id);
      t.name = clean;
    }
    if (players !== undefined) t.players = normalizePlayers(players);
  });
}

export function removeTeam(state, id) {
  if (state.phase !== 'setup') fail('Teams can only be removed before the league starts.');
  return mutate(state, (s) => {
    s.teams = s.teams.filter((t) => t.id !== id);
  });
}

export function moveTeam(state, id, delta) {
  return mutate(state, (s) => {
    const i = s.teams.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.teams.length) return;
    [s.teams[i], s.teams[j]] = [s.teams[j], s.teams[i]];
  });
}

// ---------- config ----------

export function updateConfig(state, patch) {
  const merged = normalizeConfig({
    ...state.config,
    ...patch,
    bestOf: { ...state.config.bestOf, ...(patch.bestOf ?? {}) },
    points: { ...state.config.points, ...(patch.points ?? {}) },
    keys: { ...state.config.keys, ...(patch.keys ?? {}) },
    boardNames: patch.boardNames ?? state.config.boardNames,
  });
  if (merged.doubleRoundRobin !== state.config.doubleRoundRobin && state.phase !== 'setup') {
    fail('Once/twice can only be changed before the league starts (or go back to setup first).');
  }
  for (const stage of STAGES) {
    if (merged.bestOf[stage] === state.config.bestOf[stage]) continue;
    if (state.fixtures.some((f) => f.stage === stage && f.status !== 'scheduled')) {
      fail(`The match length for ${stageLabel(stage)} matches cannot change after one has started.`);
    }
  }
  return mutate(state, (s) => {
    s.config = merged;
    if (merged.thirdPlace !== state.config.thirdPlace && s.fixtures.some((f) => f.stage === 'semi')) {
      const existing = s.fixtures.find((f) => f.id === '3P');
      if (merged.thirdPlace && !existing) {
        const final = s.fixtures.find((f) => f.id === 'F');
        const order = final ? final.order : Math.max(0, ...s.fixtures.map((f) => f.order)) + 1;
        if (final) final.order = order + 1;
        s.fixtures.push({
          id: '3P', stage: 'third', round: null, homeId: null, awayId: null, board: null,
          status: 'scheduled', homeLegs: 0, awayLegs: 0, order, startedAt: null, finishedAt: null,
        });
        s.fixtures = resolveKnockout(s.fixtures);
      } else if (!merged.thirdPlace && existing) {
        if (existing.status !== 'scheduled') fail('The 3rd place match has already started.');
        s.fixtures = s.fixtures.filter((f) => f.id !== '3P');
      }
      updatePhaseAfterKnockout(s);
    }
  });
}

export function stageLabel(stage) {
  return { league: 'league', semi: 'semi-final', third: '3rd place', final: 'final' }[stage] ?? stage;
}

// ---------- league ----------

/**
 * Start the league. `manual: true` starts with an empty fixture list so the
 * organiser can add every match themselves; otherwise a round robin is generated.
 */
export function startLeague(state, { manual = false } = {}) {
  if (state.phase !== 'setup') fail('The league has already started.');
  if (state.teams.length < MIN_TEAMS) fail(`Need at least ${MIN_TEAMS} teams.`);
  return mutate(state, (s) => {
    s.fixtures = manual
      ? []
      : generateLeagueFixtures(s.teams.map((t) => t.id), { double: s.config.doubleRoundRobin });
    s.phase = 'league';
  });
}

// ---------- manual fixture editing (league, unplayed matches only) ----------

function assertLeagueEditable(state) {
  if (state.phase !== 'league') fail('League fixtures can only be changed during the league.');
}

function assertPairing(state, homeId, awayId) {
  if (!teamById(state, homeId) || !teamById(state, awayId)) fail('Pick two teams.');
  if (homeId === awayId) fail('A team cannot play itself.');
}

function getScheduledLeague(s, id) {
  const f = getFixture(s, id);
  if (f.stage !== 'league') fail('Only league matches can be edited here.');
  if (f.status !== 'scheduled') fail('Only matches that have not started can be changed.');
  return f;
}

function nextLeagueId(s) {
  const n = Math.max(0, ...s.fixtures.map((f) => Number(/^L(\d+)$/.exec(f.id)?.[1] ?? 0)));
  return `L${n + 1}`;
}

/** Add a league match at the end of the queue. */
export function addFixture(state, homeId, awayId) {
  assertLeagueEditable(state);
  assertPairing(state, homeId, awayId);
  return mutate(state, (s) => {
    const order = Math.max(0, ...s.fixtures.filter((f) => f.stage === 'league').map((f) => f.order)) + 1;
    s.fixtures.push({
      id: nextLeagueId(s), stage: 'league', round: null, homeId, awayId, board: null,
      status: 'scheduled', homeLegs: 0, awayLegs: 0, order, startedAt: null, finishedAt: null,
    });
  });
}

/**
 * Paste a fixture list, one match per line: "Team A v Team B"
 * (also "vs", "vs.", " - ", "@"). Team names match case-insensitively.
 */
export function parseBulkFixtures(state, text) {
  const byName = new Map(state.teams.map((t) => [t.name.toLowerCase(), t.id]));
  const matches = [];
  const skipped = [];
  const skippedLines = [];
  const skip = (raw, why) => { skipped.push(why); skippedLines.push(raw.trim()); };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:\d+[.):]|[-*•])\s*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s+(?:v|vs\.?|versus|-|@)\s+(.+)$/i);
    if (!m) { skip(raw, `${line} (use “Team A v Team B”)`); continue; }
    const home = byName.get(m[1].trim().toLowerCase());
    const away = byName.get(m[2].trim().toLowerCase());
    if (!home || !away) {
      skip(raw, `${line} (unknown team: ${!home ? m[1].trim() : m[2].trim()})`);
      continue;
    }
    if (home === away) { skip(raw, `${line} (same team twice)`); continue; }
    matches.push([home, away]);
  }
  return { matches, skipped, skippedLines };
}

export function addFixturesBulk(state, text) {
  const { matches, skipped, skippedLines } = parseBulkFixtures(state, text);
  let s = state;
  for (const [h, a] of matches) s = addFixture(s, h, a);
  return { state: s, added: matches.length, skipped, skippedLines };
}

/** Change who plays in an unplayed league match. */
export function updateFixture(state, id, { homeId, awayId }) {
  assertLeagueEditable(state);
  assertPairing(state, homeId, awayId);
  return mutate(state, (s) => {
    const f = getScheduledLeague(s, id);
    f.homeId = homeId;
    f.awayId = awayId;
  });
}

export function swapHomeAway(state, id) {
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status !== 'scheduled') fail('Only matches that have not started can be changed.');
    [f.homeId, f.awayId] = [f.awayId, f.homeId];
  });
}

export function removeFixture(state, id) {
  assertLeagueEditable(state);
  return mutate(state, (s) => {
    getScheduledLeague(s, id);
    s.fixtures = s.fixtures.filter((f) => f.id !== id);
  });
}

/** Delete every league match that has not been played or started. */
export function clearUnplayedFixtures(state) {
  assertLeagueEditable(state);
  return mutate(state, (s) => {
    s.fixtures = s.fixtures.filter((f) => f.stage !== 'league' || f.status !== 'scheduled');
  });
}

/** Replace all unplayed league matches with a freshly generated round robin of the pairings still owed. */
export function regenerateUnplayed(state) {
  assertLeagueEditable(state);
  return mutate(state, (s) => {
    const kept = s.fixtures.filter((f) => f.stage !== 'league' || f.status !== 'scheduled');
    const wanted = generateLeagueFixtures(s.teams.map((t) => t.id), { double: s.config.doubleRoundRobin });
    // Remove one generated match per meeting already played/live (home/away aware first, then either way).
    const remaining = wanted.slice();
    for (const f of kept.filter((x) => x.stage === 'league')) {
      let i = remaining.findIndex((m) => m.homeId === f.homeId && m.awayId === f.awayId);
      if (i < 0) i = remaining.findIndex((m) => m.homeId === f.awayId && m.awayId === f.homeId);
      if (i >= 0) remaining.splice(i, 1);
    }
    s.fixtures = kept;
    for (const m of remaining) {
      const order = Math.max(0, ...s.fixtures.filter((f) => f.stage === 'league').map((f) => f.order)) + 1;
      s.fixtures.push({ ...m, id: nextLeagueId(s), order });
    }
  });
}

/** Move an unplayed match to a 1-based position among the unplayed matches of its stage. */
export function moveFixtureTo(state, id, position) {
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status !== 'scheduled') fail('Only upcoming matches can be moved.');
    const queue = s.fixtures.filter((x) => x.status === 'scheduled' && x.stage === f.stage).sort(byOrder);
    const orders = queue.map((x) => x.order);
    const rest = queue.filter((x) => x !== f);
    const pos = Math.max(1, Math.min(queue.length, Math.round(Number(position)) || 1));
    rest.splice(pos - 1, 0, f);
    rest.forEach((x, i) => (x.order = orders[i]));
  });
}

/**
 * How balanced is the league fixture list? Compares against the configured
 * once/twice round robin. Returns per-team counts, pairs not yet scheduled
 * and pairs scheduled more often than expected.
 */
export function leagueBalance(state) {
  const expected = state.config.doubleRoundRobin ? 2 : 1;
  const league = leagueFixtures(state);
  const perTeam = new Map(state.teams.map((t) => [t.id, 0]));
  const pairs = new Map();
  const key = (a, b) => [a, b].sort().join('|');
  for (const f of league) {
    perTeam.set(f.homeId, (perTeam.get(f.homeId) ?? 0) + 1);
    perTeam.set(f.awayId, (perTeam.get(f.awayId) ?? 0) + 1);
    pairs.set(key(f.homeId, f.awayId), (pairs.get(key(f.homeId, f.awayId)) ?? 0) + 1);
  }
  const missing = [];
  const extra = [];
  const ids = state.teams.map((t) => t.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const n = pairs.get(key(ids[i], ids[j])) ?? 0;
      if (n < expected) missing.push({ a: ids[i], b: ids[j], count: n, expected });
      if (n > expected) extra.push({ a: ids[i], b: ids[j], count: n, expected });
    }
  }
  const counts = [...perTeam.values()];
  return {
    expected,
    perTeam,
    missing,
    extra,
    even: counts.length > 0 && counts.every((c) => c === counts[0]),
    complete: missing.length === 0 && extra.length === 0,
  };
}

/** Undo "start league" — only while nothing has been played. */
export function backToSetup(state) {
  if (state.phase !== 'league') fail('Only possible during the league.');
  if (state.fixtures.some((f) => f.status !== 'scheduled')) fail('Matches have already been played.');
  return mutate(state, (s) => {
    s.fixtures = [];
    s.phase = 'setup';
  });
}

/** Move a scheduled match up (-1) or down (+1) past the neighbouring scheduled match. */
export function moveFixture(state, id, delta) {
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status !== 'scheduled') fail('Only upcoming matches can be moved.');
    const queue = s.fixtures.filter((x) => x.status === 'scheduled' && x.stage === f.stage).sort(byOrder);
    const i = queue.indexOf(f);
    const other = queue[i + delta];
    if (!other) return;
    [f.order, other.order] = [other.order, f.order];
  });
}

/** Put a scheduled match at the front of the queue. */
export function playNext(state, id) {
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status !== 'scheduled') fail('Only upcoming matches can be moved.');
    const queue = s.fixtures.filter((x) => x.status === 'scheduled' && x.stage === f.stage).sort(byOrder);
    const orders = queue.map((x) => x.order);
    const reordered = [f, ...queue.filter((x) => x !== f)];
    reordered.forEach((x, i) => (x.order = orders[i]));
  });
}

// ---------- matches ----------

export function startMatch(state, id, board) {
  if (board !== 1 && board !== 2) fail('Board must be 1 or 2.');
  if (state.phase !== 'league' && state.phase !== 'knockout') fail('No matches to play right now.');
  const f = getFixture(state, id);
  if (f.status !== 'scheduled') fail('That match is not waiting to be played.');
  if (!f.homeId || !f.awayId) fail('Both teams are not known yet.');
  if (f.stage === 'league' && state.phase !== 'league') fail('The league is over.');
  if (f.stage !== 'league' && state.phase !== 'knockout') fail('The knockout has not started.');
  const onBoard = liveOnBoard(state, board);
  if (onBoard) fail(`${state.config.boardNames[board - 1]} is busy.`);
  const busy = new Set(liveFixtures(state).flatMap((x) => [x.homeId, x.awayId]));
  if (busy.has(f.homeId) || busy.has(f.awayId)) fail('One of these teams is already playing.');
  if (finalMustWait(state, f)) fail('The final is played on its own — finish the other matches first (or turn this off in Settings).');
  return mutate(state, (s) => {
    const m = getFixture(s, id);
    Object.assign(m, { status: 'live', board, homeLegs: 0, awayLegs: 0, homeAvg: null, awayAvg: null, startedAt: Date.now(), finishedAt: null });
  });
}

/** Take a live match off the board (started by mistake). Score is cleared. */
export function cancelMatch(state, id) {
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status !== 'live') fail('That match is not live.');
    Object.assign(f, { status: 'scheduled', board: null, homeLegs: 0, awayLegs: 0, homeAvg: null, awayAvg: null, startedAt: null });
  });
}

/** +/- a leg on a live match. Clamped so nobody exceeds the winning count. */
export function adjustLegs(state, id, side, delta) {
  if (side !== 'home' && side !== 'away') fail('Side must be home or away.');
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status !== 'live') fail('That match is not live.');
    const need = legsToWinFor(s.config, f.stage);
    const key = side === 'home' ? 'homeLegs' : 'awayLegs';
    const otherKey = side === 'home' ? 'awayLegs' : 'homeLegs';
    if (delta > 0 && (f[key] >= need || f[otherKey] >= need)) return; // already decided
    f[key] = Math.max(0, Math.min(need, f[key] + delta));
  });
}

export function matchIsDecided(state, id) {
  const f = fixtureById(state, id);
  return !!f && isDecided(f, state.config);
}

export function finishMatch(state, id) {
  const f = getFixture(state, id);
  if (f.status !== 'live') fail('That match is not live.');
  if (!isDecided(f, state.config)) fail('Nobody has won enough legs yet.');
  return mutate(state, (s) => {
    const m = getFixture(s, id);
    Object.assign(m, { status: 'done', board: null, finishedAt: Date.now() });
    if (m.stage !== 'league') {
      s.fixtures = resolveKnockout(s.fixtures);
      updatePhaseAfterKnockout(s);
    }
  });
}

/** Correct a finished result. Standings / bracket recalculate from it. */
export function editResult(state, id, homeLegs, awayLegs) {
  const f = getFixture(state, id);
  if (f.status !== 'done') fail('Only finished matches can be edited.');
  const candidate = { ...f, homeLegs: Number(homeLegs), awayLegs: Number(awayLegs) };
  if (!isDecided(candidate, state.config)) {
    fail(`Not a valid result — the winner needs exactly ${legsToWinFor(state.config, f.stage)} legs.`);
  }
  return mutate(state, (s) => {
    const m = getFixture(s, id);
    m.homeLegs = candidate.homeLegs;
    m.awayLegs = candidate.awayLegs;
    if (m.stage !== 'league') {
      s.fixtures = resolveKnockout(s.fixtures);
      updatePhaseAfterKnockout(s);
    }
  });
}

/** Put a finished match back in the queue as if never played. */
export function unplayMatch(state, id) {
  const f = getFixture(state, id);
  if (f.status !== 'done') fail('Only finished matches can be reset.');
  if (f.stage === 'league' && state.phase !== 'league') fail('Go back to the league first (no knockout matches played).');
  return mutate(state, (s) => {
    const m = getFixture(s, id);
    Object.assign(m, { status: 'scheduled', board: null, homeLegs: 0, awayLegs: 0, homeAvg: null, awayAvg: null, startedAt: null, finishedAt: null });
    if (m.stage !== 'league') {
      s.fixtures = resolveKnockout(s.fixtures);
      updatePhaseAfterKnockout(s);
    }
  });
}

// ---------- 3-dart averages ----------

/** Highest possible 3-dart average (three treble 20s every visit). */
export const MAX_AVERAGE = 180;

function storedAverage(v) {
  const n = typeof v === 'number' ? v : v == null || v === '' ? null : Number(v);
  return n === null || !Number.isFinite(n) ? null : n;
}

/**
 * Parse what the organiser typed: "54.3", "54,3", " 61 " → number (2 dp);
 * empty → null (clears it). Anything else → NaN.
 */
export function parseAverage(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().replace(',', '.');
  if (text === '') return null;
  if (!/^\d{1,3}(\.\d*)?$/.test(text)) return NaN;
  const n = Number(text);
  return n >= 0 && n <= MAX_AVERAGE ? Math.round(n * 100) / 100 : NaN;
}

/**
 * Record a team's 3-dart average for a live or finished match.
 * `value` may be a number or the raw text from an input; empty clears it.
 */
export function setAverage(state, id, side, value) {
  if (side !== 'home' && side !== 'away') fail('Side must be home or away.');
  const avg = typeof value === 'number' ? parseAverage(String(value)) : parseAverage(value);
  if (Number.isNaN(avg)) fail(`A 3-dart average must be a number from 0 to ${MAX_AVERAGE}, e.g. 54.3.`);
  return mutate(state, (s) => {
    const f = getFixture(s, id);
    if (f.status === 'scheduled') fail('Averages can be recorded once the match has started.');
    f[side === 'home' ? 'homeAvg' : 'awayAvg'] = avg;
  });
}

// ---------- knockout ----------

export function startKnockout(state, seeds, { force = false } = {}) {
  if (state.phase !== 'league') fail('The knockout can only start from the league phase.');
  if (liveFixtures(state).length) fail('Finish the live matches first.');
  if (!force && !canStartKnockout(state)) fail('Not all league matches have been played.');
  if (!Array.isArray(seeds) || seeds.some((id) => !teamById(state, id))) fail('Pick four teams.');
  return mutate(state, (s) => {
    // Unplayed league matches are dropped when forcing.
    s.fixtures = s.fixtures.filter((f) => f.stage !== 'league' || f.status === 'done');
    const startOrder = Math.max(0, ...s.fixtures.map((f) => f.order)) + 1;
    s.fixtures.push(...createKnockoutFixtures(seeds, { thirdPlace: s.config.thirdPlace, startOrder }));
    s.seeds = seeds.slice();
    s.phase = 'knockout';
  });
}

/** Undo "start knockout" while no knockout match has started. */
export function backToLeague(state) {
  if (state.phase !== 'knockout') fail('Only possible during the knockout.');
  if (knockoutFixtures(state).some((f) => f.status !== 'scheduled')) fail('Knockout matches have already been played.');
  return mutate(state, (s) => {
    s.fixtures = s.fixtures.filter((f) => f.stage === 'league');
    s.seeds = null;
    s.phase = 'league';
  });
}

// ---------- reset ----------

export function resetTournament(state, { keepTeams = true, keepConfig = true } = {}) {
  return {
    ...createTournament(keepConfig ? state.config : DEFAULT_CONFIG, keepTeams ? state.teams : []),
    rev: state.rev,
  };
}
