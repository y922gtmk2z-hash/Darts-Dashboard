// Data layer. Small interface — get / set / subscribe — over a pluggable
// adapter. The localStorage adapter keeps windows in the same browser in sync
// with BroadcastChannel (+ the `storage` event as a fallback). A remote adapter
// (e.g. Firebase) could implement the same adapter shape later.
//
// Adapter shape:
//   persistent: boolean            can it survive a reload?
//   load(): object|null
//   save(state): void              throws if it could not be saved
//   loadHistory(): array
//   saveHistory(list): void
//   listen(onState, onHello): void receive states / "hello" requests from other windows
//   broadcast(state): void
//   hello(): void                  ask other windows for their state

export const STORAGE_KEY = 'dartsDashboard.state.v1';
export const HISTORY_KEY = 'dartsDashboard.history.v1';
export const CHANNEL_NAME = 'dartsDashboard.v1';
export const MAX_HISTORY = 25;

export function storageAvailable() {
  try {
    const k = '__darts_test__';
    globalThis.localStorage.setItem(k, '1');
    globalThis.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export function createLocalStorageAdapter({
  key = STORAGE_KEY,
  historyKey = HISTORY_KEY,
  channelName = CHANNEL_NAME,
} = {}) {
  const persistent = storageAvailable();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null;
  const ls = persistent ? globalThis.localStorage : null;

  const readJSON = (k) => {
    try {
      const raw = ls?.getItem(k);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  return {
    persistent,
    load: () => readJSON(key),
    save(state) {
      if (!ls) throw new Error('Browser storage is unavailable.');
      ls.setItem(key, JSON.stringify(state));
    },
    loadHistory: () => {
      const h = readJSON(historyKey);
      return Array.isArray(h) ? h : [];
    },
    saveHistory(list) {
      if (!ls) return;
      // On quota errors drop the oldest snapshots until it fits.
      let items = list.slice();
      while (items.length) {
        try {
          ls.setItem(historyKey, JSON.stringify(items));
          return;
        } catch {
          items = items.slice(Math.ceil(items.length / 4));
        }
      }
      try { ls.removeItem(historyKey); } catch { /* ignore */ }
    },
    broadcast(state) {
      try { channel?.postMessage({ type: 'state', state }); } catch { /* ignore */ }
    },
    hello() {
      try { channel?.postMessage({ type: 'hello' }); } catch { /* ignore */ }
    },
    announceAdmin(id) {
      try { channel?.postMessage({ type: 'admin', id }); } catch { /* ignore */ }
    },
    listen(onState, onHello, onAdmin) {
      if (channel) {
        channel.addEventListener('message', (e) => {
          const msg = e.data;
          if (msg?.type === 'state') onState(msg.state);
          else if (msg?.type === 'hello') onHello?.();
          else if (msg?.type === 'admin') onAdmin?.(msg.id);
        });
      }
      globalThis.addEventListener?.('storage', (e) => {
        if (e.key !== key || !e.newValue) return;
        try { onState(JSON.parse(e.newValue)); } catch { /* ignore */ }
      });
    },
  };
}

/** In-memory adapter (tests, or a fallback). */
export function createMemoryAdapter() {
  let saved = null;
  let history = [];
  return {
    persistent: false,
    load: () => saved,
    save: (s) => { saved = JSON.parse(JSON.stringify(s)); },
    loadHistory: () => history,
    saveHistory: (h) => { history = h.slice(); },
    broadcast() {},
    hello() {},
    announceAdmin() {},
    listen() {},
  };
}

/**
 * @param adapter   see shape above
 * @param normalize (raw) => state|null — validates/migrates loaded data
 * @param readOnly  TV windows never write
 */
export function createStore({ adapter, normalize = (x) => x, readOnly = false } = {}) {
  let state = normalize(adapter.load());
  let history = readOnly ? [] : adapter.loadHistory().filter((h) => h && h.state);
  let lastSavedAt = state ? state.updatedAt ?? null : null;
  let saveError = null;
  const subs = new Set();
  const instanceId = Math.random().toString(36).slice(2);
  const seenAdmins = new Set();

  const emit = (meta) => {
    for (const fn of subs) {
      try { fn(state, meta); } catch (e) { console.error(e); }
    }
  };

  function persist(next, { label = 'Change', record = true } = {}) {
    if (readOnly) throw new Error('This window is read-only.');
    const prev = state;
    state = { ...next, rev: (prev?.rev ?? 0) + 1, updatedAt: Date.now() };
    try {
      adapter.save(state);
      lastSavedAt = state.updatedAt;
      saveError = null;
    } catch (e) {
      saveError = e;
    }
    adapter.broadcast(state);
    if (record) {
      history.push({ at: state.updatedAt, label, state });
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      adapter.saveHistory(history);
    }
    emit({ source: 'local', label, prev });
    return state;
  }

  adapter.listen(
    (incoming) => {
      const next = normalize(incoming);
      if (!next) return;
      const newer = !state || next.id !== state.id || (next.rev ?? 0) > (state.rev ?? 0);
      if (!newer) return;
      const prev = state;
      state = next;
      lastSavedAt = next.updatedAt ?? lastSavedAt;
      emit({ source: 'remote', prev });
    },
    () => {
      if (!readOnly && state) adapter.broadcast(state);
    },
    (otherId) => {
      if (readOnly || otherId === instanceId) return;
      if (!seenAdmins.has(otherId)) {
        seenAdmins.add(otherId);
        adapter.announceAdmin(instanceId); // let the newcomer know about us too
      }
      emit({ source: 'other-admin' });
    },
  );

  if (readOnly) adapter.hello();
  else adapter.announceAdmin(instanceId);

  return {
    get: () => state,
    set: (next, opts) => persist(next, opts),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    /** Revert to the snapshot before the last recorded change. */
    undo() {
      if (history.length < 2) return false;
      const popped = history.pop();
      const prev = history[history.length - 1];
      persist(prev.state, { label: `Undo: ${popped.label}`, record: false });
      adapter.saveHistory(history);
      return popped.label;
    },
    canUndo: () => history.length >= 2,
    history: () => history.slice(),
    restore(index) {
      const h = history[index];
      if (!h) throw new Error('Snapshot not found.');
      return persist(h.state, { label: `Restored snapshot from ${new Date(h.at).toLocaleTimeString()}` });
    },
    get persistent() { return adapter.persistent; },
    get lastSavedAt() { return lastSavedAt; },
    get saveError() { return saveError; },
  };
}
