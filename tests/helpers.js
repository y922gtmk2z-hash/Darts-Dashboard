import { normalizeConfig } from '../js/logic/config.js';

export const config = normalizeConfig({});
export const teams = (...names) => names.map((n) => ({ id: n, name: n, players: ['', ''] }));
let n = 0;
/** A finished league fixture, e.g. result('A', 'B', 2, 1). */
export function result(homeId, awayId, homeLegs, awayLegs, stage = 'league') {
  n++;
  return {
    id: `X${n}`, stage, round: 1, homeId, awayId, board: null, status: 'done',
    homeLegs, awayLegs, order: n, startedAt: n, finishedAt: n,
  };
}
