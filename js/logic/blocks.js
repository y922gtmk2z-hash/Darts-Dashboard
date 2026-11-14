// "2 on, 1 off" fixtures: every team plays its matches in pairs — two in a
// row — then rests, never playing three in a row.
//
// Time is divided into slots; in each slot Board 1 and Board 2 each host one
// match (4 teams play). With n teams a team is busy 4/n of the time, so the
// natural rest after each pair is n/2 - 2 slots: 6 teams → exactly 1 off,
// 8 → 2 off, 10 → 3 off. Each team may have one single match (needed at the
// very start, and when a team plays an odd number of matches); with 4–5
// teams a rest after every pair can't keep both boards busy, so those get
// the best compromise.
import { roundRobinPairings } from './fixtures.js';
import { seededRandom } from './util.js';

const RUN = 2; // matches in a row

/** The rest after each pair of matches that the team count allows. */
export function idealRest(teamCount) {
  return Math.max(1, Math.round(teamCount / 2) - RUN);
}

function runsOf(slots, t) {
  const seq = slots.map((sl) => sl.some((m) => m.homeId === t || m.awayId === t));
  const runs = [];
  for (let i = 0; i < seq.length;) {
    let j = i;
    while (j < seq.length && seq[j] === seq[i]) j++;
    runs.push({ on: seq[i], len: j - i, start: i, end: j });
    i = j;
  }
  return runs;
}

/**
 * Check a slot schedule (lower score is better).
 *  tooMany   — matches beyond 2 in a row (the hard rule)
 *  extraSingles — single matches beyond the one each team is allowed
 *  restOff   — total slots by which rests between pairs differ from the ideal
 *  halfSlots — slots (other than the last) with only one board in use
 */
export function scoreBlocks(slots, teamIds) {
  const ideal = idealRest(teamIds.length);
  const detail = { tooMany: 0, extraSingles: 0, restOff: 0, halfSlots: 0, shortRests: 0 };
  for (const t of teamIds) {
    const runs = runsOf(slots, t);
    const on = runs.filter((r) => r.on);
    let singles = 0;
    on.forEach((r, i) => {
      if (r.len > RUN) detail.tooMany += r.len - RUN;
      // A single as the team's very last match is just the tournament ending.
      if (r.len === 1 && i !== on.length - 1) singles++;
    });
    detail.extraSingles += Math.max(0, singles - 1);
    for (const r of runs) {
      if (r.on || r.start === 0 || r.end === slots.length) continue;
      detail.restOff += Math.abs(r.len - ideal);
      if (r.len < ideal) detail.shortRests++;
    }
  }
  detail.halfSlots = slots.slice(0, -1).filter((sl) => sl.length < 2).length;
  const score = detail.tooMany * 1000 + detail.extraSingles * 60 + detail.shortRests * 30 + detail.restOff * 3 + detail.halfSlots * 15;
  return { score, ...detail };
}

/**
 * Depth-first search, slot by slot, under hard rules:
 *  - a team that played the previous slot once must play again — unless it has
 *    no matches left or uses its one allowed single;
 *  - nobody plays 3 in a row;
 *  - a team starts a new pair only after resting at least `minRest` slots;
 *  - both boards are busy in every slot except the last.
 * Backtracks on dead ends; gives up after `budget` steps (caller retries).
 */
