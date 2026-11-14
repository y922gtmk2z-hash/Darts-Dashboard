// League fixture generation: circle-method round robin + two-board friendly ordering.

/**
 * Circle method. Returns [{round, homeId, awayId}] for a single round robin
 * (or double, with home/away swapped in the second half).
 * Odd team counts get a bye (that team simply has no match that round).
 */
export function roundRobinPairings(teamIds, { double = false } = {}) {
  const ids = [...teamIds];
  if (ids.length < 2) return [];
  if (ids.length % 2) ids.push(null); // bye
  const n = ids.length;
  const rounds = n - 1;
  const half = n / 2;
  const out = [];
  let arr = ids;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < half; i++) {
      let home = arr[i];
      let away = arr[n - 1 - i];
      if (home === null || away === null) continue;
      // Alternate who is listed first so nobody is always "home".
      if ((i === 0 && r % 2 === 1) || (i > 0 && i % 2 === 1)) [home, away] = [away, home];
      out.push({ round: r + 1, homeId: home, awayId: away });
    }
    // Keep arr[0] fixed, rotate the rest clockwise.
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  if (double) {
    const firstLeg = out.slice();
    for (const m of firstLeg) out.push({ round: m.round + rounds, homeId: m.awayId, awayId: m.homeId });
  }
  return out;
}

/**
 * Order matches for play on `boards` boards. Greedy: take the earliest-round
 * match whose teams did not play in the previous `boards` matches (so nobody
 * plays back-to-back and both boards can run at once). Relaxes the rest gap
 * only when nothing else is possible (e.g. 4 teams). Only looks one round
 * ahead so the schedule still roughly follows round order.
 */
export function orderMatches(matches, boards = 2, window = 1) {
  const remaining = matches.map((m, i) => ({ ...m, _i: i })).sort((a, b) => a.round - b.round || a._i - b._i);
  const out = [];
  while (remaining.length) {
    const minRound = remaining[0].round;
    let pick = -1;
    for (let look = boards; look >= 0 && pick < 0; look--) {
      const recent = new Set(out.slice(Math.max(0, out.length - look)).flatMap((m) => [m.homeId, m.awayId]));
      pick = remaining.findIndex(
        (m) => m.round <= minRound + window && !recent.has(m.homeId) && !recent.has(m.awayId),
      );
    }
    if (pick < 0) pick = 0;
    out.push(remaining.splice(pick, 1)[0]);
  }
  return out.map(({ _i, ...m }) => m);
}

/**
 * Plan the league for two boards.
 *
 * Single round robin: matches are ordered (no back-to-back where possible)
 * and alternate Board 1 / Board 2, so the pair of matches that run at the
 * same time never share a team.
 *
 * Double round robin: the first meeting of every pair is planned exactly as
 * above; the second meeting repeats it with home/away swapped and the OTHER
 * board — so every pair plays once on each board, and every team plays the
 * same number of matches on each board. The second half is rotated (by an
 * even number of slots, keeping board pairs intact) so nobody plays twice in
 * a row across the halfway point.
 */
export function planLeague(teamIds, { double = false, boards = 2 } = {}) {
  const firstHalf = balanceBoards(orderMatches(roundRobinPairings(teamIds, { double: false }), boards));
  if (!double) return firstHalf;
  const rounds = Math.max(0, ...firstHalf.map((m) => m.round));
  const mirror = (m) => ({ round: m.round + rounds, homeId: m.awayId, awayId: m.homeId, plannedBoard: m.plannedBoard === 1 ? 2 : 1 });
  const len = firstHalf.length;
  let best = null;
  for (let k = 0; k < len; k++) {
    const second = [...firstHalf.slice(k), ...firstHalf.slice(0, k)].map(mirror);
    const seam = [...firstHalf.slice(-boards), ...second.slice(0, boards)];
    // Never a team due on both boards at once; then no back-to-back; then a full rest.
    const score = sideBySideClashes([...firstHalf, ...second]) * 1000 + backToBackCount(seam, 1) * 10 + backToBackCount(seam, boards);
    if (!best || score < best.score) best = { second, score };
    if (score === 0) break;
  }
  return [...firstHalf, ...best.second];
}

