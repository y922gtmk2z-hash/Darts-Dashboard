import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, createMemoryAdapter, MAX_HISTORY } from '../js/store.js';

test('set bumps rev, persists, notifies subscribers', () => {
  const adapter = createMemoryAdapter();
  const store = createStore({ adapter });
  const seen = [];
  store.subscribe((s, meta) => seen.push([s.value, meta.source]));
  store.set({ id: 'a', value: 1 });
  store.set({ ...store.get(), value: 2 });
  assert.equal(store.get().rev, 2);
  assert.equal(adapter.load().value, 2);
  assert.deepEqual(seen, [[1, 'local'], [2, 'local']]);
  assert.ok(store.lastSavedAt);
});

test('undo reverts to the previous snapshot and keeps rev increasing', () => {
  const store = createStore({ adapter: createMemoryAdapter() });
  store.set({ id: 'a', value: 1 }, { label: 'one' });
  store.set({ ...store.get(), value: 2 }, { label: 'two' });
  assert.equal(store.undo(), 'two');
  assert.equal(store.get().value, 1);
  assert.equal(store.get().rev, 3);
  assert.equal(store.canUndo(), false);
});

test('history is capped and restorable; reload picks state back up', () => {
  const adapter = createMemoryAdapter();
  const store = createStore({ adapter });
  for (let i = 0; i < MAX_HISTORY + 10; i++) store.set({ id: 'a', value: i });
  assert.equal(store.history().length, MAX_HISTORY);
  store.restore(0);
  assert.equal(store.get().value, 10);
  const reopened = createStore({ adapter });
  assert.equal(reopened.get().value, 10);
  assert.equal(reopened.history().length, MAX_HISTORY);
});

test('a failing save is reported, not thrown', () => {
  const adapter = { ...createMemoryAdapter(), save() { throw new Error('quota'); } };
  const store = createStore({ adapter });
  store.set({ id: 'a' });
  assert.equal(store.saveError.message, 'quota');
  assert.equal(store.get().id, 'a');
});

test('read-only store accepts newer remote states only', () => {
  let push;
  const adapter = { ...createMemoryAdapter(), listen(onState) { push = onState; } };
  const tv = createStore({ adapter, readOnly: true });
  assert.throws(() => tv.set({}));
  push({ id: 'a', rev: 5, v: 'x' });
  push({ id: 'a', rev: 4, v: 'old' });
  assert.equal(tv.get().v, 'x');
  push({ id: 'b', rev: 1, v: 'reset' }); // new tournament id always wins
  assert.equal(tv.get().v, 'reset');
});