export function searchBlocks(teamIds, double, minRest, rand, budget) {
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const left = new Map();
  for (const m of roundRobinPairings(teamIds, { double })) {
    const k = pairKey(m.homeId, m.awayId);
    if (!left.has(k)) left.set(k, []);
    left.get(k).push(m);
  }
  const owed = new Map(teamIds.map((t) => [t, 0]));
  for (const l of left.values()) for (const m of l) { owed.set(m.homeId, owed.get(m.homeId) + 1); owed.set(m.awayId, owed.get(m.awayId) + 1); }
  let remaining = [...owed.values()].reduce((a, b) => a + b, 0) / 2;
  const run = new Map(teamIds.map((t) => [t, 0]));
  const rest = new Map(teamIds.map((t) => [t, 99]));
  const singleUsed = new Map(teamIds.map((t) => [t, 0]));
  const slots = [];
  let nodes = 0;

  const canMeet = (a, b) => (left.get(pairKey(a, b))?.length ?? 0) > 0;
  const take = (a, b) => {
    const m = left.get(pairKey(a, b)).shift();
    owed.set(a, owed.get(a) - 1); owed.set(b, owed.get(b) - 1); remaining--;
    return m;
  };
  const putBack = (m) => {
    left.get(pairKey(m.homeId, m.awayId)).unshift(m);
    owed.set(m.homeId, owed.get(m.homeId) + 1); owed.set(m.awayId, owed.get(m.awayId) + 1); remaining++;
  };

  function candidates() {
    const cont = teamIds.filter((t) => run.get(t) === 1 && owed.get(t) > 0);
    const must = new Set(cont.filter((t) => singleUsed.get(t) > 0));
    const fresh = teamIds
      .filter((t) => run.get(t) === 0 && rest.get(t) >= minRest && owed.get(t) > 0)
      .sort((a, b) => rest.get(b) - rest.get(a) || owed.get(b) - owed.get(a) || rand() - 0.5)
      .slice(0, 8);
    const pool = [...cont, ...fresh];
    const pairs = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) if (canMeet(pool[i], pool[j])) pairs.push([pool[i], pool[j]]);
    const out = [];
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const four = [...pairs[i], ...pairs[j]];
        if (new Set(four).size !== 4) continue;
        if ([...must].some((t) => !four.includes(t))) continue;
        // Continuing teams left out would use up their single — at most one each.
        const dropped = cont.filter((t) => !four.includes(t));
        // Look one slot ahead: at least 4 teams must be able to play next.
        if (remaining > 2) {
          const after = teamIds.filter((t) => {
            const r = four.includes(t) ? run.get(t) + 1 : 0;
            const re = four.includes(t) ? 0 : rest.get(t) + 1;
            const o = owed.get(t) - (four.includes(t) ? 1 : 0);
            return o > 0 && r < RUN && (r === 1 || re >= minRest);
          });
          if (after.length < 4) continue;
        }
        out.push([pairs[i], pairs[j], dropped]);
      }
    }
    const score = ([p, q, dropped]) => {
      let v = rand() - dropped.length * 4;
      for (const pr of [p, q]) {
        if (double && left.get(pairKey(...pr)).length === 2) v += 3; // first meetings first
        for (const t of pr) v += owed.get(t) * 0.4 + Math.min(rest.get(t), 9) * 0.3 + (run.get(t) === 1 ? 5 : 0);
      }
      return v;
    };
    return out.map((c) => [score(c), c]).sort((x, y) => y[0] - x[0]).slice(0, 8).map((x) => x[1]);
  }

  const advance = (playing, dropped) => {
    const saved = teamIds.map((t) => [t, run.get(t), rest.get(t), singleUsed.get(t)]);
    for (const t of dropped) singleUsed.set(t, singleUsed.get(t) + 1);
    for (const t of teamIds) {
      if (playing.has(t)) { run.set(t, run.get(t) + 1); rest.set(t, 0); }
      else { run.set(t, 0); rest.set(t, rest.get(t) + 1); }
    }
    return () => { for (const [t, r, re, su] of saved) { run.set(t, r); rest.set(t, re); singleUsed.set(t, su); } };
  };

  function step() {
    if (remaining === 0) return true;
    if (++nodes > budget) return false;
    if (remaining === 1) {
      // The very last match may stand alone.
      for (const l of left.values()) {
        if (!l.length) continue;
        const m = l[0];
        if (run.get(m.homeId) < RUN && run.get(m.awayId) < RUN) { slots.push([take(m.homeId, m.awayId)]); return true; }
      }
      return false;
    }
    for (const [p, q, dropped] of candidates()) {
      const m1 = take(...p);
      const m2 = take(...q);
      const undo = advance(new Set([...p, ...q]), dropped);
      slots.push([m1, m2]);
      if (step()) return true;
      slots.pop();
      undo();
      putBack(m2);
      putBack(m1);
      if (nodes > budget) return false;
    }
    return false;
  }
  return step() ? slots : null;
}

/** Fallback: greedy slot filling with the same preferences (never fails). */
function buildGreedy(teamIds, double, rand) {
  const matches = roundRobinPairings(teamIds, { double }).sort(() => rand() - 0.5);
  const run = new Map(teamIds.map((t) => [t, 0]));
  const rest = new Map(teamIds.map((t) => [t, 99]));
  const ideal = idealRest(teamIds.length);
  const slots = [];
  while (matches.length) {
    const slot = [];
    for (let pos = 0; pos < 2; pos++) {
      const used = new Set(slot.flatMap((m) => [m.homeId, m.awayId]));
      let best = -1;
      let bestV = -Infinity;
      matches.forEach((m, i) => {
        if (used.has(m.homeId) || used.has(m.awayId) || run.get(m.homeId) >= RUN || run.get(m.awayId) >= RUN) return;
        let v = rand();
        for (const t of [m.homeId, m.awayId]) v += run.get(t) === 1 ? 100 : rest.get(t) >= ideal ? 20 + Math.min(rest.get(t), 9) : -30;
        if (v > bestV) { bestV = v; best = i; }
      });
      if (best >= 0) slot.push(matches.splice(best, 1)[0]);
    }
    if (!slot.length) slot.push(matches.shift());
    const playing = new Set(slot.flatMap((m) => [m.homeId, m.awayId]));
    for (const t of teamIds) {
      if (playing.has(t)) { run.set(t, run.get(t) + 1); rest.set(t, 0); } else { run.set(t, 0); rest.set(t, rest.get(t) + 1); }
    }
    slots.push(slot);
  }
  return slots;
}