/**
 * Give consecutive matches (the two that run side by side) different boards,
 * choosing which way round so every team's Board 1 / Board 2 counts stay as
 * even as possible.
 */
function balanceBoards(ordered) {
  const diff = new Map(); // teamId -> (#Board 1) - (#Board 2)
  const d = (t) => diff.get(t) ?? 0;
  const cost = (m, board) => {
    const delta = board === 1 ? 1 : -1;
    return Math.abs(d(m.homeId) + delta) + Math.abs(d(m.awayId) + delta) - Math.abs(d(m.homeId)) - Math.abs(d(m.awayId));
  };
  const apply = (m, board) => {
    for (const t of [m.homeId, m.awayId]) diff.set(t, d(t) + (board === 1 ? 1 : -1));
    return { ...m, plannedBoard: board };
  };
  const out = [];
  for (let i = 0; i < ordered.length; i += 2) {
    const [a, b] = [ordered[i], ordered[i + 1]];
    if (!b) {
      out.push(apply(a, cost(a, 1) <= cost(a, 2) ? 1 : 2));
      break;
    }
    const keep = cost(a, 1) + cost(b, 2);
    const swap = cost(a, 2) + cost(b, 1);
    if (keep <= swap) out.push(apply(a, 1), apply(b, 2));
    else out.push(apply(a, 2), apply(b, 1));
  }
  return improveBoardBalance(out);
}

/**
 * Local search: flip whole side-by-side pairs (or a lone last match) between
 * the boards while that makes teams' Board 1 / Board 2 counts more even.
 */
function improveBoardBalance(list) {
  const out = list.map((m) => ({ ...m }));
  const imbalance = () => {
    const d = new Map();
    for (const m of out) for (const t of [m.homeId, m.awayId]) d.set(t, (d.get(t) ?? 0) + (m.plannedBoard === 1 ? 1 : -1));
    let sum = 0;
    let worst = 0;
    for (const v of d.values()) { sum += Math.abs(v); worst = Math.max(worst, Math.abs(v)); }
    return worst * 1000 + sum;
  };
  const flip = (i) => {
    for (const j of [i, i + 1]) if (out[j]) out[j].plannedBoard = out[j].plannedBoard === 1 ? 2 : 1;
  };
  let current = imbalance();
  for (let pass = 0; pass < 50; pass++) {
    let improved = false;
    for (let i = 0; i < out.length; i += 2) {
      flip(i);
      const next = imbalance();
      if (next < current) { current = next; improved = true; } else flip(i);
    }
    if (!improved) break;
  }
  return out;
}

/** Build league fixture objects for a list of team ids. */
export function generateLeagueFixtures(teamIds, { double = false, boards = 2 } = {}) {
  return planLeague(teamIds, { double, boards }).map((m, i) => ({
    id: `L${i + 1}`,
    stage: 'league',
    round: m.round,
    homeId: m.homeId,
    awayId: m.awayId,
    plannedBoard: m.plannedBoard,
    board: null,
    status: 'scheduled',
    homeLegs: 0,
    awayLegs: 0,
    order: i + 1,
    startedAt: null,
    finishedAt: null,
  }));
}

/**
 * How often the k-th Board 1 match and the k-th Board 2 match (which run at
 * the same time) share a team.
 */
export function sideBySideClashes(fixtures) {
  const b1 = fixtures.filter((f) => f.plannedBoard === 1);
  const b2 = fixtures.filter((f) => f.plannedBoard === 2);
  let n = 0;
  for (let k = 0; k < Math.min(b1.length, b2.length); k++) {
    if ([b1[k].homeId, b1[k].awayId].some((t) => t === b2[k].homeId || t === b2[k].awayId)) n++;
  }
  return n;
}

/** Count of times a team appears in consecutive positions of an ordered list (lower is better). */
export function backToBackCount(ordered, gap = 1) {
  let count = 0;
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j <= Math.min(ordered.length - 1, i + gap); j++) {
      const a = ordered[i];
      const b = ordered[j];
      if ([a.homeId, a.awayId].some((t) => t === b.homeId || t === b.awayId)) count++;
    }
  }
  return count;
}
