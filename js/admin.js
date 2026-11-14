// Organiser controls. Writes to the store; the TV window follows automatically.
import { createStore, createLocalStorageAdapter } from './store.js';
import { APP_VERSION } from './version.js';
import * as T from './logic/tournament.js';
import { knockoutSeeding, bracketView, winnerOf } from './logic/bracket.js';
import { legsToWinFor, bestOfFor, MIN_TEAMS, MAX_TEAMS } from './logic/config.js';
import { loadDemoTeams, simulateStep, simulateMatch, simulateUntil } from './logic/simulate.js';
import {
  esc, stageName, slotName, playersText, teamText, teamBlock, slotBlock, fmtAvg, formatLine, legsFormat, phaseLabel, timeAgo, applyTheme, registerServiceWorker,
} from './view.js';

const LONG_NAME = 24; // longer team names get shortened with … on parts of the TV
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- store

const store = createStore({ adapter: createLocalStorageAdapter(), normalize: T.normalizeState });
if (!store.get()) store.set(T.createTournament(), { label: 'New tournament' });
const S = () => store.get();

let otherAdmin = false;
let autoplayTimer = null;

/** Run a pure action against the current state and save it. Errors become toasts. */
function act(label, fn) {
  try {
    const before = S();
    const next = fn(before);
    // Actions that change nothing (e.g. −1 at 0 legs) are not saved, so Undo
    // always undoes something visible.
    if (next && next !== before && JSON.stringify(next) !== JSON.stringify(before)) store.set(next, { label });
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

// ---------------------------------------------------------------- prefs (per viewer)

const prefs = (() => {
  const KEY = 'dartsDashboard.adminPrefs';
  let v = {};
  try { v = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { /* ignore */ }
  return {
    get: (k, d) => v[k] ?? d,
    set(k, val) {
      v[k] = val;
      try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ }
    },
  };
})();

let tab = prefs.get('tab', null) ?? (S().phase === 'setup' ? 'teams' : 'live');
let fixtureFilter = prefs.get('fixtureFilter', 'upcoming');
let fixtureTeam = prefs.get('fixtureTeam', '');
let fixtureBoard = prefs.get('fixtureBoard', 'all'); // 'all' | '1' | '2'

// ---------------------------------------------------------------- toasts & dialogs

function toast(message, kind = 'info', { action, timeout = kind === 'error' ? 7000 : 3500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.append(b);
  }
  const close = document.createElement('button');
  close.className = 'toast-x';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';
  close.onclick = () => el.remove();
  el.append(close);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

const dialog = $('#dialog');
/**
 * Modal dialog. buttons: [{label, value, kind, autofocus}]. Resolves with the
 * clicked value, or null on Esc. `onSubmit(form)` may return false to keep it open.
 */
function ask({ title, body = '', buttons = [{ label: 'OK', value: 'ok', kind: 'primary' }], onOpen, onSubmit, wide = false }) {
  return new Promise((resolve) => {
    dialog.className = wide ? 'wide' : '';
    dialog.innerHTML = `
      <form method="dialog" class="dlg">
        <h2>${esc(title)}</h2>
        <div class="dlg-body">${body}</div>
        <div class="dlg-actions">
          ${buttons.slice().reverse().map((b) => `<button ${b.value === 'cancel' ? 'type="button" data-cancel' : ''} value="${esc(b.value)}" class="${esc(b.kind ?? '')}" ${b.autofocus ? 'autofocus' : ''}>${esc(b.label)}</button>`).join('')}
        </div>
      </form>`;
    const form = $('form', dialog);
    // Buttons are in reverse DOM order (shown right-to-left) so Enter = the main action.
    for (const b of $$('[data-cancel]', form)) b.addEventListener('click', () => dialog.close('cancel'));
    form.addEventListener('submit', (e) => {
      const value = e.submitter?.value ?? buttons.find((b) => b.kind?.includes('primary'))?.value ?? 'ok';
      if (onSubmit && value !== 'cancel' && onSubmit(form, value) === false) {
        e.preventDefault();
        return;
      }
      dialog.returnValue = value;
    });
    dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
    onOpen?.(form);
  });
}

async function confirmAction(title, body, label = 'Confirm', kind = 'primary') {
  const v = await ask({
    title,
    body: `<p>${body}</p>`,
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label, value: 'yes', kind, autofocus: true },
    ],
  });
  return v === 'yes';
}

// ---------------------------------------------------------------- backup

function downloadBackup(reason = 'manual') {
  const s = S();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const safe = s.config.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'darts';
  const blob = new Blob([JSON.stringify({ app: 'darts-dashboard', exportedAt: Date.now(), reason, state: s }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}-backup-${stamp}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  prefs.set('lastExport', Date.now());
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file is not valid JSON.', 'error');
    return;
  }
  const next = T.normalizeState(data?.state ?? data);
  if (!next) {
    toast('That file does not look like a tournament backup.', 'error');
    return;
  }
  const problems = T.validateState(next);
  if (problems.length) {
    await ask({
      title: 'This backup has problems',
      body: `<p>It was <strong>not</strong> imported, so nothing has changed. Try an earlier backup file.</p>
        <ul class="problems">${problems.slice(0, 8).map((p) => `<li>${esc(p)}</li>`).join('')}${problems.length > 8 ? `<li>…and ${problems.length - 8} more</li>` : ''}</ul>`,
      buttons: [{ label: 'OK', value: 'ok', kind: 'primary', autofocus: true }],
    });
    return;
  }
  const ok = await confirmAction(
    'Import backup?',
    `This replaces the current tournament with “${esc(next.config.title)}” (${next.teams.length} teams, phase: ${phaseLabel(next.phase)}). The current state stays in the recovery history.`,
    'Import',
  );
  if (!ok) return;
  store.set(next, { label: `Imported ${file.name}` });
  toast('Backup imported.', 'success');
}

// ---------------------------------------------------------------- scoring

async function changeLegs(id, side, delta, { announce = false } = {}) {
  const before = S();
  const wasDecided = T.matchIsDecided(before, id);
  if (!act(delta > 0 ? 'Leg won' : 'Leg removed', (s) => T.adjustLegs(s, id, side, delta))) return;
  const after = T.fixtureById(S(), id);
  const prev = T.fixtureById(before, id);
  const changed = after.homeLegs !== prev.homeLegs || after.awayLegs !== prev.awayLegs;
  if (changed) {
    flash(id, side);
    if (announce) {
      // Scored from the keyboard while another tab is open: confirm what happened.
      toast(`${S().config.boardNames[after.board - 1]}: ${slotName(S(), after, 'home')} ${after.homeLegs}–${after.awayLegs} ${slotName(S(), after, 'away')}`, 'info', { timeout: 2500 });
    }
  }
  if (T.matchIsDecided(S(), id) && (!wasDecided || (delta > 0 && !changed))) promptFinish(id);
}

let finishOpen = false;
async function promptFinish(id) {
  if (finishOpen) return;
  finishOpen = true;
  const s = S();
  const f = T.fixtureById(s, id);
  const winner = slotName(s, f, f.homeLegs > f.awayLegs ? 'home' : 'away');
  let averages = null;
  const v = await ask({
    title: `${s.config.boardNames[f.board - 1]}: ${winner} win!`,
    body: `<p class="dlg-score"><strong>${slotBlock(s, f, 'home', { cls: 'end' })}</strong> <span class="num">${f.homeLegs} – ${f.awayLegs}</span> <strong>${slotBlock(s, f, 'away')}</strong></p>
           ${averageInputs(s, f)}
           <p class="muted">Finish the match and record the result? <kbd>Enter</kbd> finishes, <kbd>Esc</kbd> keeps it open.</p>`,
    buttons: [
      { label: 'Undo last leg', value: 'undo' },
      { label: 'Not yet', value: 'cancel' },
      { label: 'Finish match', value: 'finish', kind: 'primary', autofocus: true },
    ],
    onSubmit(form, value) {
      if (value !== 'finish') return true;
      averages = readAverages(form);
      return averages !== false;
    },
  });
  finishOpen = false;
  if (v === 'finish') finish(id, averages);
  else if (v === 'undo') {
    const side = T.fixtureById(S(), id).homeLegs > T.fixtureById(S(), id).awayLegs ? 'home' : 'away';
    act('Leg removed', (st) => T.adjustLegs(st, id, side, -1));
  }
}

/** Two "3-dart average" boxes for a dialog, prefilled from the match. */
function averageInputs(s, f) {
  const box = (side) => `<label class="avg-field">${slotBlock(s, f, side)}<span class="avg-label">3-dart average</span>
      <input name="${side}Avg" inputmode="decimal" autocomplete="off" placeholder="e.g. 54.3" value="${esc(fmtAvg(f[`${side}Avg`]))}"></label>`;
  return `<div class="avg-fields">${box('home')}${box('away')}</div>
    <p class="muted small-text">Optional — leave blank if you didn't track it.</p>`;
}

/** {home, away} from averageInputs, or false (with a message) if one is invalid. */
function readAverages(form) {
  const out = {};
  for (const side of ['home', 'away']) {
    const v = T.parseAverage(form[`${side}Avg`].value);
    if (Number.isNaN(v)) {
      toast(`A 3-dart average must be a number from 0 to ${T.MAX_AVERAGE}, e.g. 54.3.`, 'error');
      form[`${side}Avg`].focus();
      return false;
    }
    out[side] = v;
  }
  return out;
}

/** "Save result" on a match typed straight into the list (never started live). */
function saveTypedResult(id) {
  const val = (k) => $(`#d-${id}-${k}`)?.value.trim() ?? '';
  const [h, a] = [val('homeLegs'), val('awayLegs')];
  if (h === '' || a === '') {
    toast('Type both teams’ legs first.', 'error');
    $(`#d-${id}-${h === '' ? 'home' : 'away'}Legs`)?.focus();
    return;
  }
  const f = T.fixtureById(S(), id);
  if (!act(`Recorded ${stageName(f)}`, (s) => T.recordResult(s, id, Number(h), Number(a), { homeAvg: val('homeAvg'), awayAvg: val('awayAvg') }))) return;
  drafts.delete(id);
  const done = T.fixtureById(S(), id);
  toast(`${T.teamName(S(), winnerOf(done))} win ${Math.max(done.homeLegs, done.awayLegs)}–${Math.min(done.homeLegs, done.awayLegs)}.`, 'success', { action: { label: 'Undo', fn: undo }, timeout: 6000 });
  if (S().config.autoBackup) downloadBackup('after-match');
  if (S().phase === 'complete') toast(`🏆 ${T.teamName(S(), winnerOf(T.fixtureById(S(), 'F')))} are the champions!`, 'success', { timeout: 10000 });
}

function finish(id, averages = null) {
  const s = S();
  const f = T.fixtureById(s, id);
  const withAverages = (st) => (averages ? T.setAverage(T.setAverage(st, id, 'home', averages.home ?? ''), id, 'away', averages.away ?? '') : st);
  if (!act(`Finished ${stageName(f)}`, (st) => T.finishMatch(withAverages(st), id))) return;
  const done = T.fixtureById(S(), id);
  const winner = T.teamName(S(), winnerOf(done));
  toast(`${winner} win ${Math.max(done.homeLegs, done.awayLegs)}–${Math.min(done.homeLegs, done.awayLegs)}.`, 'success', {
    action: { label: 'Undo', fn: undo },
    timeout: 8000,
  });
  if (S().config.autoBackup) downloadBackup('after-match');
  if (S().phase === 'complete') toast(`🏆 ${winner} are the champions!`, 'success', { timeout: 10000 });
}

function undo() {
  const label = store.undo();
  if (label) toast(`Undone: ${label}`, 'info');
  else toast('Nothing to undo.', 'info');
}

function flash(id, side) {
  requestAnimationFrame(() => {
    const el = $(`[data-legs="${id}-${side}"]`);
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  });
}

// ---------------------------------------------------------------- render: frame

function render() {
  const s = S();
  applyTheme(s);
  document.title = `Admin · ${s.config.title}`;
  $('#title').textContent = s.config.title;
  const phaseEl = $('#phase');
  phaseEl.textContent = phaseLabel(s.phase);
  phaseEl.dataset.phase = s.phase;
  const { played, total } = T.leagueProgress(s);
  $('#progress').textContent = s.phase === 'league' ? `${played}/${total} league matches played` : '';
  $('#undo').disabled = !store.canUndo();
  $('#autoplay-stop').hidden = !autoplayTimer;
  renderBanners();
  renderSaved();

  for (const b of $$('.tabs [data-tab]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on) $('#main').setAttribute('aria-labelledby', b.id);
  }

  // Keep focus/caret across re-renders: by id, or by the button's data-* identity.
  const active = document.activeElement;
  const focusSel = active && $('#main').contains(active) ? focusSelector(active) : null;
  const sel = focusSel && active.id && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  // Text being typed (not yet committed with Enter / leaving the box) survives a redraw.
  const typing = focusSel && active.id && /^(INPUT|TEXTAREA)$/.test(active.tagName) && active.type !== 'checkbox' ? active.value : null;

  const views = { live: viewLive, fixtures: viewFixtures, table: viewTable, teams: viewTeams, settings: viewSettings, backup: viewBackup };
  for (const id of drafts.keys()) if (T.fixtureById(s, id)?.status !== 'scheduled') drafts.delete(id);
  for (const id of editing) if (T.fixtureById(s, id)?.status !== 'done') editing.delete(id);
  $('#main').innerHTML = (views[tab] ?? viewLive)(s);
  if (tab === 'live' && !scrolledToCurrent) {
    const current = $('#main .mcard.live') ?? $('#main .mcard.is-next') ?? $('#main .mcard.todo');
    if (current) {
      scrolledToCurrent = true;
      requestAnimationFrame(() => current.scrollIntoView({ block: 'center' }));
    }
  }

  if (focusSel) {
    const el = $(focusSel, $('#main'));
    if (el && !el.disabled) {
      if (typing !== null && 'value' in el) el.value = typing;
      el.focus({ preventScroll: true });
      if (sel && 'setSelectionRange' in el) { try { el.setSelectionRange(...sel); } catch { /* ignore */ } }
    } else if (el || focusSel.includes('data-action')) {
      $('#main').focus({ preventScroll: true });
    }
  }
}

function focusSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const keys = ['action', 'id', 'side', 'delta', 'board', 'boardView', 'scope', 'tab', 'filter', 'idx', 'draft'];
  const parts = keys.filter((k) => el.dataset[k] !== undefined).map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`);
  return parts.length ? parts.join('') : null;
}

function renderBanners() {
  const out = [];
  if (!store.persistent) {
    out.push(`<div class="banner error"><strong>Browser storage is unavailable</strong> (private window or blocked site data). Scores will be lost on refresh — open this page in a normal window, and export backups often.</div>`);
  } else if (store.saveError) {
    out.push(`<div class="banner error"><strong>Last change could not be saved:</strong> ${esc(store.saveError.message)}. Export a backup now.</div>`);
  }
  if (adminOutdated) {
    out.push(`<div class="banner warn"><strong>This admin page is out of date.</strong> A newer version of the app is open in another window. <button class="primary small" data-action="reload-page">Reload now</button> — your tournament is saved and comes straight back.</div>`);
  }
  if (otherAdmin) {
    out.push(`<div class="banner warn">The admin page is also open in another tab or window. Use only one admin window so changes don't clash. <button data-action="dismiss-other">Dismiss</button></div>`);
  }
  if (location.protocol === 'file:') {
    out.push(`<div class="banner warn">Opened from a file. Use the GitHub Pages link (or a local web server) so the TV window can sync.</div>`);
  }
  $('#banners').innerHTML = out.join('');
}

function renderSaved() {
  const el = $('#saved');
  if (!store.persistent || store.saveError) {
    el.className = 'saved bad';
    el.textContent = '⚠ Not saved';
    return;
  }
  el.className = 'saved ok';
  el.textContent = `✓ Saved ${timeAgo(store.lastSavedAt)}`;
  el.title = store.lastSavedAt ? new Date(store.lastSavedAt).toLocaleString() : '';
}

// ---------------------------------------------------------------- view: match day
// Every fixture, Board 1 and Board 2 side by side (row k = the k-th match on
// each board, which run at the same time). Scores and averages are entered
// right in the list.

const drafts = new Map(); // fixtureId -> { homeLegs, awayLegs, homeAvg, awayAvg } typed but not saved
const editing = new Set(); // finished fixtures open for correction
let scrolledToCurrent = false;

function viewLive(s) {
  if (s.phase === 'setup') {
    return `<section class="empty-state card">
      <h2>Nothing to score yet</h2>
      <p>Add at least ${MIN_TEAMS} teams, then generate the fixtures.</p>
      <button class="primary big" data-action="tab" data-tab="teams">Go to Teams</button>
    </section>`;
  }
  const next = T.nextUp(s);
  const league = s.fixtures.filter((f) => f.stage === 'league').sort(T.byOrder);
  const boardOf = (f) => (f.status === 'live' ? f.board : f.plannedBoard);
  const cols = [1, 2].map((b) => league.filter((f) => boardOf(f) === b));
  const either = league.filter((f) => boardOf(f) == null);
  const rows = Math.max(cols[0].length, cols[1].length);
  const ko = s.fixtures.filter((f) => f.stage !== 'league').sort(T.byOrder);
  const ctx = { next };
  const { played, total } = T.leagueProgress(s);

  const rowHtml = [];
  for (let k = 0; k < rows; k++) {
    const a = cols[0][k];
    const b = cols[1][k];
    const state = [a, b].some((f) => f?.status === 'live') ? 'live' : [a, b].every((f) => !f || f.status === 'done') ? 'done' : 'todo';
    rowHtml.push(`<div class="md-row ${state}">
      <div class="md-slot num" title="Time slot: these two matches run at the same time">${k + 1}</div>
      ${a ? matchCard(s, a, ctx) : '<div class="mcard empty"></div>'}
      ${b ? matchCard(s, b, ctx) : '<div class="mcard empty"></div>'}
    </div>`);
  }

  return `
    ${phaseCallToAction(s)}
    <div class="md-head">
      <div class="md-slot"></div>
      ${[1, 2].map((b) => boardHeader(s, b, next)).join('')}
    </div>
    <p class="kbd-help">Type a score and averages into any match and press <strong>Save result</strong> — or press <strong>▶ Start</strong> to show it live on the TV and score leg by leg.
      Keyboard for live matches: ${keyHelp(s)} · <kbd>Shift</kbd>+key removes a leg · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo
      ${s.phase === 'league' ? ` · <span class="num">${played}/${total}</span> league matches played` : ''}</p>
    ${league.length ? `<section class="md-list" aria-label="League fixtures by board">${rowHtml.join('')}</section>` : (s.phase === 'league' ? `<p class="muted card">${esc(idleMessage(s))}</p>` : '')}
    ${either.length ? `<h2 class="md-section">Either board</h2><section class="md-grid">${either.map((f) => matchCard(s, f, ctx)).join('')}</section>` : ''}
    ${ko.length ? `<h2 class="md-section">Knockout</h2><section class="md-grid">${ko.map((f) => matchCard(s, f, ctx)).join('')}</section>` : ''}`;
}

function boardHeader(s, b, next) {
  const name = esc(s.config.boardNames[b - 1]);
  const live = T.liveOnBoard(s, b);
  let body;
  if (live) {
    body = `<span class="tag live-tag">LIVE</span> <a href="#" data-action="scroll-to" data-id="${live.id}">${esc(slotName(s, live, 'home'))} <span class="num">${live.homeLegs}–${live.awayLegs}</span> ${esc(slotName(s, live, 'away'))}</a>`;
  } else if (next[b]) {
    body = `<span class="tag">Free</span> <a href="#" data-action="scroll-to" data-id="${next[b].id}">Next: ${esc(slotName(s, next[b], 'home'))} v ${esc(slotName(s, next[b], 'away'))}</a>`;
  } else if (next.waiting?.[b]) {
    body = `<span class="tag">Free</span> <span class="muted">Waiting for the other board (2 on, 1 off)</span>`;
  } else {
    body = `<span class="tag">Free</span>`;
  }
  return `<div class="md-board b${b}"><h2>${name}</h2><div class="md-board-status">${body}</div></div>`;
}

function teamLine(s, f, side, inner) {
  return `<div class="m-team ${side}">${slotBlock(s, f, side)}${inner}</div>`;
}

function avgInput(f, side, { id, value, change, extra = '' }) {
  return `<label class="m-avg"><span>avg</span><input id="${id}" ${change} inputmode="decimal" autocomplete="off" placeholder="–"
    value="${esc(value)}" aria-label="3-dart average" ${extra}></label>`;
}

function matchCard(s, f, { next }) {
  const need = legsToWinFor(s.config, f.stage);
  const head = (badge) => `<div class="m-head"><span class="m-label">${esc(stageName(f))}</span>${badge}${menuFor(s, f)}</div>`;
  const w = winnerOf(f);

  // ---- finished
  if (f.status === 'done' && !editing.has(f.id)) {
    const line = (side) => teamLine(s, f, side, `
      <span class="m-legs num ${w === (side === 'home' ? f.homeId : f.awayId) ? 'win' : ''}">${side === 'home' ? f.homeLegs : f.awayLegs}</span>
      <span class="m-avg-ro num" title="3-dart average">${fmtAvg(f[`${side}Avg`]) || '–'}</span>`);
    return `<article class="mcard done" id="m-${f.id}">${head('<span class="tag done">Played</span>')}
      ${line('home')}${line('away')}
      <div class="m-actions"><button class="small" data-action="md-edit" data-id="${f.id}">Edit result</button></div></article>`;
  }

  // ---- finished, being corrected
  if (f.status === 'done') {
    const opts = (v) => Array.from({ length: need + 1 }, (_, i) => `<option ${i === v ? 'selected' : ''}>${i}</option>`).join('');
    const line = (side) => teamLine(s, f, side, `
      <select id="e-${f.id}-${side}Legs" class="m-legs-in num" aria-label="Legs">${opts(side === 'home' ? f.homeLegs : f.awayLegs)}</select>
      ${avgInput(f, side, { id: `e-${f.id}-${side}Avg`, value: fmtAvg(f[`${side}Avg`]), change: '' })}`);
    return `<article class="mcard editing" id="m-${f.id}">${head('<span class="tag">Editing</span>')}
      ${line('home')}${line('away')}
      <div class="m-actions"><button class="small ghost" data-action="md-edit-cancel" data-id="${f.id}">Cancel</button>
        <button class="small primary" data-action="md-edit-save" data-id="${f.id}">Save</button></div></article>`;
  }

  // ---- live: leg by leg
  if (f.status === 'live') {
    const decided = T.matchIsDecided(s, f.id);
    const k = s.config.keys;
    const keys = f.board === 1 ? [k.b1Home, k.b1Away] : [k.b2Home, k.b2Away];
    const line = (side, key) => {
      const legs = side === 'home' ? f.homeLegs : f.awayLegs;
      return teamLine(s, f, side, `
        <span class="m-stepper">
          <button class="minus" data-action="leg" data-id="${f.id}" data-side="${side}" data-delta="-1" ${legs === 0 ? 'disabled' : ''} aria-label="Remove a leg">−</button>
          <span class="m-legs big num" data-legs="${f.id}-${side}">${legs}</span>
          <button class="plus" data-action="leg" data-id="${f.id}" data-side="${side}" data-delta="1" ${decided ? 'disabled' : ''} aria-label="Add a leg">+ <kbd>${esc(key.toUpperCase())}</kbd></button>
        </span>
        ${avgInput(f, side, { id: `avg-${f.id}-${side}`, value: fmtAvg(f[`${side}Avg`]), change: `data-change="avg" data-id="${f.id}" data-side="${side}"` })}`);
    };
    return `<article class="mcard live ${decided ? 'decided' : ''}" id="m-${f.id}">
      ${head(`<span class="tag live-tag">LIVE · ${esc(s.config.boardNames[f.board - 1])}</span>`)}
      ${line('home', keys[0])}${line('away', keys[1])}
      <div class="m-actions"><span class="muted small-text">${esc(legsFormat(bestOfFor(s.config, f.stage), { capital: true }))}</span>
        <button class="small ghost" data-action="cancel" data-id="${f.id}" title="Take it off the board; the score is cleared">Cancel</button>
        <button class="small primary" data-action="finish" data-id="${f.id}" ${decided ? '' : 'disabled'}>Finish match</button></div></article>`;
  }

  // ---- not played yet: type a result, or start it live
  const d = drafts.get(f.id) ?? {};
  const ready = f.homeId && f.awayId;
  const nextOn = [1, 2].find((b) => next[b]?.id === f.id);
  const waitingOn = [1, 2].find((b) => next.waiting?.[b]?.id === f.id);
  const badge = nextOn ? `<span class="tag next-tag">Next on ${esc(s.config.boardNames[nextOn - 1])}</span>`
    : waitingOn ? '<span class="tag">Next — waiting</span>' : '';
  const line = (side) => teamLine(s, f, side, ready ? `
    <input id="d-${f.id}-${side}Legs" class="m-legs-in num" type="number" min="0" max="${need}" inputmode="numeric" placeholder="–"
      data-draft="${side}Legs" data-id="${f.id}" value="${esc(d[`${side}Legs`] ?? '')}" aria-label="Legs">
    ${avgInput(f, side, { id: `d-${f.id}-${side}Avg`, value: d[`${side}Avg`] ?? '', change: `data-draft="${side}Avg" data-id="${f.id}"` })}` : '');
  const boards = f.stage === 'league' && f.plannedBoard ? [f.plannedBoard] : [1, 2];
  const startBtns = ready ? boards.filter((b) => canStartOn(s, f, b))
    .map((b) => `<button class="small ${nextOn === b ? 'primary' : ''}" data-action="start" data-id="${f.id}" data-board="${b}">▶ Start on ${esc(s.config.boardNames[b - 1])}</button>`).join('') : '';
  let why = '';
  if (waitingOn) {
    // "2 on, 1 off": this board's next match has a team still playing on the other board.
    const live = T.liveFixtures(s).filter((x) => [x.homeId, x.awayId].some((t) => t === f.homeId || t === f.awayId));
    const who = live.flatMap((x) => [x.homeId, x.awayId]).filter((t) => t === f.homeId || t === f.awayId).map((t) => T.teamName(s, t));
    if (who.length) why = `<p class="waiting-why">Starts when <strong>${esc(who.join(' & '))}</strong> finish${who.length === 1 ? 'es' : ''} on ${esc(s.config.boardNames[(live[0].board ?? 1) - 1])} (2 on, 1 off).</p>`;
  }
  return `<article class="mcard todo ${nextOn || waitingOn ? 'is-next' : ''}" id="m-${f.id}">${head(badge)}
    ${line('home')}${line('away')}${why}
    ${ready ? `<div class="m-actions">${startBtns}<button class="small" data-action="md-save" data-id="${f.id}" title="Record this result without starting it live">Save result</button></div>`
      : '<p class="muted small-text">Teams decided by earlier results.</p>'}
  </article>`;
}

/** The ⋯ menu: everything you can do to one fixture. */
function menuFor(s, f) {
  const items = [];
  if (f.status === 'scheduled' && f.homeId && f.awayId) {
    items.push(`<button data-action="play-next" data-id="${f.id}" data-scope="board">Play next on this board</button>`);
    items.push(`<button data-action="move" data-id="${f.id}" data-delta="-1" data-scope="board">Move earlier</button>`);
    items.push(`<button data-action="move" data-id="${f.id}" data-delta="1" data-scope="board">Move later</button>`);
  }
  if (f.status === 'scheduled' && f.stage === 'league' && s.phase === 'league') {
    const other = f.plannedBoard === 1 ? 2 : 1;
    items.push(`<button data-action="md-board" data-id="${f.id}" data-board="${other}">Move to ${esc(s.config.boardNames[other - 1])}</button>`);
    items.push(`<button data-action="fixture-swap" data-id="${f.id}">Swap home / away</button>`);
    items.push(`<button data-action="fixture-edit" data-id="${f.id}">Change teams…</button>`);
    items.push(`<button class="danger-text" data-action="fixture-remove" data-id="${f.id}">Delete match</button>`);
  }
  if (f.status === 'done') items.push(`<button class="danger-text" data-action="unplay" data-id="${f.id}">Un-play (back to the queue)</button>`);
  if (!items.length) return '';
  return `<details class="m-menu"><summary aria-label="More actions">⋯</summary><div class="m-menu-list">${items.join('')}</div></details>`;
}

function keyHelp(s) {
  const k = s.config.keys;
  const K = (c) => `<kbd>${esc(c.toUpperCase())}</kbd>`;
  return `${esc(s.config.boardNames[0])} ${K(k.b1Home)} / ${K(k.b1Away)} · ${esc(s.config.boardNames[1])} ${K(k.b2Home)} / ${K(k.b2Away)}`;
}

function phaseCallToAction(s) {
  if (s.phase === 'league' && T.canStartKnockout(s)) {
    return `<div class="cta card"><div><strong>League complete!</strong> Check the final table, then seed the semi-finals.</div>
      <button class="primary big" data-action="knockout-preview">Start knockout…</button></div>`;
  }
  if (s.phase === 'complete') {
    const v = bracketView(s.fixtures);
    return `<div class="cta card champion"><div>🏆 <strong>${esc(teamText(s, v.championId))}</strong> are the champions. The TV shows the champion screen.</div>
      <button data-action="export">Download final backup</button></div>`;
  }
  return '';
}

function canStartOn(s, f, board) {
  if (T.liveOnBoard(s, board) || T.finalMustWait(s, f)) return false;
  const busy = new Set(T.liveFixtures(s).flatMap((x) => [x.homeId, x.awayId]));
  return !busy.has(f.homeId) && !busy.has(f.awayId);
}

function idleMessage(s) {
  if (s.phase === 'league') {
    const left = T.upcoming(s).length;
    if (!T.leagueProgress(s).total) return 'No fixtures yet — add matches on the Fixtures tab.';
    if (!left) return T.liveFixtures(s).length ? 'No more league matches — finish the other board.' : 'League complete.';
    return 'Waiting — every remaining match involves a team that is playing now.';
  }
  if (s.phase === 'knockout') {
    const f = T.fixtureById(s, 'F');
    if (f?.status === 'scheduled' && (!f.homeId || !f.awayId)) return 'Waiting for the semi-finals to finish.';
    return 'No knockout match waiting.';
  }
  if (s.phase === 'complete') return 'Tournament complete.';
  return '';
}

// ---------------------------------------------------------------- view: fixtures

function viewFixtures(s) {
  if (s.phase === 'setup') {
    return `<section class="card empty-state"><h2>No fixtures yet</h2><p>Add your teams, then either generate the fixtures or start the league with an empty list and build it yourself.</p>
      <button class="primary" data-action="tab" data-tab="teams">Go to Teams</button></section>`;
  }
  const editor = s.phase === 'league' ? fixtureEditor(s) : '';
  if (!s.fixtures.length) return editor;
  const filters = { upcoming: 'Upcoming', played: 'Played', all: 'All' };
  let list = s.fixtures.slice().sort(T.byOrder);
  if (fixtureFilter === 'upcoming') list = list.filter((f) => f.status !== 'done');
  if (fixtureFilter === 'played') list = list.filter((f) => f.status === 'done').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  if (fixtureTeam && !T.teamById(s, fixtureTeam)) fixtureTeam = '';
  if (fixtureTeam) list = list.filter((f) => f.homeId === fixtureTeam || f.awayId === fixtureTeam);
  const boardView = fixtureBoard === '1' || fixtureBoard === '2' ? Number(fixtureBoard) : null;
  if (boardView) list = list.filter((f) => (f.status === 'live' ? f.board : f.plannedBoard) === boardView);
  // Running order on each board (1 = next on that board).
  const boardPos = new Map();
  for (const b of [1, 2]) {
    T.upcoming(s).filter((f) => f.plannedBoard === b).forEach((f, i) => boardPos.set(f.id, i + 1));
  }
  const { played, total } = T.leagueProgress(s);
  const boardSeg = { all: 'Both boards', 1: s.config.boardNames[0], 2: s.config.boardNames[1] };
  return `${editor}<section class="card">
    <div class="card-head">
      <h2>Fixtures <span class="muted small-text">${played}/${total} league matches played</span></h2>
      <div class="fx-filters">
        <div class="seg board-seg" role="group" aria-label="Show one board's queue">${Object.entries(boardSeg).map(([k, v]) => `<button data-action="fixture-board-view" data-board-view="${k}" aria-pressed="${String(k) === String(fixtureBoard)}">${esc(v)}</button>`).join('')}</div>
        <select id="fx-team" data-change="fixture-team" aria-label="Show matches for one team">${teamOptions(s, fixtureTeam, 'All teams')}</select>
        <div class="seg">${Object.entries(filters).map(([k, v]) => `<button data-action="filter" data-filter="${k}" aria-pressed="${k === fixtureFilter}">${v}</button>`).join('')}</div>
      </div>
    </div>
    ${s.phase === 'league' && played === 0 && !T.liveFixtures(s).length ? `<p class="muted">Nothing played yet — you can still <button class="link" data-action="back-to-setup">go back to setup</button> to change teams or once/twice.</p>` : ''}
    ${boardView ? `<p class="muted small-text">${esc(s.config.boardNames[boardView - 1])} queue: the number is the order on this board (1 = next). ↑ ↓ and Play next move matches within this board only.</p>` : ''}
    <table class="fixtures">
      <thead><tr><th title="${boardView ? 'Order on this board' : 'Overall order'}">#</th><th>Stage</th><th>Board</th><th class="r">Home</th><th class="c">Score</th><th>Away</th><th>Status</th><th class="r">Actions</th></tr></thead>
      <tbody>${list.map((f) => fixtureRow(s, f, { boardView, boardPos })).join('') || `<tr><td colspan="8" class="muted">Nothing here.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function boardCell(s, f) {
  if (f.status === 'scheduled') {
    const opt = (v, label) => `<option value="${v}" ${String(f.plannedBoard ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    return `<select id="fb-${f.id}" class="board-select b${f.plannedBoard ?? 0}" data-change="fixture-board" data-id="${f.id}" aria-label="Board for this match">
      ${opt(1, s.config.boardNames[0])}${opt(2, s.config.boardNames[1])}${opt('', 'Either')}</select>`;
  }
  const b = f.status === 'live' ? f.board : f.plannedBoard;
  return b ? `<span class="board-chip b${b}">${esc(s.config.boardNames[b - 1])}</span>` : '<span class="muted">–</span>';
}

function fixtureRow(s, f, { boardView = null, boardPos = new Map() } = {}) {
  const avgs = f.homeAvg != null || f.awayAvg != null
    ? `<span class="avg-under num" title="3-dart averages">${fmtAvg(f.homeAvg) || '–'} · ${fmtAvg(f.awayAvg) || '–'}</span>` : '';
  const score = f.status === 'scheduled' ? '<span class="muted">–</span>' : `<span class="num">${f.homeLegs} – ${f.awayLegs}</span>${avgs}`;
  const w = winnerOf(f);
  let status;
  let actions = '';
  if (f.status === 'live') {
    status = `<span class="tag live-tag">LIVE · ${esc(s.config.boardNames[f.board - 1])}</span>`;
  } else if (f.status === 'done') {
    status = '<span class="tag done">Played</span>';
    actions = `<button class="small" data-action="edit-result" data-id="${f.id}">Edit</button>
      <button class="small ghost" data-action="unplay" data-id="${f.id}" title="Put back in the queue as unplayed">Un-play</button>`;
  } else {
    status = '<span class="muted">Scheduled</span>';
    if (f.homeId && f.awayId) {
      const scope = boardView ? 'data-scope="board"' : '';
      actions = `<button class="small ghost" data-action="move" data-id="${f.id}" data-delta="-1" ${scope} aria-label="Move earlier">↑</button>
        <button class="small ghost" data-action="move" data-id="${f.id}" data-delta="1" ${scope} aria-label="Move later">↓</button>
        <button class="small" data-action="play-next" data-id="${f.id}" ${scope}>Play next</button>`;
    }
    if (f.stage === 'league' && s.phase === 'league') {
      actions += `<button class="small" data-action="fixture-edit" data-id="${f.id}">Edit</button>
        <button class="small ghost" data-action="fixture-swap" data-id="${f.id}" title="Swap home and away" aria-label="Swap home and away">⇄</button>
        <button class="small danger-ghost" data-action="fixture-remove" data-id="${f.id}" aria-label="Delete this match">✕</button>`;
    }
  }
  return `<tr class="${f.status}">
    <td class="num muted">${boardView && f.status === 'scheduled' ? boardPos.get(f.id) ?? '' : f.order}</td>
    <td>${esc(stageName(f, { short: f.stage === 'league' }))}${f.stage === 'league' && f.round ? `<span class="muted small-text"> · ${s.config.fixtureRule === 'pairs' ? 'Slot ' : 'R'}${f.round}</span>` : ''}</td>
    <td>${boardCell(s, f)}</td>
    <td class="r ${w && w === f.homeId ? 'win' : ''}">${slotBlock(s, f, 'home')}</td>
    <td class="c">${score}</td>
    <td class="${w && w === f.awayId ? 'win' : ''}">${slotBlock(s, f, 'away')}</td>
    <td>${status}</td>
    <td class="r actions">${actions}</td>
  </tr>`;
}

function teamOptions(s, selected = '', placeholder = 'Choose team…') {
  return `<option value="">${esc(placeholder)}</option>${s.teams
    .map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(teamText(s, t.id))}</option>`).join('')}`;
}

/** Add / paste / check league fixtures (league phase). */
function fixtureEditor(s) {
  const b = T.leagueBalance(s);
  const name = (id) => esc(teamText(s, id));
  const pair = (p) => `${name(p.a)} v ${name(p.b)}${p.expected > 1 || p.count > 1 ? ` <span class="muted">(${p.count}/${p.expected})</span>` : ''}`;
  const list = (items, max = 12) => `${items.slice(0, max).map(pair).join(' · ')}${items.length > max ? ` · <span class="muted">+${items.length - max} more</span>` : ''}`;
  const perTeam = s.teams.map((t) => {
    const [b1, b2] = b.perTeamBoards.get(t.id) ?? [0, 0];
    return `<span class="chip">${teamBlock(s, t.id, { inline: true })} <b class="num">${b.perTeam.get(t.id) ?? 0}</b>
      <span class="board-split num" title="${esc(s.config.boardNames[0])} / ${esc(s.config.boardNames[1])}">B1 ${b1} · B2 ${b2}</span></span>`;
  }).join('');
  const boardLines = [];
  if (s.fixtures.some((f) => f.stage === 'league')) {
    const rule = T.pairsRuleReport(s);
    if (rule) {
      const names = (list) => list.map((t) => esc(T.teamName(s, t))).join(', ');
      if (rule.ok) boardLines.push(`<p class="ok-text">✓ 2 on, 1 off: every team plays its matches in pairs and never 3 in a row.</p>`);
      else {
        boardLines.push(`<p><strong>2 on, 1 off is broken:</strong> ${rule.threeInRow.length ? `${names(rule.threeInRow)} would play 3 or more in a row. ` : ''}${rule.extraSingles ? `${rule.extraSingles} extra single match${rule.extraSingles === 1 ? '' : 'es'}. ` : ''}Use <em>Regenerate unplayed matches</em> to re-plan.</p>`);
      }
    }
    if (b.expected === 2 && b.complete && !b.notOnBothBoards.length && !b.unassigned) boardLines.push(`<p class="ok-text">✓ Every pair plays once on ${esc(s.config.boardNames[0])} and once on ${esc(s.config.boardNames[1])}.</p>`);
    else if (b.boardsEven && !b.unassigned && !b.notOnBothBoards.length) boardLines.push(`<p class="ok-text">✓ Every team's matches are spread evenly over both boards.</p>`);
    if (b.notOnBothBoards.length) boardLines.push(`<p><strong>Not once on each board (${b.notOnBothBoards.length}):</strong> ${b.notOnBothBoards.slice(0, 10).map((p) => `${name(p.a)} v ${name(p.b)} <span class="muted">(B1 ${p.board1} · B2 ${p.board2})</span>`).join(' · ')}${b.notOnBothBoards.length > 10 ? ` · <span class="muted">+${b.notOnBothBoards.length - 10} more</span>` : ''}</p>`);
    if (b.unassigned) boardLines.push(`<p><strong>${b.unassigned} match${b.unassigned === 1 ? '' : 'es'} not planned for a board</strong> (either board can take ${b.unassigned === 1 ? 'it' : 'them'}).</p>`);
  }
  const once = s.config.doubleRoundRobin ? 'twice' : 'once';
  let status;
  if (!s.fixtures.some((f) => f.stage === 'league')) {
    status = `<p class="muted">No league matches yet. Add them below, paste a list, or fill in a full ${once}-each round robin.</p>`;
  } else if (b.complete) {
    status = `<p class="ok-text">✓ Every pair of teams meets exactly ${once}.</p>`;
  } else {
    status = `${b.missing.length ? `<p><strong>Not scheduled yet (${b.missing.length}):</strong> ${list(b.missing)}</p>` : ''}
      ${b.extra.length ? `<p><strong>Scheduled more than ${once} (${b.extra.length}):</strong> ${list(b.extra)}</p>` : ''}
      <p class="muted small-text">That's fine if it's deliberate — the table just counts whatever is played.</p>`;
  }
  return `<section class="split fixture-tools">
    <div class="card">
      <h2>Add a match</h2>
      <form class="add-fixture" data-form="add-fixture">
        <select id="af-home" name="home" aria-label="Home team">${teamOptions(s, '', 'Home team…')}</select>
        <span class="muted">v</span>
        <select id="af-away" name="away" aria-label="Away team">${teamOptions(s, '', 'Away team…')}</select>
        <select id="af-board" name="board" aria-label="Board">
          <option value="auto">Board: auto</option>
          <option value="1">${esc(s.config.boardNames[0])}</option>
          <option value="2">${esc(s.config.boardNames[1])}</option>
          <option value="">Either board</option>
        </select>
        <button class="primary">Add</button>
      </form>
      <p class="muted small-text">New matches go to the end of the queue. <em>Board: auto</em> puts a pair's second meeting on the other board and keeps every team's boards even.</p>
      <details class="bulk-fixtures">
        <summary>Paste a fixture list</summary>
        <form data-form="bulk-fixtures">
          <p class="muted small-text">One match per line, in play order: <code>Team A v Team B</code> (also “vs” or “-”). Add the board at the end if you like: <code>Team A v Team B (Board 2)</code>. Team names must match the Teams tab.</p>
          <textarea id="bulk-fixtures" name="bulk" rows="6" placeholder="Double Trouble v The Bullseyes&#10;Treble Makers vs Oche Dear"></textarea>
          <button class="primary">Add matches</button>
        </form>
      </details>
    </div>
    <div class="card">
      <h2>Fixture check</h2>
      ${status}
      ${boardLines.join('')}
      <p class="small-text muted">League matches per team (and on each board):</p>
      <div class="chips">${perTeam}</div>
      <div class="btn-row">
        <button class="small" data-action="fixtures-fill" title="Keep played matches; schedule exactly the meetings still owed">${s.fixtures.some((f) => f.stage === 'league') ? 'Regenerate unplayed matches' : `Generate full ${once}-each round robin`}</button>
        <button class="small" data-action="fixtures-balance" ${T.upcoming(s).some((f) => f.stage === 'league') ? '' : 'disabled'} title="Re-plan the boards of all unplayed matches: each pair once on each board, everyone's boards even. The order stays the same.">Balance boards automatically</button>
        <button class="small danger-ghost" data-action="fixtures-clear" ${T.upcoming(s).some((f) => f.stage === 'league') ? '' : 'disabled'}>Delete all unplayed matches</button>
      </div>
    </div>
  </section>`;
}

async function editFixtureDialog(id) {
  const s = S();
  const f = T.fixtureById(s, id);
  const queue = T.upcoming(s).filter((x) => x.stage === f.stage);
  const pos = queue.findIndex((x) => x.id === id) + 1;
  let next = null;
  const v = await ask({
    title: `Edit ${stageName(f)}`,
    body: `<div class="edit-fixture">
        <label>Home<select name="home">${teamOptions(s, f.homeId)}</select></label>
        <span>v</span>
        <label>Away<select name="away">${teamOptions(s, f.awayId)}</select></label>
      </div>
      <label>Board<select name="board">
        <option value="1" ${f.plannedBoard === 1 ? 'selected' : ''}>${esc(s.config.boardNames[0])}</option>
        <option value="2" ${f.plannedBoard === 2 ? 'selected' : ''}>${esc(s.config.boardNames[1])}</option>
        <option value="" ${f.plannedBoard == null ? 'selected' : ''}>Either board</option>
      </select></label>
      <label>Position in the queue (1 = next)<input name="pos" type="number" min="1" max="${queue.length}" value="${pos}"></label>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', kind: 'primary', autofocus: true }],
    onSubmit(form) {
      try {
        const board = form.board.value === '' ? null : Number(form.board.value);
        let st = T.updateFixture(S(), id, { homeId: form.home.value, awayId: form.away.value, board });
        if (Number(form.pos.value) !== pos) st = T.moveFixtureTo(st, id, Number(form.pos.value));
        next = st;
        return true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    },
  });
  if (v === 'save' && next) store.set(next, { label: `Edited ${stageName(f)}` });
}

async function editResultDialog(id) {
  const s = S();
  const f = T.fixtureById(s, id);
  const need = legsToWinFor(s.config, f.stage);
  const opts = (v) => Array.from({ length: need + 1 }, (_, i) => `<option ${i === v ? 'selected' : ''}>${i}</option>`).join('');
  let result = null;
  const v = await ask({
    title: `Edit result · ${stageName(f)}`,
    body: `<div class="edit-score">
      <label>${slotBlock(s, f, 'home')}<select name="home" class="num">${opts(f.homeLegs)}</select></label>
      <span>–</span>
      <label>${slotBlock(s, f, 'away')}<select name="away" class="num">${opts(f.awayLegs)}</select></label>
    </div><p class="muted">${legsFormat(bestOfFor(s.config, f.stage), { capital: true })}: the winner needs exactly ${need} leg${need === 1 ? '' : 's'}. The table updates instantly.</p>
    ${averageInputs(s, f)}`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save result', value: 'save', kind: 'primary', autofocus: true }],
    onSubmit(form) {
      try {
        const averages = readAverages(form);
        if (averages === false) return false;
        result = T.editResult(S(), id, Number(form.home.value), Number(form.away.value));
        result = T.setAverage(T.setAverage(result, id, 'home', averages.home ?? ''), id, 'away', averages.away ?? '');
        return true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    },
  });
  if (v === 'save' && result) {
    store.set(result, { label: `Edited ${stageName(f)}` });
    toast('Result updated.', 'success', { action: { label: 'Undo', fn: undo } });
  }
}

// ---------------------------------------------------------------- view: table & knockout

function standingsTable(s, { compact = false } = {}) {
  const rows = T.liveStandings(s);
  const showAvg = true; // always shown, so it's clear where averages appear ("–" until recorded)
  const q = s.config.qualifiers;
  return `<table class="standings ${compact ? 'compact' : ''}">
    <thead><tr><th>#</th><th>Team</th><th class="r">P</th><th class="r">W</th><th class="r">L</th>
      ${compact ? '' : '<th class="r">LF</th><th class="r">LA</th>'}<th class="r">LD</th>${showAvg ? '<th class="r" title="Mean 3-dart average over league matches where it was recorded">Avg</th>' : ''}<th class="r">Pts</th>${compact ? '' : '<th>Form</th>'}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${i < q ? 'q' : ''} ${i === q - 1 ? 'cut' : ''} ${r.live ? 'playing' : ''}">
      <td class="num">${r.position}${r.tiedWithPrev ? '<span class="tie" title="Level on every tiebreaker — separated by name only">=</span>' : ''}</td>
      <td class="team-cell">${teamBlock(s, r.teamId, { inline: compact })} ${r.live ? `<span class="live-badge ${r.liveResult === 'W' ? 'w' : r.liveResult === 'L' ? 'l' : ''}" title="Match in progress — these figures will change">LIVE${r.liveResult === 'W' ? ' · winning' : r.liveResult === 'L' ? ' · losing' : ' · level'}</span>` : ''}</td>
      <td class="r num">${r.played}</td><td class="r num">${r.won}</td><td class="r num">${r.lost}</td>
      ${compact ? '' : `<td class="r num">${r.legsFor}</td><td class="r num">${r.legsAgainst}</td>`}
      <td class="r num" ${r.live ? `title="Includes ${r.liveLegDiff > 0 ? '+' : ''}${r.liveLegDiff} from the match being played now"` : ''}>${r.legDiff > 0 ? '+' : ''}${r.legDiff}</td>${showAvg ? `<td class="r num avg-col">${fmtAvg(r.avg) || '–'}</td>` : ''}<td class="r num strong">${r.points}</td>
      ${compact ? '' : `<td class="form">${r.form.map((x) => `<span class="${x}">${x}</span>`).join('')}</td>`}
    </tr>`).join('')}</tbody></table>`;
}

function viewTable(s) {
  const tieNote = s.phase === 'league' && knockoutSeeding(T.standings(s)).tie
    ? `<p class="banner warn">4th and 5th place are level on every tiebreaker (only the name separates them). You'll choose who qualifies when you start the knockout.</p>` : '';
  let ko = '';
  if (s.phase === 'league') {
    const { played, total } = T.leagueProgress(s);
    ko = `<section class="card">
      <h2>Knockout</h2>
      <p>Top ${s.config.qualifiers} qualify. Semi-finals: 1st v 4th, 2nd v 3rd. ${s.config.thirdPlace ? '3rd place play-off on.' : ''}</p>
      <p class="muted">${played}/${total} league matches played.</p>
      <button class="primary big" data-action="knockout-preview">Start knockout…</button>
    </section>`;
  } else if (s.phase === 'knockout' || s.phase === 'complete') {
    const canGoBack = s.phase === 'knockout' && T.knockoutFixtures(s).every((f) => f.status === 'scheduled');
    ko = `<section class="card"><h2>Bracket</h2>${bracketSummary(s)}
      ${canGoBack ? '<p><button class="ghost" data-action="back-to-league">Cancel knockout and go back to the league</button></p>' : ''}</section>`;
  }
  return `${tieNote}<section class="split wide-left">
    <div class="card"><h2>League table</h2>${s.teams.length ? standingsTable(s) : '<p class="muted">No teams yet.</p>'}
      <p class="muted small-text">Order: points → leg difference → legs won → head-to-head → name. “=” marks teams separated by name only.
      Points: win ${s.config.points.win}, loss ${s.config.points.loss}.</p></div>
    <div>${ko}</div>
  </section>`;
}

function bracketSummary(s) {
  const v = bracketView(s.fixtures);
  if (!v.semis[0]) return '<p class="muted">The knockout has not started.</p>';
  const box = (f) => {
    if (!f) return '';
    const w = winnerOf(f);
    const line = (side) => {
      const id = side === 'home' ? f.homeId : f.awayId;
      const legs = side === 'home' ? f.homeLegs : f.awayLegs;
      return `<div class="b-team ${w && w === id ? 'win' : ''}">${slotBlock(s, f, side)}<span class="num">${f.status === 'scheduled' ? '' : legs}</span></div>`;
    };
    return `<div class="b-match ${f.status}"><div class="b-title">${esc(stageName(f))}${f.status === 'live' ? ' <span class="tag live-tag">LIVE</span>' : ''}</div>${line('home')}${line('away')}</div>`;
  };
  return `<div class="bracket-mini">
    <div class="col">${box(v.semis[0])}${box(v.semis[1])}</div>
    <div class="col">${box(v.final)}${box(v.third)}</div>
  </div>
  ${v.championId ? `<p class="champ-line">🏆 Champions: <strong>${esc(teamText(s, v.championId))}</strong></p>` : ''}`;
}

async function knockoutPreview() {
  const s = S();
  const rows = T.standings(s);
  const seeding = knockoutSeeding(rows);
  const { played, total } = T.leagueProgress(s);
  const remaining = total - played;
  if (T.liveFixtures(s).length) {
    toast('Finish (or cancel) the live matches first.', 'error');
    return;
  }
  const teamOpts = (sel) => rows.map((r) => `<option value="${r.teamId}" ${r.teamId === sel ? 'selected' : ''}>${r.position}. ${esc(teamText(s, r.teamId))} — ${r.points} pts</option>`).join('');
  const seedSelect = (i) => `<label>Seed ${i + 1}<select name="seed${i}">${teamOpts(seeding.seeds[i])}</select></label>`;
  const tied = seeding.tie
    ? `<p class="banner warn"><strong>Tie for the last place:</strong> ${seeding.tiedTeams.map((id) => esc(teamText(s, id))).join(', ')} are level on every tiebreaker. They are ordered by name below — change the seeds if you settle it another way (e.g. a nearest-the-bull throw-off).</p>`
    : '';
  const incomplete = remaining
    ? `<p class="banner error"><strong>${remaining} league match${remaining === 1 ? '' : 'es'} not played.</strong> Starting now drops them from the table for good.</p>`
    : '';
  let next = null;
  const v = await ask({
    title: 'Start knockout',
    wide: true,
    body: `${incomplete}${tied}
      <div class="seeds">${[0, 1, 2, 3].map(seedSelect).join('')}</div>
      <div class="seed-preview" id="seed-preview"></div>
      <p class="muted">Semi-finals ${legsFormat(s.config.bestOf.semi)}, final ${legsFormat(s.config.bestOf.final)}${s.config.thirdPlace ? `, 3rd place ${legsFormat(s.config.bestOf.third)}` : ''}. You can cancel the knockout until its first match starts.</p>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: remaining ? 'Start knockout anyway' : 'Start knockout', value: 'go', kind: remaining ? 'primary danger' : 'primary', autofocus: true }],
    onOpen(form) {
      const update = () => {
        const ids = [0, 1, 2, 3].map((i) => form[`seed${i}`].value);
        const n = (i) => teamBlock(s, ids[i]);
        $('#seed-preview', form).innerHTML = `<div><span class="muted">Semi-final 1</span> ${n(0)} <em>v</em> ${n(3)}</div><div><span class="muted">Semi-final 2</span> ${n(1)} <em>v</em> ${n(2)}</div>`
          + (new Set(ids).size < 4 ? '<p class="error-text">Each seed must be a different team.</p>' : '');
      };
      form.addEventListener('change', update);
      update();
    },
    onSubmit(form) {
      const ids = [0, 1, 2, 3].map((i) => form[`seed${i}`].value);
      try {
        next = T.startKnockout(S(), ids, { force: remaining > 0 });
        return true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    },
  });
  if (v === 'go' && next) {
    store.set(next, { label: 'Started knockout' });
    tab = 'live';
    toast('Knockout started. Semi-finals are ready on both boards.', 'success');
  }
}

// ---------------------------------------------------------------- view: teams

function viewTeams(s) {
  const setup = s.phase === 'setup';
  const n = s.teams.length;
  const matches = (n * (n - 1)) / 2 * (s.config.doubleRoundRobin ? 2 : 1);
  const rows = s.teams.map((t, i) => `<tr>
    <td class="num muted">${i + 1}</td>
    <td><input id="tn-${t.id}" data-change="team-name" data-id="${t.id}" value="${esc(t.name)}" maxlength="60" aria-label="Team name">
      ${t.name.length > LONG_NAME ? '<span class="hint-warn" title="Long names may be shortened with … on the TV">⚠ may be cut short on TV</span>' : ''}</td>
    <td><input id="tp0-${t.id}" data-change="team-player" data-idx="0" data-id="${t.id}" value="${esc(t.players[0])}" maxlength="40" placeholder="Player 1" aria-label="Player 1"></td>
    <td><input id="tp1-${t.id}" data-change="team-player" data-idx="1" data-id="${t.id}" value="${esc(t.players[1])}" maxlength="40" placeholder="Player 2" aria-label="Player 2"></td>
    <td class="r actions">${setup ? `
      <button class="small ghost" data-action="team-move" data-id="${t.id}" data-delta="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="small ghost" data-action="team-move" data-id="${t.id}" data-delta="1" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="small danger-ghost" data-action="team-remove" data-id="${t.id}" aria-label="Remove ${esc(t.name)}">Remove</button>` : ''}</td>
  </tr>`).join('');

  const startBlock = setup
    ? `<section class="card start-card">
        <h2>Ready?</h2>
        <p><strong>${n}</strong> teams · play each other <strong>${s.config.doubleRoundRobin ? 'twice' : 'once'}</strong> · <strong>${n >= 2 ? matches : 0}</strong> league matches · ${legsFormat(s.config.bestOf.league)}${s.config.fixtureRule === 'pairs' ? ' · <strong>2 on, 1 off</strong>' : ''}</p>
        <p class="muted small-text">Change once/twice, match length and points in <a href="#" data-action="tab" data-tab="settings">Settings</a>.</p>
        <button class="primary big" data-action="start-league" ${n < MIN_TEAMS ? 'disabled' : ''}>Generate fixtures &amp; start league</button>
        <p><button class="link" data-action="start-league-manual" ${n < MIN_TEAMS ? 'disabled' : ''}>…or start with an empty fixture list and set the matches yourself</button></p>
        <p class="muted small-text">Either way you can add, delete, edit and reorder matches on the Fixtures tab until they're played.</p>
        ${n < MIN_TEAMS ? `<p class="muted">Add at least ${MIN_TEAMS} teams.</p>` : ''}
      </section>`
    : `<section class="card"><h2>Team list locked</h2><p class="muted">The league has started, so teams can't be added or removed. Names and players can still be edited — the TV updates instantly.</p>
        ${s.phase === 'league' && s.fixtures.every((f) => f.status === 'scheduled') ? '<button class="ghost" data-action="back-to-setup">Back to setup (no matches played yet)</button>' : ''}</section>`;

  return `<section class="split wide-left">
    <div class="card">
      <div class="card-head"><h2>Teams <span class="muted small-text">${n} / ${MAX_TEAMS}</span></h2>
        ${setup && n < MAX_TEAMS ? '<button class="small" data-action="demo-teams">Load demo teams</button>' : ''}</div>
      ${n ? `<table class="teams"><thead><tr><th>#</th><th>Team name</th><th>Player 1</th><th>Player 2</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No teams yet. Add them below, or paste a list.</p>'}
      ${setup ? `<form class="add-team" data-form="add-team">
        <input id="new-name" name="name" placeholder="Team name" maxlength="60" required aria-label="New team name">
        <input id="new-p0" name="p0" placeholder="Player 1 (optional)" maxlength="40" aria-label="Player 1">
        <input id="new-p1" name="p1" placeholder="Player 2 (optional)" maxlength="40" aria-label="Player 2">
        <button class="primary" ${n >= MAX_TEAMS ? 'disabled' : ''}>Add team</button>
      </form>` : ''}
    </div>
    <div>
      ${startBlock}
      ${setup ? `<section class="card">
        <h2>Bulk paste</h2>
        <p class="muted small-text">One team per line. Players optional: <code>Team name: Player A &amp; Player B</code></p>
        <form data-form="bulk"><textarea id="bulk" name="bulk" rows="8" placeholder="Double Trouble: Sam &amp; Alex&#10;The Bullseyes&#10;Treble Makers: Mo &amp; Lee"></textarea>
        <button class="primary">Add all</button></form>
      </section>` : ''}
    </div>
  </section>`;
}

// ---------------------------------------------------------------- view: settings

function viewSettings(s) {
  const c = s.config;
  const setup = s.phase === 'setup';
  const stagePlayed = (stage) => s.fixtures.some((f) => f.stage === stage && f.status !== 'scheduled');
  const boSelect = (stage, label) => `<label>${label}
    <select id="bo-${stage}" data-change="bestof" data-stage="${stage}" ${stagePlayed(stage) ? 'disabled title="Locked: a match has started"' : ''}>
      ${[1, 3, 5, 7, 9, 11].map((n) => `<option value="${n}" ${n === c.bestOf[stage] ? 'selected' : ''}>${legsFormat(n, { capital: true })}</option>`).join('')}
    </select></label>`;
  const keyInput = (k, label) => `<label>${label}<input id="key-${k}" class="key" data-change="key" data-key="${k}" value="${esc(c.keys[k].toUpperCase())}" maxlength="1"></label>`;
  return `<section class="settings-grid">
    <div class="card">
      <h2>Tournament</h2>
      <label>Title<input id="cfg-title" data-change="cfg" data-field="title" value="${esc(c.title)}" maxlength="80"></label>
      <label>Subtitle (venue / date)<input id="cfg-subtitle" data-change="cfg" data-field="subtitle" value="${esc(c.subtitle)}" maxlength="120" placeholder="e.g. The Red Lion · Friday 4 Dec"></label>
      <label>Accent colour<input id="cfg-accent" type="color" data-change="cfg" data-field="accent" value="${esc(c.accent)}"></label>
      <label class="check"><input id="cfg-logo" type="checkbox" data-change="cfg-bool" data-field="showLogo" ${c.showLogo ? 'checked' : ''}> Show the JWI logo on the TV</label>
      <label>Game (shown on TV)<input id="cfg-game" data-change="cfg" data-field="gameType" value="${esc(c.gameType)}" maxlength="40"></label>
      <div class="row2">
        <label>Board 1 name<input id="cfg-b1" data-change="board-name" data-idx="0" value="${esc(c.boardNames[0])}" maxlength="30"></label>
        <label>Board 2 name<input id="cfg-b2" data-change="board-name" data-idx="1" value="${esc(c.boardNames[1])}" maxlength="30"></label>
      </div>
    </div>
    <div class="card">
      <h2>Rules</h2>
      <label>League: teams play each other
        <select id="cfg-rr" data-change="rr" ${setup ? '' : 'disabled title="Locked once the league starts"'}>
          <option value="twice" ${c.doubleRoundRobin ? 'selected' : ''}>Twice</option>
          <option value="once" ${c.doubleRoundRobin ? '' : 'selected'}>Once</option>
        </select></label>
      <label>Fixture rule
        <select id="cfg-rule" data-change="fixture-rule">
          <option value="spread" ${c.fixtureRule !== 'pairs' ? 'selected' : ''}>Spread out — a rest between matches</option>
          <option value="pairs" ${c.fixtureRule === 'pairs' ? 'selected' : ''}>2 on, 1 off — play 2 in a row, then rest</option>
        </select></label>
      ${c.fixtureRule === 'pairs' ? `<p class="muted small-text rule-help">Every team plays its matches in pairs, never 3 in a row, then rests.
        With two boards 4 teams play at a time, so the rest depends on the number of teams: <strong>6 teams → exactly 1 off</strong>; with more teams some rests are longer.
        Each team may have one single match (the start needs it). Boards follow the plan and wait for the right teams.</p>` : ''}
      <fieldset class="lengths"><legend>Match length</legend>
        ${boSelect('league', 'League matches')}${boSelect('semi', 'Semi-finals')}${boSelect('final', 'Final')}${boSelect('third', '3rd place play-off')}
      </fieldset>
      <div class="row2">
        <label>Points for a win<input id="pts-win" type="number" min="0" max="99" data-change="points" data-which="win" value="${c.points.win}"></label>
        <label>Points for a loss<input id="pts-loss" type="number" min="0" max="99" data-change="points" data-which="loss" value="${c.points.loss}"></label>
      </div>
      <label class="check"><input id="cfg-third" type="checkbox" data-change="cfg-bool" data-field="thirdPlace" ${c.thirdPlace ? 'checked' : ''}> 3rd place play-off</label>
      <label class="check"><input id="cfg-final-alone" type="checkbox" data-change="cfg-bool" data-field="finalAlone" ${c.finalAlone ? 'checked' : ''}> Play the final on its own (after every other match)</label>
      <p class="muted small-text">Top ${c.qualifiers} qualify for the semi-finals (1st v 4th, 2nd v 3rd).</p>
    </div>
    <div class="card">
      <h2>Keyboard shortcuts</h2>
      <p class="muted small-text">Key = leg to that team, Shift+key = remove a leg. Works on the Live scoring tab when no text box is focused.</p>
      <div class="row2">${keyInput('b1Home', `${esc(c.boardNames[0])} · home`)}${keyInput('b1Away', `${esc(c.boardNames[0])} · away`)}</div>
      <div class="row2">${keyInput('b2Home', `${esc(c.boardNames[1])} · home`)}${keyInput('b2Away', `${esc(c.boardNames[1])} · away`)}</div>
    </div>
    <div class="card">
      <h2>Rehearsal</h2>
      <p class="muted small-text">Try the whole night before the real thing. Export a backup first if you have real data — then use Reset afterwards.</p>
      <div class="btn-col">
        <button data-action="sim-match" ${s.phase === 'complete' ? 'disabled' : ''}>Simulate next match</button>
        <button data-action="sim-league" ${s.phase !== 'league' && s.phase !== 'setup' ? 'disabled' : ''}>Simulate the rest of the league</button>
        <button data-action="sim-all" ${s.phase === 'complete' ? 'disabled' : ''}>Simulate to the end</button>
        <button data-action="autoplay" aria-pressed="${!!autoplayTimer}" ${s.phase === 'complete' ? 'disabled' : ''}>${autoplayTimer ? '■ Stop auto-play' : '▶ Auto-play (watch the TV)'}</button>
      </div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------- view: backup

function viewBackup(s) {
  const hist = store.history().slice().reverse();
  const lastExport = prefs.get('lastExport', null);
  return `<section class="split">
    <div class="card">
      <h2>Backup</h2>
      <p>Everything is stored in this browser on this laptop. ${store.persistent ? '<span class="ok-text">Storage is working.</span>' : '<span class="error-text">Storage is NOT available — use a normal browser window.</span>'}</p>
      <p class="muted">Last saved: ${esc(timeAgo(store.lastSavedAt))} · Last backup file: ${esc(timeAgo(lastExport))}</p>
      <div class="btn-row">
        <button class="primary" data-action="export">⬇ Export JSON backup</button>
        <label class="button">⬆ Import JSON backup<input type="file" accept="application/json,.json" data-change="import" hidden></label>
      </div>
      <label class="check"><input id="cfg-autobackup" type="checkbox" data-change="cfg-bool" data-field="autoBackup" ${s.config.autoBackup ? 'checked' : ''}> Download a backup automatically after every finished match</label>
    </div>
    <div class="card">
      <h2>Recovery history</h2>
      <p class="muted small-text">The last ${hist.length} changes in this browser. Restoring is itself undoable.</p>
      <ol class="history">${hist.map((h, i) => {
        const idx = hist.length - 1 - i;
        return `<li><span class="num muted">${new Date(h.at).toLocaleTimeString()}</span> <span>${esc(h.label)}</span>
          ${i === 0 ? '<span class="tag">current</span>' : `<button class="small" data-action="restore" data-idx="${idx}">Restore</button>`}</li>`;
      }).join('') || '<li class="muted">No history yet.</li>'}</ol>
    </div>
    <div class="card danger-zone">
      <h2>Reset tournament</h2>
      <p class="muted">Starts again from setup. Download a backup first.</p>
      <label class="check"><input type="checkbox" id="reset-teams" checked> Keep teams</label>
      <label class="check"><input type="checkbox" id="reset-config" checked> Keep settings</label>
      <button class="danger" data-action="reset">Reset tournament…</button>
    </div>
  </section>`;
}

async function resetFlow() {
  const keepTeams = $('#reset-teams')?.checked ?? true;
  const keepConfig = $('#reset-config')?.checked ?? true;
  const first = await confirmAction(
    'Reset the tournament?',
    `All fixtures and results will be cleared${keepTeams ? '' : ', and all teams removed'}. A backup file will be downloaded first.`,
    'Continue',
    'danger',
  );
  if (!first) return;
  const v = await ask({
    title: 'Are you sure?',
    body: '<p>Type <strong>RESET</strong> to confirm.</p><input name="confirm" id="reset-confirm" autocomplete="off" aria-label="Type RESET">',
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Reset tournament', value: 'reset', kind: 'danger' }],
    onOpen: (form) => form.confirm.focus(),
    onSubmit(form) {
      if (form.confirm.value.trim().toUpperCase() !== 'RESET') {
        toast('Type RESET to confirm.', 'error');
        return false;
      }
      return true;
    },
  });
  if (v !== 'reset') return;
  downloadBackup('before-reset');
  stopAutoplay();
  store.set(T.resetTournament(S(), { keepTeams, keepConfig }), { label: 'Reset tournament' });
  tab = 'teams';
  toast('Tournament reset. A backup was downloaded.', 'success');
}

// ---------------------------------------------------------------- rehearsal

function startAutoplay() {
  stopAutoplay();
  autoplayTimer = setInterval(() => {
    const s = S();
    if (s.phase === 'complete') { stopAutoplay(); render(); return; }
    let next;
    try { next = simulateStep(s); } catch (e) { toast(e.message, 'error'); stopAutoplay(); render(); return; }
    if (next === s) { stopAutoplay(); render(); return; }
    store.set(next, { label: 'Auto-play step', record: false });
  }, 1400);
  render();
}
function stopAutoplay() {
  if (autoplayTimer) clearInterval(autoplayTimer);
  autoplayTimer = null;
}

// ---------------------------------------------------------------- events

const actions = {
  tab: (d) => { tab = d.tab; scrolledToCurrent = false; prefs.set('tab', tab); render(); $('#main').focus({ preventScroll: true }); },
  leg: (d) => changeLegs(d.id, d.side, Number(d.delta)),
  finish: (d) => finish(d.id),
  start: (d) => {
    // Anything already typed into the card comes along when it goes live.
    const draft = drafts.get(d.id) ?? {};
    const ok = act('Started match', (s) => {
      let st = T.startMatch(s, d.id, Number(d.board));
      for (const side of ['home', 'away']) {
        const v = draft[`${side}Avg`];
        if (v !== undefined && v !== '') st = T.setAverage(st, d.id, side, v);
      }
      const h = draft.homeLegs;
      const a = draft.awayLegs;
      if ((h ?? '') !== '' || (a ?? '') !== '') st = T.setLegs(st, d.id, h || 0, a || 0);
      return st;
    });
    if (ok) {
      drafts.delete(d.id);
      if (T.matchIsDecided(S(), d.id)) promptFinish(d.id);
    }
  },
  'md-save': (d) => saveTypedResult(d.id),
  'md-edit': (d) => { editing.add(d.id); render(); $(`#e-${d.id}-homeLegs`)?.focus(); },
  'md-edit-cancel': (d) => { editing.delete(d.id); render(); },
  'md-edit-save': (d) => {
    const val = (k) => $(`#e-${d.id}-${k}`)?.value ?? '';
    const f = T.fixtureById(S(), d.id);
    if (act(`Edited ${stageName(f)}`, (s) => {
      let st = T.editResult(s, d.id, Number(val('homeLegs')), Number(val('awayLegs')));
      st = T.setAverage(st, d.id, 'home', val('homeAvg'));
      return T.setAverage(st, d.id, 'away', val('awayAvg'));
    })) {
      editing.delete(d.id);
      render();
      toast('Result updated.', 'success', { action: { label: 'Undo', fn: undo } });
    }
  },
  'md-board': (d) => act('Moved to the other board', (s) => T.setFixtureBoard(s, d.id, Number(d.board))),
  'scroll-to': (d) => document.getElementById(`m-${d.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  cancel: async (d) => {
    if (await confirmAction('Cancel this match?', 'It goes back into the queue and the score is cleared.', 'Cancel match', 'danger')) {
      act('Cancelled match', (s) => T.cancelMatch(s, d.id));
    }
  },
  filter: (d) => { fixtureFilter = d.filter; prefs.set('fixtureFilter', fixtureFilter); render(); },
  move: (d) => act('Reordered fixtures', (s) => T.moveFixture(s, d.id, Number(d.delta), { sameBoard: d.scope === 'board' })),
  'play-next': (d) => act('Reordered fixtures', (s) => T.playNext(s, d.id, { sameBoard: d.scope === 'board' })),
  'fixture-board-view': (d) => { fixtureBoard = d.boardView; prefs.set('fixtureBoard', fixtureBoard); render(); },
  'fixtures-balance': async () => {
    if (await confirmAction('Balance boards automatically?', 'Every unplayed match gets a board so that each pair plays once on each board where possible and every team\'s matches are spread evenly. The order stays the same. You can Undo.', 'Balance boards')) {
      act('Balanced boards', T.autoAssignBoards);
    }
  },
  'edit-result': (d) => editResultDialog(d.id),
  'fixture-edit': (d) => editFixtureDialog(d.id),
  'fixture-swap': (d) => act('Swapped home/away', (s) => T.swapHomeAway(s, d.id)),
  'fixture-remove': (d) => {
    const f = T.fixtureById(S(), d.id);
    if (act(`Deleted ${stageName(f)}`, (s) => T.removeFixture(s, d.id))) {
      toast(`Deleted ${teamText(S(), f.homeId)} v ${teamText(S(), f.awayId)}.`, 'info', { action: { label: 'Undo', fn: undo } });
    }
  },
  'fixtures-clear': async () => {
    if (await confirmAction('Delete all unplayed matches?', 'Played and live matches are kept. You can then add matches yourself (or Undo).', 'Delete unplayed', 'danger')) {
      act('Deleted unplayed matches', T.clearUnplayedFixtures);
    }
  },
  'fixtures-fill': async () => {
    const s = S();
    const has = s.fixtures.some((f) => f.stage === 'league' && f.status === 'scheduled');
    if (!has || await confirmAction('Regenerate unplayed matches?', `Your unplayed matches (and their order) are replaced by a generated list of exactly the meetings still owed so every pair plays ${s.config.doubleRoundRobin ? 'twice' : 'once'}. Played matches are kept.`, 'Regenerate')) {
      act('Regenerated fixtures', T.regenerateUnplayed);
    }
  },
  unplay: async (d) => {
    const f = T.fixtureById(S(), d.id);
    if (await confirmAction('Un-play this match?', `${esc(stageName(f))} goes back into the queue with no result.`, 'Un-play', 'danger')) {
      act(`Un-played ${stageName(f)}`, (s) => T.unplayMatch(s, d.id));
    }
  },
  'knockout-preview': () => knockoutPreview(),
  'back-to-league': async () => {
    if (await confirmAction('Cancel the knockout?', 'The semi-final draw is removed and you return to the league table.', 'Back to league', 'danger')) {
      act('Back to league', T.backToLeague);
    }
  },
  'back-to-setup': async () => {
    if (await confirmAction('Back to setup?', 'The fixture list is deleted (nothing has been played). You can then change teams and regenerate.', 'Back to setup', 'danger')) {
      if (act('Back to setup', T.backToSetup)) { tab = 'teams'; render(); }
    }
  },
  'start-league': async () => {
    const s = S();
    const n = s.teams.length;
    const matches = (n * (n - 1)) / 2 * (s.config.doubleRoundRobin ? 2 : 1);
    if (await confirmAction('Generate fixtures and start the league?', `${n} teams, each pair plays ${s.config.doubleRoundRobin ? 'twice' : 'once'}: <strong>${matches} matches</strong>, ${legsFormat(s.config.bestOf.league)}. Teams can't be added or removed after this (names can still be edited).`, 'Start league')) {
      if (act('Started league', T.startLeague)) {
        tab = 'live';
        prefs.set('tab', tab);
        render();
        toast(`${matches} fixtures generated. Press “Start” on each board.`, 'success');
      }
    }
  },
  'start-league-manual': async () => {
    if (await confirmAction('Start the league with no fixtures?', 'The league starts with an empty fixture list. Add matches one at a time or paste a list on the Fixtures tab. Teams can\'t be added or removed after this (names can still be edited).', 'Start league')) {
      if (act('Started league (manual fixtures)', (s) => T.startLeague(s, { manual: true }))) {
        tab = 'fixtures';
        prefs.set('tab', tab);
        render();
      }
    }
  },
  'team-move': (d) => act('Reordered teams', (s) => T.moveTeam(s, d.id, Number(d.delta))),
  'team-remove': (d) => act('Removed team', (s) => T.removeTeam(s, d.id)),
  'demo-teams': () => act('Loaded demo teams', (s) => loadDemoTeams(s, Math.max(8, s.teams.length))),
  'sim-match': () => act('Simulated a match', (s) => simulateMatch(s)),
  'sim-league': () => act('Simulated the league', (s) => simulateUntil(s, (x) => x.phase === 'league' && T.canStartKnockout(x))),
  'sim-all': async () => {
    if (await confirmAction('Simulate everything?', 'Plays every remaining match with random scores. Use Undo or Reset to go back.', 'Simulate')) {
      act('Simulated to the end', (s) => simulateUntil(s, (x) => x.phase === 'complete'));
    }
  },
  autoplay: () => (autoplayTimer ? (stopAutoplay(), render()) : startAutoplay()),
  export: () => { downloadBackup(); render(); },
  restore: async (d) => {
    const h = store.history()[Number(d.idx)];
    if (await confirmAction('Restore this snapshot?', `Go back to “${esc(h.label)}” at ${new Date(h.at).toLocaleTimeString()}. You can undo this.`, 'Restore')) {
      store.restore(Number(d.idx));
      toast('Snapshot restored.', 'success', { action: { label: 'Undo', fn: undo } });
    }
  },
  reset: () => resetFlow(),
  'reload-page': () => location.reload(),
  'dismiss-other': () => { otherAdmin = false; renderBanners(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') e.preventDefault();
  actions[el.dataset.action]?.(el.dataset, el);
});

$('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) actions.tab(b.dataset);
});
// Arrow keys move between tabs (WAI-ARIA tabs pattern).
$('.tabs').addEventListener('keydown', (e) => {
  const tabs = $$('.tabs [data-tab]');
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const t = tabs[(to + tabs.length) % tabs.length];
  tab = t.dataset.tab;
  prefs.set('tab', tab);
  render();
  t.focus();
});

const changes = {
  'team-name': (el) => act('Renamed team', (s) => T.updateTeam(s, el.dataset.id, { name: el.value })) || render(),
  'team-player': (el) => {
    const t = T.teamById(S(), el.dataset.id);
    const players = [...t.players];
    players[Number(el.dataset.idx)] = el.value.trim();
    act('Edited players', (s) => T.updateTeam(s, el.dataset.id, { players }));
  },
  cfg: (el) => act('Changed settings', (s) => T.updateConfig(s, { [el.dataset.field]: el.value })) || render(),
  'cfg-bool': (el) => act('Changed settings', (s) => T.updateConfig(s, { [el.dataset.field]: el.checked })) || render(),
  'board-name': (el) => {
    const names = [...S().config.boardNames];
    names[Number(el.dataset.idx)] = el.value;
    act('Renamed board', (s) => T.updateConfig(s, { boardNames: names }));
  },
  'fixture-rule': (el) => {
    const was = S().config.fixtureRule;
    if (!act('Changed fixture rule', (s) => T.updateConfig(s, { fixtureRule: el.value }))) return render();
    if (S().phase === 'league' && was !== el.value) {
      toast('Fixture rule changed. Go to Fixtures → “Regenerate unplayed matches” to re-plan the remaining matches with it.', 'info', { timeout: 9000 });
    }
  },
  rr: (el) => act('Changed settings', (s) => T.updateConfig(s, { doubleRoundRobin: el.value === 'twice' })) || render(),
  bestof: (el) => act('Changed match length', (s) => T.updateConfig(s, { bestOf: { [el.dataset.stage]: Number(el.value) } })) || render(),
  points: (el) => act('Changed points', (s) => T.updateConfig(s, { points: { [el.dataset.which]: Number(el.value) } })),
  key: (el) => {
    const v = el.value.trim().toLowerCase();
    if (!/^[a-z0-9]$/.test(v)) { toast('Use a single letter or number.', 'error'); render(); return; }
    const keys = S().config.keys;
    if (Object.entries(keys).some(([k, x]) => k !== el.dataset.key && x === v)) { toast('That key is already used.', 'error'); render(); return; }
    act('Changed shortcut', (s) => T.updateConfig(s, { keys: { [el.dataset.key]: v } }));
  },
  'fixture-board': (el) => act('Changed board', (s) => T.setFixtureBoard(s, el.dataset.id, el.value === '' ? null : Number(el.value))) || render(),
  'fixture-team': (el) => { fixtureTeam = el.value; prefs.set('fixtureTeam', fixtureTeam); render(); },
  avg: (el) => {
    const side = el.dataset.side;
    if (act('Recorded 3-dart average', (s) => T.setAverage(s, el.dataset.id, side, el.value))) return;
    // Invalid: put the last valid value back and keep the cursor there to retype.
    el.value = fmtAvg(T.fixtureById(S(), el.dataset.id)?.[`${side}Avg`]);
    el.select();
  },
  'start-pick': (el) => {
    if (el.value) act('Started match', (s) => T.startMatch(s, el.value, Number(el.dataset.board)));
  },
  import: (el) => { if (el.files[0]) importBackup(el.files[0]); el.value = ''; },
};

$('#main').addEventListener('input', (e) => {
  const el = e.target.closest('[data-draft]');
  if (!el) return;
  const d = drafts.get(el.dataset.id) ?? {};
  d[el.dataset.draft] = el.value;
  drafts.set(el.dataset.id, d);
});
$('#main').addEventListener('keydown', (e) => {
  // Enter in a typed result saves it.
  const el = e.target.closest('[data-draft]');
  if (el && e.key === 'Enter') {
    e.preventDefault();
    saveTypedResult(el.dataset.id);
  }
});

$('#main').addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el);
});

$('#main').addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === 'add-team') {
    const ok = act('Added team', (s) => T.addTeam(s, form.name.value, [form.p0.value, form.p1.value]));
    if (ok && form.name.value.trim().length > LONG_NAME) toast('Long name — it may be shortened with … on parts of the TV.', 'info');
    if (ok) {
      form.reset();
      requestAnimationFrame(() => $('#new-name')?.focus());
    }
  } else if (form.dataset.form === 'add-fixture') {
    const board = form.board.value === 'auto' ? undefined : form.board.value === '' ? null : Number(form.board.value);
    if (act('Added match', (s) => T.addFixture(s, form.home.value, form.away.value, { board }))) {
      toast('Match added to the end of the queue.', 'success');
      requestAnimationFrame(() => $('#af-home')?.focus());
    }
  } else if (form.dataset.form === 'bulk-fixtures') {
    try {
      const { state, added, skipped, skippedLines } = T.addFixturesBulk(S(), form.bulk.value);
      if (added) store.set(state, { label: `Added ${added} matches` });
      // Keep the lines that failed so they can be corrected.
      const area = $('#bulk-fixtures');
      if (area) {
        area.value = skippedLines.join('\n');
        if (skippedLines.length) area.closest('details').open = true;
      }
      toast(`Added ${added} match${added === 1 ? '' : 'es'}.${skipped.length ? ` Skipped: ${skipped.join('; ')}` : ''}`, skipped.length ? 'error' : 'success', { timeout: 10000 });
    } catch (err) {
      toast(err.message, 'error');
    }
  } else if (form.dataset.form === 'bulk') {
    try {
      const { state, skipped } = T.addTeamsBulk(S(), form.bulk.value);
      const added = state.teams.length - S().teams.length;
      if (added) store.set(state, { label: `Added ${added} teams` });
      toast(`Added ${added} team${added === 1 ? '' : 's'}.${skipped.length ? ` Skipped: ${skipped.join('; ')}` : ''}`, skipped.length ? 'error' : 'success', { timeout: 8000 });
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

// Keyboard scoring.
document.addEventListener('keydown', (e) => {
  if (dialog.open) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    undo();
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const s = S();
  const key = e.key.toLowerCase();
  const map = {
    [s.config.keys.b1Home]: [1, 'home'],
    [s.config.keys.b1Away]: [1, 'away'],
    [s.config.keys.b2Home]: [2, 'home'],
    [s.config.keys.b2Away]: [2, 'away'],
  };
  const hit = map[key];
  if (!hit) return;
  const f = T.liveOnBoard(s, hit[0]);
  if (!f) return;
  e.preventDefault();
  changeLegs(f.id, hit[1], e.shiftKey ? -1 : 1, { announce: tab !== 'live' });
});

$('#undo').addEventListener('click', undo);
$('#export').addEventListener('click', () => { downloadBackup(); render(); });
$('#autoplay-stop').addEventListener('click', () => { stopAutoplay(); render(); });
$('#open-tv').addEventListener('click', () => {
  const w = window.open('index.html', 'dartsTV', 'popup=yes,width=1280,height=720');
  if (!w) toast('The browser blocked the pop-up. Allow pop-ups for this site, or open index.html in a new window.', 'error', { timeout: 9000 });
});

// TV preview pane (scaled iframe of the real TV page).
const preview = $('#preview');
function togglePreview(show = preview.hidden) {
  preview.hidden = !show;
  $('#toggle-preview').setAttribute('aria-pressed', String(show));
  if (show && !$('iframe', preview)) {
    const f = document.createElement('iframe');
    f.src = 'index.html?preview=1';
    f.title = 'TV preview';
    f.tabIndex = -1;
    $('.preview-frame', preview).append(f);
  }
  prefs.set('preview', show);
}
$('#toggle-preview').addEventListener('click', () => togglePreview());
$('#preview-close').addEventListener('click', () => togglePreview(false));
if (prefs.get('preview', false)) togglePreview(true);

// Warn before closing while storage is broken.
window.addEventListener('beforeunload', (e) => {
  if (!store.persistent || store.saveError) {
    e.preventDefault();
    e.returnValue = '';
  }
});

store.subscribe((_s, meta) => {
  if (meta?.source === 'other-admin') {
    otherAdmin = true;
    renderBanners();
    return;
  }
  render();
});

// ---------------------------------------------------------------- TV presence
// The TV window sends a heartbeat; show whether one is listening right now.
let tvSeenAt = 0;
let tvVersion = APP_VERSION;
let adminOutdated = false;
const tvConnected = () => Date.now() - tvSeenAt < 7000;
function renderTvStatus() {
  const el = $('#tv-status');
  const ok = tvConnected();
  // A TV from before version checks existed can't refresh itself: ask the organiser to.
  const stale = ok && tvVersion < APP_VERSION && tvVersion < 5;
  el.className = `tv-status ${ok && !stale ? 'ok' : 'off'}`;
  el.textContent = stale ? '📺 TV needs a refresh' : ok ? '📺 TV connected' : '📺 TV not connected';
  el.title = stale
    ? 'The TV window is running an older version of the app. Click inside it and press F5 (Ctrl+R / Cmd+R) once.'
    : ok
    ? 'A TV window is open in this browser and receiving updates.'
    : `No TV window is listening. Open it with “Open TV window”, from the same address (${location.origin}) and the same browser — not a private window.`;
}
store.onMessage((msg) => {
  if (msg.type === 'tv-beat' && !msg.preview) {
    const wasConnected = tvConnected();
    tvSeenAt = Date.now();
    tvVersion = Number(msg.version) || 0;
    if (!wasConnected) renderTvStatus();
  }
  // Another window runs a newer release than this admin page: ask for a reload.
  if ((Number(msg.version) || 0) > APP_VERSION && !adminOutdated) {
    adminOutdated = true;
    renderBanners();
  }
});
setInterval(() => {
  store.post({ type: 'admin-beat', at: Date.now(), version: APP_VERSION });
  renderTvStatus();
}, 2000);
store.post({ type: 'admin-beat', at: Date.now(), version: APP_VERSION });

setInterval(renderSaved, 1000);
navigator.storage?.persist?.().catch(() => {});
registerServiceWorker();
render();