/**
 * Give each slot's two matches different boards so that (when playing twice)
 * every pair meets once on each board, and teams' board counts stay even.
 * Each slot has one free choice: which of its matches takes Board 1.
 */
export function assignBoards(slots, double) {
  const n = slots.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const parity = new Array(n).fill(0);
  const find = (i) => {
    if (parent[i] === i) return [i, 0];
    const [root, p] = find(parent[i]);
    parent[i] = root;
    parity[i] ^= p;
    return [root, parity[i]];
  };
  const union = (a, b, want) => {
    const [ra, pa] = find(a);
    const [rb, pb] = find(b);
    if (ra === rb) return (pa ^ pb) === want;
    parent[rb] = ra;
    parity[rb] = pa ^ pb ^ want;
    return true;
  };
  if (double) {
    const seen = new Map();
    slots.forEach((sl, s) => sl.forEach((m, pos) => {
      const k = [m.homeId, m.awayId].sort().join('|');
      if (seen.has(k)) {
        const [s0, p0] = seen.get(k);
        union(s0, s, 1 ^ p0 ^ pos); // boards must differ
      } else seen.set(k, [s, pos]);
    }));
  }
  const comps = new Map();
  for (let s = 0; s < n; s++) {
    const [root, p] = find(s);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root).push([s, p]);
  }
  const diff = new Map();
  const flip = new Array(n).fill(0);
  const boardOf = (pos, f) => ((pos ^ f) === 0 ? 1 : 2);
  for (const members of comps.values()) {
    let bestCost = Infinity;
    let bestRootFlip = 0;
    for (const rootFlip of [0, 1]) {
      const d = new Map(diff);
      for (const [s, p] of members) {
        slots[s].forEach((m, pos) => {
          const delta = boardOf(pos, rootFlip ^ p) === 1 ? 1 : -1;
          for (const t of [m.homeId, m.awayId]) d.set(t, (d.get(t) ?? 0) + delta);
        });
      }
      const cost = [...d.values()].reduce((a, v) => a + Math.abs(v), 0);
      if (cost < bestCost) { bestCost = cost; bestRootFlip = rootFlip; }
    }
    for (const [s, p] of members) {
      flip[s] = bestRootFlip ^ p;
      slots[s].forEach((m, pos) => {
        const delta = boardOf(pos, flip[s]) === 1 ? 1 : -1;
        for (const t of [m.homeId, m.awayId]) diff.set(t, (diff.get(t) ?? 0) + delta);
      });
    }
  }
  return slots.map((sl, s) => sl.map((m, pos) => ({ ...m, plannedBoard: boardOf(pos, flip[s]) })));
}

/**
 * Plan a league in "2 on, 1 off" blocks. Returns matches in play order with
 * `round` = slot number (two matches share a slot, one per board), plus a
 * quality report. Tries an exact plan at the ideal rest first, then accepts
 * shorter rests, then falls back to the best greedy plan.
 */
export function planBlocks(teamIds, { double = false, attempts = 25, seed = 1, budget = 3000 } = {}) {
  const rand = seededRandom(seed);
  let slots = null;
  const ideal = idealRest(teamIds.length);
  // Longer rests are a bonus, not the rule (the rule is: at least 1 off) — try them briefly.
  const tries = [...new Map([[ideal, 4], [Math.max(1, ideal - 1), 4], [1, attempts]])];
  for (const [minRest, n] of tries) {
    for (let a = 0; a < n && !slots; a++) slots = searchBlocks(teamIds, double, minRest, rand, budget);
    if (slots) break;
  }
  if (!slots) {
    let best = null;
    for (let a = 0; a < 200; a++) {
      const s = buildGreedy(teamIds, double, rand);
      const q = scoreBlocks(s, teamIds);
      if (!best || q.score < best.q.score) best = { s, q };
    }
    slots = best.s;
  }
  const quality = scoreBlocks(slots, teamIds);
  const planned = assignBoards(slots, double);
  const out = [];
  planned.forEach((sl, s) => {
    sl.slice().sort((x, y) => x.plannedBoard - y.plannedBoard).forEach((m) => out.push({ ...m, round: s + 1 }));
  });
  return { matches: out, quality };
}

/** Slots as they stand in a fixture list: the k-th match on each board run together. */
export function slotsFromFixtures(fixtures) {
  const sorted = fixtures.slice().sort((a, b) => a.order - b.order);
  const b1 = sorted.filter((f) => f.plannedBoard !== 2);
  const b2 = sorted.filter((f) => f.plannedBoard === 2);
  const slots = [];
  for (let k = 0; k < Math.max(b1.length, b2.length); k++) slots.push([b1[k], b2[k]].filter(Boolean));
  return slots;
}
