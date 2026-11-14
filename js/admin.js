// Organiser controls. Writes to the store; the TV window follows automatically.
import { createStore, createLocalStorageAdapter } from './store.js';
import * as T from './logic/tournament.js';
import { knockoutSeeding, bracketView, winnerOf } from './logic/bracket.js';
import { legsToWinFor, bestOfFor, MIN_TEAMS, MAX_TEAMS } from './logic/config.js';
import { loadDemoTeams, simulateStep, simulateMatch, simulateUntil } from './logic/simulate.js';
import {
  esc, stageName, slotName, playersText, formatLine, phaseLabel, timeAgo, applyTheme, registerServiceWorker,
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
  const v = await ask({
    title: `${s.config.boardNames[f.board - 1]}: ${winner} win!`,
    body: `<p class="dlg-score"><strong>${esc(slotName(s, f, 'home'))}</strong> <span class="num">${f.homeLegs} – ${f.awayLegs}</span> <strong>${esc(slotName(s, f, 'away'))}</strong></p>
           <p class="muted">Finish the match and record the result? <kbd>Enter</kbd> finishes, <kbd>Esc</kbd> keeps it open.</p>`,
    buttons: [
      { label: 'Undo last leg', value: 'undo' },
      { label: 'Not yet', value: 'cancel' },
      { label: 'Finish match', value: 'finish', kind: 'primary', autofocus: true },
    ],
  });
  finishOpen = false;
  if (v === 'finish') finish(id);
  else if (v === 'undo') {
    const side = T.fixtureById(S(), id).homeLegs > T.fixtureById(S(), id).awayLegs ? 'home' : 'away';
    act('Leg removed', (st) => T.adjustLegs(st, id, side, -1));
  }
}

function finish(id) {
  const s = S();
  const f = T.fixtureById(s, id);
  if (!act(`Finished ${stageName(f)}`, (st) => T.finishMatch(st, id))) return;
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

  const views = { live: viewLive, fixtures: viewFixtures, table: viewTable, teams: viewTeams, settings: viewSettings, backup: viewBackup };
  $('#main').innerHTML = (views[tab] ?? viewLive)(s);

  if (focusSel) {
    const el = $(focusSel, $('#main'));
    if (el && !el.disabled) {
      el.focus({ preventScroll: true });
      if (sel && 'setSelectionRange' in el) { try { el.setSelectionRange(...sel); } catch { /* ignore */ } }
    } else if (el || focusSel.includes('data-action')) {
      $('#main').focus({ preventScroll: true });
    }
  }
}

function focusSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const keys = ['action', 'id', 'side', 'delta', 'board', 'tab', 'filter', 'idx'];
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

// ---------------------------------------------------------------- view: live

function viewLive(s) {
  if (s.phase === 'setup') {
    return `<section class="empty-state card">
      <h2>Nothing to score yet</h2>
      <p>Add at least ${MIN_TEAMS} teams, then generate the fixtures.</p>
      <button class="primary big" data-action="tab" data-tab="teams">Go to Teams</button>
    </section>`;
  }
  const next = T.nextUp(s);
  const cta = phaseCallToAction(s);
  return `
    ${cta}
    <section class="boards">
      ${[1, 2].map((b) => boardPanel(s, b, next[b])).join('')}
    </section>
    <p class="kbd-help">Keyboard: ${keyHelp(s)} · <kbd>Shift</kbd>+key removes a leg · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</p>
    <section class="split">
      <div class="card">
        <h2>Up next</h2>
        ${queueList(s, next)}
      </div>
      <div class="card">
        <h2>${s.phase === 'league' ? 'League table' : 'Bracket'}</h2>
        ${s.phase === 'league' ? standingsTable(s, { compact: true }) : bracketSummary(s)}
      </div>
    </section>`;
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
    return `<div class="cta card champion"><div>🏆 <strong>${esc(T.teamName(s, v.championId))}</strong> are the champions. The TV shows the champion screen.</div>
      <button data-action="export">Download final backup</button></div>`;
  }
  return '';
}

