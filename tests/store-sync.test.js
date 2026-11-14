// The real localStorage + BroadcastChannel adapter, with an in-memory
// localStorage. Node 18+ provides BroadcastChannel, so two "windows" are two stores.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createLocalStorageAdapter, STORAGE_KEY, HISTORY_KEY } from '../js/store.js';
import * as T from '../js/logic/tournament.js';

class MemoryStorage {
  #m = new Map();
  #quota;
  constructor(quota = Infinity) { this.#quota = quota; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) {
    const size = [...this.#m].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0) + String(v).length;
    if (size > this.#quota) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    this.#m.set(k, String(v));
  }
  removeItem(k) { this.#m.delete(k); }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const names = () => ({ key: `k${++n}`, historyKey: `h${n}`, channelName: `c${n}` });

const open = [];
// Track every store so its BroadcastChannel is closed (otherwise Node never exits).
const track = (store) => { open.push(store); return store; };
beforeEach(() => { globalThis.localStorage = new MemoryStorage(); });
afterEach(() => { while (open.length) open.pop().close(); });

test('admin writes reach a TV window via BroadcastChannel and survive a reload', async () => {
  const opts = names();
  const admin = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState }));
  const tv = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState, readOnly: true }));
  const seen = [];
  tv.subscribe((s) => seen.push(s.teams.length));
  admin.set(T.addTeam(T.createTournament(), 'Alpha'));
  admin.set(T.addTeam(admin.get(), 'Bravo'));
  await tick();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(tv.get().teams.length, 2);
  const reopened = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState }));
  assert.equal(reopened.get().teams[1].name, 'Bravo');
  assert.equal(reopened.history().length, 2);
});

test('a TV opened after the admin asks for and receives the state (works even without storage)', async () => {
  const opts = names();
  const admin = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState }));
  admin.set(T.addTeam(T.createTournament(), 'Alpha'));
  globalThis.localStorage = undefined; // TV can't read storage at all
  const tv = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState, readOnly: true }));
  assert.equal(tv.get(), null);
  await tick();
  assert.equal(tv.get()?.teams[0].name, 'Alpha');
});

test('presence messages pass between windows; a second admin is detected both ways', async () => {
  const opts = names();
  const a1 = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState }));
  const tv = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState, readOnly: true }));
  const got = [];
  a1.onMessage((m) => got.push(m.type));
  tv.post({ type: 'tv-beat', at: 1 });
  let warned1 = false;
  a1.subscribe((_s, meta) => { if (meta?.source === 'other-admin') warned1 = true; });
  const a2 = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState }));
  let warned2 = false;
  a2.subscribe((_s, meta) => { if (meta?.source === 'other-admin') warned2 = true; });
  await tick(40);
  assert.deepEqual(got, ['tv-beat']);
  assert.ok(warned1 && warned2);
});

test('storage unavailable: store still works in memory and says so', () => {
  globalThis.localStorage = { setItem() { throw new Error('blocked'); }, getItem() { return null; }, removeItem() {} };
  const store = track(createStore({ adapter: createLocalStorageAdapter(names()), normalize: T.normalizeState }));
  assert.equal(store.persistent, false);
  store.set(T.createTournament());
  assert.ok(store.saveError);
  assert.equal(store.get().phase, 'setup');
});

test('history trims itself when storage is nearly full instead of failing the save', () => {
  const opts = names();
  globalThis.localStorage = new MemoryStorage(400_000);
  const store = track(createStore({ adapter: createLocalStorageAdapter(opts), normalize: T.normalizeState }));
  let s = T.createTournament();
  for (let i = 0; i < 16; i++) s = T.addTeam(s, `Team number ${i}`, ['Player one', 'Player two']);
  s = T.startLeague(s);
  for (let i = 0; i < 25; i++) store.set(T.updateTeam(s, s.teams[0].id, { name: `Renamed ${i}` }));
  assert.equal(store.saveError, null, 'main state always saved');
  const kept = JSON.parse(globalThis.localStorage.getItem(opts.historyKey) ?? '[]');
  assert.ok(kept.length > 0 && kept.length < 25, `history trimmed to ${kept.length}`);
  assert.equal(JSON.parse(globalThis.localStorage.getItem(opts.key)).teams[0].name, 'Renamed 24');
});

test('exported keys are stable (backups and recovery depend on them)', () => {
  assert.equal(STORAGE_KEY, 'dartsDashboard.state.v1');
  assert.equal(HISTORY_KEY, 'dartsDashboard.history.v1');
});
