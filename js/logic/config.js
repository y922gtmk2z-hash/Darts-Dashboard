// Tournament rules. Everything here is editable from admin settings.

export const STAGES = ['league', 'semi', 'third', 'final'];

export const DEFAULT_CONFIG = Object.freeze({
  title: 'James Watkins Invitational',
  subtitle: '',
  accent: '#f2b632',
  gameType: '501 · double out',
  doubleRoundRobin: true, // every team plays every other team twice
  // 'spread': a rest between matches where possible.
  // 'pairs':  "2 on, 1 off" — every team plays 2 matches in a row, then rests.
  fixtureRule: 'spread',
  bestOf: Object.freeze({ league: 3, semi: 3, third: 3, final: 3 }),
  points: Object.freeze({ win: 3, loss: 0 }),
  qualifiers: 4, // fixed: top 4 -> semi-finals
  thirdPlace: false,
  finalAlone: true, // the final waits until every other match is finished
  showLogo: true,
  autoBackup: false, // download a JSON backup after every finished match
  boardNames: Object.freeze(['Board 1', 'Board 2']),
  // Keyboard shortcuts on the admin page. Key = +1 leg, Shift+key = -1 leg.
  keys: Object.freeze({ b1Home: 'q', b1Away: 'a', b2Home: 'p', b2Away: 'l' }),
});

const LEGACY_DEFAULT_TITLE = 'Doubles Darts Tournament';

export const MIN_TEAMS = 4;
export const MAX_TEAMS = 16;

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Best-of must be odd so a match always has a winner. */
export function normalizeBestOf(v, fallback = 3) {
  let n = clampInt(v, 1, 21, fallback);
  if (n % 2 === 0) n += 1;
  return n;
}

/** Merge a partial/old config over the defaults and sanitise every field. */
export function normalizeConfig(input = {}) {
  const c = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_CONFIG;
  const bestOf = {};
  for (const s of STAGES) bestOf[s] = normalizeBestOf(c.bestOf?.[s], d.bestOf[s]);
  const keys = {};
  for (const k of Object.keys(d.keys)) {
    const v = typeof c.keys?.[k] === 'string' ? c.keys[k].trim().toLowerCase() : '';
    keys[k] = v.length === 1 ? v : d.keys[k];
  }
  const boardNames = [0, 1].map((i) => {
    const v = c.boardNames?.[i];
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 30) : d.boardNames[i];
  });
  return {
    // Tournaments saved before branding used the old generic default title.
    title: typeof c.title === 'string' && c.title.trim() && c.title.trim() !== LEGACY_DEFAULT_TITLE ? c.title.trim().slice(0, 80) : d.title,
    subtitle: typeof c.subtitle === 'string' ? c.subtitle.trim().slice(0, 120) : d.subtitle,
    accent: /^#[0-9a-f]{6}$/i.test(c.accent ?? '') ? c.accent : d.accent,
    gameType: typeof c.gameType === 'string' ? c.gameType.trim().slice(0, 40) : d.gameType,
    doubleRoundRobin: typeof c.doubleRoundRobin === 'boolean' ? c.doubleRoundRobin : d.doubleRoundRobin,
    fixtureRule: c.fixtureRule === 'pairs' ? 'pairs' : 'spread',
    bestOf,
    points: {
      win: clampInt(c.points?.win, 0, 99, d.points.win),
      loss: clampInt(c.points?.loss, 0, 99, d.points.loss),
    },
    qualifiers: 4,
    thirdPlace: typeof c.thirdPlace === 'boolean' ? c.thirdPlace : d.thirdPlace,
    finalAlone: typeof c.finalAlone === 'boolean' ? c.finalAlone : d.finalAlone,
    showLogo: typeof c.showLogo === 'boolean' ? c.showLogo : d.showLogo,
    autoBackup: typeof c.autoBackup === 'boolean' ? c.autoBackup : d.autoBackup,
    boardNames,
    keys,
  };
}

export const bestOfFor = (config, stage) => config.bestOf[stage] ?? 3;
export const legsToWin = (bestOf) => Math.floor(bestOf / 2) + 1;
export const legsToWinFor = (config, stage) => legsToWin(bestOfFor(config, stage));