function boardPanel(s, board, suggested) {
  const name = esc(s.config.boardNames[board - 1]);
  const f = T.liveOnBoard(s, board);
  const k = s.config.keys;
  const keys = board === 1 ? [k.b1Home, k.b1Away] : [k.b2Home, k.b2Away];
  if (f) {
    const need = legsToWinFor(s.config, f.stage);
    const decided = T.matchIsDecided(s, f.id);
    const side = (which, key) => {
      const legs = which === 'home' ? f.homeLegs : f.awayLegs;
      const id = which === 'home' ? f.homeId : f.awayId;
      const won = decided && legs === need;
      return `<div class="side ${won ? 'winner' : ''}">
        <div class="team-name">${esc(slotName(s, f, which))}</div>
        <div class="players">${esc(playersText(s, id)) || '&nbsp;'}</div>
        <div class="legs num" data-legs="${f.id}-${which}">${legs}</div>
        <div class="pips">${Array.from({ length: need }, (_, i) => `<span class="${i < legs ? 'on' : ''}"></span>`).join('')}</div>
        <div class="leg-btns">
          <button class="minus" data-action="leg" data-id="${f.id}" data-side="${which}" data-delta="-1" ${legs === 0 ? 'disabled' : ''} aria-label="Remove a leg from ${esc(slotName(s, f, which))}">−</button>
          <button class="plus" data-action="leg" data-id="${f.id}" data-side="${which}" data-delta="1" ${decided ? 'disabled' : ''} aria-label="Leg to ${esc(slotName(s, f, which))}">+ Leg <kbd>${esc(key.toUpperCase())}</kbd></button>
        </div>
      </div>`;
    };
    return `<article class="board live ${decided ? 'decided' : ''}">
      <header><h2>${name}</h2><span class="tag live-tag">LIVE</span><span class="muted">${esc(stageName(f))}</span>
        <button class="small ghost" data-action="cancel" data-id="${f.id}" title="Take this match off the board (score is cleared)">Cancel match</button></header>
      <div class="score-row">${side('home', keys[0])}<div class="vs">v</div>${side('away', keys[1])}</div>
      <footer><span class="muted">${esc(formatLine(s, f))}</span>
        <button class="primary" data-action="finish" data-id="${f.id}" ${decided ? '' : 'disabled'}>Finish match</button></footer>
    </article>`;
  }
  const options = T.upcoming(s).filter((x) => canStartOn(s, x, board));
  let inner;
  if (suggested) {
    inner = `<p class="muted">Next up</p>
      <div class="next-teams"><span>${esc(slotName(s, suggested, 'home'))}</span><em>v</em><span>${esc(slotName(s, suggested, 'away'))}</span></div>
      <p class="muted small-text">${esc(stageName(suggested))} · ${esc(formatLine(s, suggested))}</p>
      <button class="primary big" data-action="start" data-id="${suggested.id}" data-board="${board}">▶ Start on ${name}</button>`;
  } else {
    inner = `<p class="muted waiting">${esc(idleMessage(s))}</p>`;
  }
  const picker = options.length > (suggested ? 1 : 0)
    ? `<label class="picker">Or start another match:
        <select id="pick-${board}" data-change="start-pick" data-board="${board}">
          <option value="">Choose…</option>
          ${options.map((x) => `<option value="${x.id}">${esc(stageName(x, { short: true }))} — ${esc(slotName(s, x, 'home'))} v ${esc(slotName(s, x, 'away'))}</option>`).join('')}
        </select></label>`
    : '';
  return `<article class="board free"><header><h2>${name}</h2><span class="tag">Free</span></header>
    <div class="free-body">${inner}${picker}</div></article>`;
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

function queueList(s, next) {
  const q = T.upcoming(s);
  if (!q.length) {
    if (s.phase === 'knockout') return `<p class="muted">${esc(idleMessage(s))}</p>`;
    return `<p class="muted">No matches waiting.</p>`;
  }
  const marks = new Map([[next[1]?.id, 1], [next[2]?.id, 2]]);
  return `<ol class="queue">${q.slice(0, 8).map((f) => {
    const m = marks.get(f.id);
    return `<li>
      <span class="q-stage">${esc(stageName(f, { short: true }))}</span>
      <span class="q-teams">${esc(slotName(s, f, 'home'))} <em>v</em> ${esc(slotName(s, f, 'away'))}</span>
      ${m ? `<span class="tag" title="${T.liveOnBoard(s, m) ? 'Starts when this board is free' : 'Ready to start now'}">${T.liveOnBoard(s, m) ? 'after' : '→'} ${esc(s.config.boardNames[m - 1])}</span>` : ''}
      <span class="q-actions">
        ${[1, 2].map((b) => canStartOn(s, f, b) ? `<button class="small" data-action="start" data-id="${f.id}" data-board="${b}" title="Start on ${esc(s.config.boardNames[b - 1])}">▶ B${b}</button>` : '').join('')}
      </span>
    </li>`;
  }).join('')}</ol>${q.length > 8 ? `<p class="muted small-text">+ ${q.length - 8} more · <a href="#" data-action="tab" data-tab="fixtures">all fixtures</a></p>` : ''}`;
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
  const { played, total } = T.leagueProgress(s);
  return `${editor}<section class="card">
    <div class="card-head">
      <h2>Fixtures <span class="muted small-text">${played}/${total} league matches played</span></h2>
      <div class="fx-filters">
        <select id="fx-team" data-change="fixture-team" aria-label="Show matches for one team">${teamOptions(s, fixtureTeam, 'All teams')}</select>
        <div class="seg">${Object.entries(filters).map(([k, v]) => `<button data-action="filter" data-filter="${k}" aria-pressed="${k === fixtureFilter}">${v}</button>`).join('')}</div>
      </div>
    </div>
    ${s.phase === 'league' && played === 0 && !T.liveFixtures(s).length ? `<p class="muted">Nothing played yet — you can still <button class="link" data-action="back-to-setup">go back to setup</button> to change teams or once/twice.</p>` : ''}
    <table class="fixtures">
      <thead><tr><th>#</th><th>Stage</th><th class="r">Home</th><th class="c">Score</th><th>Away</th><th>Status</th><th class="r">Actions</th></tr></thead>
      <tbody>${list.map((f) => fixtureRow(s, f)).join('') || `<tr><td colspan="7" class="muted">Nothing here.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function fixtureRow(s, f) {
  const score = f.status === 'scheduled' ? '<span class="muted">–</span>' : `<span class="num">${f.homeLegs} – ${f.awayLegs}</span>`;
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
      actions = `<button class="small ghost" data-action="move" data-id="${f.id}" data-delta="-1" aria-label="Move earlier">↑</button>
        <button class="small ghost" data-action="move" data-id="${f.id}" data-delta="1" aria-label="Move later">↓</button>
        <button class="small" data-action="play-next" data-id="${f.id}">Play next</button>`;
    }
    if (f.stage === 'league' && s.phase === 'league') {
      actions += `<button class="small" data-action="fixture-edit" data-id="${f.id}">Edit</button>
        <button class="small ghost" data-action="fixture-swap" data-id="${f.id}" title="Swap home and away" aria-label="Swap home and away">⇄</button>
        <button class="small danger-ghost" data-action="fixture-remove" data-id="${f.id}" aria-label="Delete this match">✕</button>`;
    }
  }
  return `<tr class="${f.status}">
    <td class="num muted">${f.order}</td>
    <td>${esc(stageName(f, { short: f.stage === 'league' }))}${f.stage === 'league' && f.round ? `<span class="muted small-text"> · R${f.round}</span>` : ''}</td>
    <td class="r ${w && w === f.homeId ? 'win' : ''}">${esc(slotName(s, f, 'home'))}</td>
    <td class="c">${score}</td>
    <td class="${w && w === f.awayId ? 'win' : ''}">${esc(slotName(s, f, 'away'))}</td>
    <td>${status}</td>
    <td class="r actions">${actions}</td>
  </tr>`;
}

