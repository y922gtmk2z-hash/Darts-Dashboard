// Small shared helpers. Pure, no DOM.

let counter = 0;
/** Short unique id. Not cryptographic; good enough for one tournament. */
export function uid(prefix = '') {
  counter = (counter + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6) + counter.toString(36);
}

/** Deep copy of plain JSON data. */
export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Deterministic PRNG (mulberry32) for tests and the simulator. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function compareNames(a, b) {
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}
