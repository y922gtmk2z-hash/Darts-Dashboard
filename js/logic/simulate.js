// Demo data + a step-by-step simulator for rehearsals. Uses only public actions.
import * as T from './tournament.js';
import { knockoutSeeding } from './bracket.js';

export const DEMO_TEAMS = [
  ['Double Trouble', 'Sam Reid', 'Alex Moore'],
  ['The Bullseyes', 'Jo Patel', 'Chris Lowe'],
  ['Treble Makers', 'Mo Khan', 'Lee Grant'],
  ['Arrows of Fury', 'Kim Doyle', 'Pat Evans'],
  ['Checkout Charlies', 'Charlie Day', 'Charlie Fox'],
  ['Oche Dear', 'Robin Hart', 'Dee Walsh'],
  ['Shanghai Knights', 'Jamie Cole', 'Nico Ward'],
  ['Bust & Found', 'Terry Lamb', 'Ash Bell'],
  ['Madhouse', 'Rory Finch', 'Sky Nolan'],
  ['Flight Club', 'Jordan Ray', 'Sam Lees'],
  ['Tops & Tails', 'Ellis Ford', 'Max Shaw'],
  ['Board Silly', 'Quinn Lowe', 'Kit Marsh'],
  ['Wire Benders', 'Frankie Hale', 'Ray Dunn'],
  ['The Ton-Eighties', 'Morgan Lea', 'Toni Burke'],
  ['Nine Darters', 'Casey Penn', 'Drew Hall'],
  ['Pub Legends', 'Bobbie Kerr', 'Les Wynn'],
];

/** Fill the team list with demo teams (setup phase only). */
export function loadDemoTeams(state, count = 8) {
  let s = state;
  for (const [name, a, b] of DEMO_TEAMS) {
    if (s.teams.length >= count) break;
    if (s.teams.some((t) => t.name === name)) continue;
    s = T.addTeam(s, name, [a, b]);
  }
  return s;
}

/**
 * Advance the tournament by one small, realistic step:
 * fill a free board, else add a leg / finish a live match, else move phase on.
 * Returns the same object when there is nothing left to do.
 */
export function simulateStep(state, rand = Math.random) {
  if (state.phase === 'complete') return state;
  if (state.phase === 'setup') {
    const s = state.teams.length < 4 ? loadDemoTeams(state, 8) : state;
    return T.startLeague(s);
  }
  const live = T.liveFixtures(state);
  const decided = live.find((f) => T.matchIsDecided(state, f.id));
  if (decided) return T.finishMatch(state, decided.id);

  const next = T.nextUp(state);
  for (const board of [1, 2]) {
    if (!T.liveOnBoard(state, board) && next[board]) return T.startMatch(state, next[board].id, board);
  }
  if (live.length) {
    const f = live[Math.floor(rand() * live.length)];
    return T.adjustLegs(state, f.id, rand() < 0.5 ? 'home' : 'away', 1);
  }
  if (state.phase === 'league' && T.canStartKnockout(state)) {
    return T.startKnockout(state, knockoutSeeding(T.standings(state)).seeds);
  }
  return state;
}

/** Run steps until `stop(state)` is true or nothing changes. */
export function simulateUntil(state, stop, rand = Math.random, maxSteps = 20000) {
  let s = state;
  for (let i = 0; i < maxSteps && !stop(s); i++) {
    const n = simulateStep(s, rand);
    if (n === s) break;
    s = n;
  }
  return s;
}

const doneCount = (s) => s.fixtures.filter((f) => f.status === 'done').length;

/** Fast-forward until one more match has finished (or the tournament ends). */
export function simulateMatch(state, rand = Math.random) {
  const before = doneCount(state);
  return simulateUntil(state, (x) => doneCount(x) > before || x.phase === 'complete', rand);
}