function teamOptions(s, selected = '', placeholder = 'Choose team…') {
  return `<option value="">${esc(placeholder)}</option>${s.teams
    .map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
}

/** Add / paste / check league fixtures (league phase). */
function fixtureEditor(s) {
  const b = T.leagueBalance(s);
  const name = (id) => esc(T.teamName(s, id));
  const pair = (p) => `${name(p.a)} v ${name(p.b)}${p.expected > 1 || p.count > 1 ? ` <span class="muted">(${p.count}/${p.expected})</span>` : ''}`;
  const list = (items, max = 12) => `${items.slice(0, max).map(pair).join(' · ')}${items.length > max ? ` · <span class="muted">+${items.length - max} more</span>` : ''}`;
  const perTeam = s.teams.map((t) => `<span class="chip">${esc(t.name)} <b class="num">${b.perTeam.get(t.id) ?? 0}</b></span>`).join('');
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
        <button class="primary">Add</button>
      </form>
      <p class="muted small-text">New matches go to the end of the queue — use “Play next” or Edit to move them.</p>
      <details class="bulk-fixtures">
        <summary>Paste a fixture list</summary>
        <form data-form="bulk-fixtures">
          <p class="muted small-text">One match per line, in play order: <code>Team A v Team B</code> (also “vs” or “-”). Team names must match the Teams tab.</p>
          <textarea id="bulk-fixtures" name="bulk" rows="6" placeholder="Double Trouble v The Bullseyes&#10;Treble Makers vs Oche Dear"></textarea>
          <button class="primary">Add matches</button>
        </form>
      </details>
    </div>
    <div class="card">
      <h2>Fixture check</h2>
      ${status}
      <p class="small-text muted">League matches per team:</p>
      <div class="chips">${perTeam}</div>
      <div class="btn-row">
        <button class="small" data-action="fixtures-fill" title="Keep played matches; schedule exactly the meetings still owed">${s.fixtures.some((f) => f.stage === 'league') ? 'Regenerate unplayed matches' : `Generate full ${once}-each round robin`}</button>
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
      <label>Position in the queue (1 = next)<input name="pos" type="number" min="1" max="${queue.length}" value="${pos}"></label>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'save', kind: 'primary', autofocus: true }],
    onSubmit(form) {
      try {
        let st = T.updateFixture(S(), id, { homeId: form.home.value, awayId: form.away.value });
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
      <label>${esc(slotName(s, f, 'home'))}<select name="home" class="num">${opts(f.homeLegs)}</select></label>
      <span>–</span>
      <label>${esc(slotName(s, f, 'away'))}<select name="away" class="num">${opts(f.awayLegs)}</select></label>
    </div><p class="muted">Best of ${bestOfFor(s.config, f.stage)}: the winner needs exactly ${need} legs. The table updates instantly.</p>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save result', value: 'save', kind: 'primary', autofocus: true }],
    onSubmit(form) {
      try {
        result = T.editResult(S(), id, Number(form.home.value), Number(form.away.value));
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
  const rows = T.standings(s);
  const live = new Set(T.liveFixtures(s).filter((f) => f.stage === 'league').flatMap((f) => [f.homeId, f.awayId]));
  const q = s.config.qualifiers;
  return `<table class="standings ${compact ? 'compact' : ''}">
    <thead><tr><th>#</th><th>Team</th><th class="r">P</th><th class="r">W</th><th class="r">L</th>
      ${compact ? '' : '<th class="r">LF</th><th class="r">LA</th>'}<th class="r">LD</th><th class="r">Pts</th>${compact ? '' : '<th>Form</th>'}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${i < q ? 'q' : ''} ${i === q - 1 ? 'cut' : ''}">
      <td class="num">${r.position}${r.tiedWithPrev ? '<span class="tie" title="Level on every tiebreaker — separated by name only">=</span>' : ''}</td>
      <td>${esc(r.name)}${live.has(r.teamId) ? ' <span class="dot-live" title="Playing now"></span>' : ''}</td>
      <td class="r num">${r.played}</td><td class="r num">${r.won}</td><td class="r num">${r.lost}</td>
      ${compact ? '' : `<td class="r num">${r.legsFor}</td><td class="r num">${r.legsAgainst}</td>`}
      <td class="r num">${r.legDiff > 0 ? '+' : ''}${r.legDiff}</td><td class="r num strong">${r.points}</td>
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
      return `<div class="b-team ${w && w === id ? 'win' : ''}"><span>${esc(slotName(s, f, side))}</span><span class="num">${f.status === 'scheduled' ? '' : legs}</span></div>`;
    };
    return `<div class="b-match ${f.status}"><div class="b-title">${esc(stageName(f))}${f.status === 'live' ? ' <span class="tag live-tag">LIVE</span>' : ''}</div>${line('home')}${line('away')}</div>`;
  };
  return `<div class="bracket-mini">
    <div class="col">${box(v.semis[0])}${box(v.semis[1])}</div>
    <div class="col">${box(v.final)}${box(v.third)}</div>
  </div>
  ${v.championId ? `<p class="champ-line">🏆 Champions: <strong>${esc(T.teamName(s, v.championId))}</strong></p>` : ''}`;
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
  const teamOpts = (sel) => rows.map((r) => `<option value="${r.teamId}" ${r.teamId === sel ? 'selected' : ''}>${r.position}. ${esc(r.name)} (${r.points} pts)</option>`).join('');
  const seedSelect = (i) => `<label>Seed ${i + 1}<select name="seed${i}">${teamOpts(seeding.seeds[i])}</select></label>`;
  const tied = seeding.tie
    ? `<p class="banner warn"><strong>Tie for the last place:</strong> ${seeding.tiedTeams.map((id) => esc(T.teamName(s, id))).join(', ')} are level on every tiebreaker. They are ordered by name below — change the seeds if you settle it another way (e.g. a nearest-the-bull throw-off).</p>`
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
      <p class="muted">Semi-finals best of ${s.config.bestOf.semi}, final best of ${s.config.bestOf.final}${s.config.thirdPlace ? `, 3rd place best of ${s.config.bestOf.third}` : ''}. You can cancel the knockout until its first match starts.</p>`,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: remaining ? 'Start knockout anyway' : 'Start knockout', value: 'go', kind: remaining ? 'primary danger' : 'primary', autofocus: true }],
    onOpen(form) {
      const update = () => {
        const ids = [0, 1, 2, 3].map((i) => form[`seed${i}`].value);
        const n = (i) => esc(T.teamName(s, ids[i]));
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
        <p><strong>${n}</strong> teams · play each other <strong>${s.config.doubleRoundRobin ? 'twice' : 'once'}</strong> · <strong>${n >= 2 ? matches : 0}</strong> league matches · best of ${s.config.bestOf.league}</p>
        <p class="muted small-text">Change once/twice, best-of and points in <a href="#" data-action="tab" data-tab="settings">Settings</a>.</p>
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
      ${[1, 3, 5, 7, 9, 11].map((n) => `<option value="${n}" ${n === c.bestOf[stage] ? 'selected' : ''}>Best of ${n}</option>`).join('')}
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
      <div class="row2">${boSelect('league', 'League matches')}${boSelect('semi', 'Semi-finals')}</div>
      <div class="row2">${boSelect('final', 'Final')}${boSelect('third', '3rd place play-off')}</div>
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
  tab: (d) => { tab = d.tab; prefs.set('tab', tab); render(); $('#main').focus({ preventScroll: true }); },
  leg: (d) => changeLegs(d.id, d.side, Number(d.delta)),
  finish: (d) => finish(d.id),
  start: (d) => act('Started match', (s) => T.startMatch(s, d.id, Number(d.board))),
  cancel: async (d) => {
    if (await confirmAction('Cancel this match?', 'It goes back into the queue and the score is cleared.', 'Cancel match', 'danger')) {
      act('Cancelled match', (s) => T.cancelMatch(s, d.id));
    }
  },
  filter: (d) => { fixtureFilter = d.filter; prefs.set('fixtureFilter', fixtureFilter); render(); },
  move: (d) => act('Reordered fixtures', (s) => T.moveFixture(s, d.id, Number(d.delta))),
  'play-next': (d) => act('Reordered fixtures', (s) => T.playNext(s, d.id)),
  'edit-result': (d) => editResultDialog(d.id),
  'fixture-edit': (d) => editFixtureDialog(d.id),
  'fixture-swap': (d) => act('Swapped home/away', (s) => T.swapHomeAway(s, d.id)),
  'fixture-remove': (d) => {
    const f = T.fixtureById(S(), d.id);
    if (act(`Deleted ${stageName(f)}`, (s) => T.removeFixture(s, d.id))) {
      toast(`Deleted ${T.teamName(S(), f.homeId)} v ${T.teamName(S(), f.awayId)}.`, 'info', { action: { label: 'Undo', fn: undo } });
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
    if (await confirmAction('Generate fixtures and start the league?', `${n} teams, each pair plays ${s.config.doubleRoundRobin ? 'twice' : 'once'}: <strong>${matches} matches</strong>, best of ${s.config.bestOf.league}. Teams can't be added or removed after this (names can still be edited).`, 'Start league')) {
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
  rr: (el) => act('Changed settings', (s) => T.updateConfig(s, { doubleRoundRobin: el.value === 'twice' })) || render(),
  bestof: (el) => act('Changed best-of', (s) => T.updateConfig(s, { bestOf: { [el.dataset.stage]: Number(el.value) } })) || render(),
  points: (el) => act('Changed points', (s) => T.updateConfig(s, { points: { [el.dataset.which]: Number(el.value) } })),
  key: (el) => {
    const v = el.value.trim().toLowerCase();
    if (!/^[a-z0-9]$/.test(v)) { toast('Use a single letter or number.', 'error'); render(); return; }
    const keys = S().config.keys;
    if (Object.entries(keys).some(([k, x]) => k !== el.dataset.key && x === v)) { toast('That key is already used.', 'error'); render(); return; }
    act('Changed shortcut', (s) => T.updateConfig(s, { keys: { [el.dataset.key]: v } }));
  },
  'fixture-team': (el) => { fixtureTeam = el.value; prefs.set('fixtureTeam', fixtureTeam); render(); },
  'start-pick': (el) => {
    if (el.value) act('Started match', (s) => T.startMatch(s, el.value, Number(el.dataset.board)));
  },
  import: (el) => { if (el.files[0]) importBackup(el.files[0]); el.value = ''; },
};

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
    if (act('Added match', (s) => T.addFixture(s, form.home.value, form.away.value))) {
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
const tvConnected = () => Date.now() - tvSeenAt < 7000;
function renderTvStatus() {
  const el = $('#tv-status');
  const ok = tvConnected();
  el.className = `tv-status ${ok ? 'ok' : 'off'}`;
  el.textContent = ok ? '📺 TV connected' : '📺 TV not connected';
  el.title = ok
    ? 'A TV window is open in this browser and receiving updates.'
    : `No TV window is listening. Open it with “Open TV window”, from the same address (${location.origin}) and the same browser — not a private window.`;
}
store.onMessage((msg) => {
  if (msg.type === 'tv-beat' && !msg.preview) {
    const wasConnected = tvConnected();
    tvSeenAt = Date.now();
    if (!wasConnected) renderTvStatus();
  }
});
setInterval(() => {
  store.post({ type: 'admin-beat', at: Date.now() });
  renderTvStatus();
}, 2000);
store.post({ type: 'admin-beat', at: Date.now() });

setInterval(renderSaved, 1000);
navigator.storage?.persist?.().catch(() => {});
registerServiceWorker();
render();
