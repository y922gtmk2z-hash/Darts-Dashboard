// League table. Pure: derived from teams + fixtures + config, never stored.
import { compareNames } from './util.js';

function emptyRow(team) {
  return {
    teamId: team.id,
    name: team.name,
    played: 0,
    won: 0,
    lost: 0,
    legsFor: 0,
    legsAgainst: 0,
    legDiff: 0,
    points: 0,
    form: [],
    h2hPoints: 0,
    h2hLegDiff: 0,
    position: 0,
    tiedWithPrev: false, // true = only separated from the row above by name
  };
}

const primary = (a, b) => b.points - a.points || b.legDiff - a.legDiff || b.legsFor - a.legsFor;

/**
 * Order: points -> leg difference -> legs won -> head-to-head -> name.
 * Head-to-head is a mini-league among the teams still level (points, then
 * leg difference in those matches).
 */
export function computeStandings(teams, fixtures, config) {
  const rows = new Map(teams.map((t) => [t.id, emptyRow(t)]));
  const win = config?.points?.win ?? 3;
  const loss = config?.points?.loss ?? 0;
  const done = fixtures
    .filter((f) => f.stage === 'league' && f.status === 'done')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0) || a.order - b.order);

  for (const f of done) {
    const h = rows.get(f.homeId);
    const a = rows.get(f.awayId);
    if (!h || !a) continue;
    const homeWon = f.homeLegs > f.awayLegs;
    for (const [row, legsFor, legsAgainst, won] of [
      [h, f.homeLegs, f.awayLegs, homeWon],
      [a, f.awayLegs, f.homeLegs, !homeWon],
    ]) {
      row.played++;
      row.legsFor += legsFor;
      row.legsAgainst += legsAgainst;
      if (won) row.won++;
      else row.lost++;
      row.points += won ? win : loss;
      row.form.push(won ? 'W' : 'L');
    }
  }

  const list = [...rows.values()];
  for (const r of list) {
    r.legDiff = r.legsFor - r.legsAgainst;
    r.form = r.form.slice(-5);
  }
  list.sort((a, b) => primary(a, b) || compareNames(a.name, b.name));

  // Head-to-head within groups level on points, leg diff and legs won.
  const result = [];
  for (let i = 0; i < list.length; ) {
    let j = i + 1;
    while (j < list.length && primary(list[i], list[j]) === 0) j++;
    const group = list.slice(i, j);
    if (group.length > 1) {
      const ids = new Set(group.map((r) => r.teamId));
      const byId = new Map(group.map((r) => [r.teamId, r]));
      for (const f of done) {
        if (!ids.has(f.homeId) || !ids.has(f.awayId)) continue;
        const h = byId.get(f.homeId);
        const a = byId.get(f.awayId);
        const homeWon = f.homeLegs > f.awayLegs;
        h.h2hPoints += homeWon ? win : loss;
        a.h2hPoints += homeWon ? loss : win;
        h.h2hLegDiff += f.homeLegs - f.awayLegs;
        a.h2hLegDiff += f.awayLegs - f.homeLegs;
      }
      group.sort(
        (a, b) => b.h2hPoints - a.h2hPoints || b.h2hLegDiff - a.h2hLegDiff || compareNames(a.name, b.name),
      );
    }
    result.push(...group);
    i = j;
  }

  result.forEach((r, i) => {
    r.position = i + 1;
    const prev = result[i - 1];
    r.tiedWithPrev = !!prev && primary(prev, r) === 0 && prev.h2hPoints === r.h2hPoints && prev.h2hLegDiff === r.h2hLegDiff;
  });
  return result;
}
