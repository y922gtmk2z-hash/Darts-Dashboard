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

/** Build league fixture objects for a list of team ids. */
export function generateLeagueFixtures(teamIds, { double = false, boards = 2 } = {}) {
  const ordered = orderMatches(roundRobinPairings(teamIds, { double }), boards);
  return ordered.map((m, i) => ({
    id: `L${i + 1}`,
    stage: 'league',
    round: m.round,
    homeId: m.homeId,
    awayId: m.awayId,
    board: null,
    status: 'scheduled',
    homeLegs: 0,
    awayLegs: 0,
    order: i + 1,
    startedAt: null,
    finishedAt: null,
  }));
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
