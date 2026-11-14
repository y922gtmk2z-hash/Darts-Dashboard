// Knockout: seeding from the league table, semi-finals, final, optional 3rd place.
import { legsToWinFor } from './config.js';

/**
 * Top-4 seeds from computed standings. `tie` is true when 4th and 5th can
 * only be separated by name, so the organiser should decide manually.
 */
export function knockoutSeeding(rows, qualifiers = 4) {
  const seeds = rows.slice(0, qualifiers).map((r) => r.teamId);
  const cut = qualifiers - 1;
  const tie = rows.length > qualifiers && rows[qualifiers].tiedWithPrev;
  let tiedTeams = [];
  if (tie) {
    let start = cut;
    while (start > 0 && rows[start].tiedWithPrev) start--;
    let end = qualifiers;
    while (end + 1 < rows.length && rows[end + 1].tiedWithPrev) end++;
    tiedTeams = rows.slice(start, end + 1).map((r) => r.teamId);
  }
  return { seeds, tie, tiedTeams };
}

const blank = (id, stage, order) => ({
  id,
  stage,
  round: null,
  homeId: null,
  awayId: null,
  board: null,
  status: 'scheduled',
  homeLegs: 0,
  awayLegs: 0,
  order,
  startedAt: null,
  finishedAt: null,
});

/** Semi-finals 1 v 4 and 2 v 3, then (optional) 3rd place, then final. */
export function createKnockoutFixtures(seeds, { thirdPlace = false, startOrder = 1 } = {}) {
  if (seeds.length !== 4 || new Set(seeds).size !== 4 || seeds.some((s) => !s)) {
    throw new Error('Knockout needs four different teams.');
  }
  let order = startOrder;
  const sf1 = { ...blank('SF1', 'semi', order++), homeId: seeds[0], awayId: seeds[3] };
  const sf2 = { ...blank('SF2', 'semi', order++), homeId: seeds[1], awayId: seeds[2] };
  const out = [sf1, sf2];
  if (thirdPlace) out.push(blank('3P', 'third', order++));
  out.push(blank('F', 'final', order++));
  return out;
}

export function winnerOf(f) {
  if (!f || f.status !== 'done') return null;
  return f.homeLegs > f.awayLegs ? f.homeId : f.awayId;
}
export function loserOf(f) {
  if (!f || f.status !== 'done') return null;
  return f.homeLegs > f.awayLegs ? f.awayId : f.homeId;
}

/**
 * Fill final (and 3rd place) slots from semi results. Slots of a match that
 * has already started are left alone; if that would change who is in it an
 * error is thrown so the organiser fixes things in the right order.
 */
export function resolveKnockout(fixtures) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const sf1 = byId.get('SF1');
  const sf2 = byId.get('SF2');
  if (!sf1 || !sf2) return fixtures;
  const want = {
    F: [winnerOf(sf1), winnerOf(sf2)],
    '3P': [loserOf(sf1), loserOf(sf2)],
  };
  return fixtures.map((f) => {
    if (!(f.id in want)) return f;
    const [homeId, awayId] = want[f.id];
    if (f.homeId === homeId && f.awayId === awayId) return f;
    if (f.status !== 'scheduled') {
      throw new Error(`The ${f.id === 'F' ? 'final' : '3rd place match'} has already started — change or un-play it first.`);
    }
    return { ...f, homeId, awayId };
  });
}

/** Everything the TV / admin needs to draw the bracket. */
export function bracketView(fixtures) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const final = byId.get('F') ?? null;
  return {
    semis: [byId.get('SF1') ?? null, byId.get('SF2') ?? null],
    third: byId.get('3P') ?? null,
    final,
    championId: winnerOf(final),
    runnerUpId: loserOf(final),
    thirdId: winnerOf(byId.get('3P')),
  };
}

export function isDecided(f, config) {
  const need = legsToWinFor(config, f.stage);
  return (f.homeLegs === need && f.awayLegs < need) || (f.awayLegs === need && f.homeLegs < need);
}
