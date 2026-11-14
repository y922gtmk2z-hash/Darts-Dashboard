// TV dashboard. Read-only: follows the admin window through the store.
// Designed on a fixed 1920×1080 stage that is scaled to fit (letterboxed).
import { createStore, createLocalStorageAdapter } from './store.js';
import { APP_VERSION } from './version.js';
import * as T from './logic/tournament.js';
import * as I from './logic/insights.js';
import { bracketView, winnerOf, knockoutSeeding } from './logic/bracket.js';
import { legsToWinFor } from './logic/config.js';
import { esc, stageName, slotName, playersText, teamBlock, slotBlock, fmtAvg, formatLine, legsFormat, applyTheme, registerServiceWorker } from './view.js';

const W = 1920;
const H = 1080;
const params = new URLSearchParams(location.search);
const PREVIEW = params.has('preview');
const PINNED = ['table', 'fixtures', 'bracket', 'chart', 'grid', 'stats'].includes(params.get('view')) ? params.get('view') : null;
// ?rotate=N in the address overrides the admin setting (Settings → TV screens).
const URL_ROTATE = params.has('rotate') ? Math.max(0, Number(params.get('rotate')) || 0) : null;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const stage = $('#stage');

const store = createStore({ adapter: createLocalStorageAdapter(), normalize: T.normalizeState, readOnly: true });

// ---------------------------------------------------------------- scaling

let scale = 1;
function fit() {
  scale = Math.min(innerWidth / W, innerHeight / H);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
addEventListener('resize', fit);
fit();

// ---------------------------------------------------------------- view rotation

let rotateIndex = 0;
function viewsFor(s) {
  if (!s || s.phase === 'setup') return ['auto'];
  const hasChart = I.finishedLeague(s).length >= 2;
  const hasStats = s.fixtures.some((f) => f.status === 'done');
  const views = s.phase === 'league' ? ['auto', 'table', 'chart', 'grid', 'stats', 'fixtures']
    : s.phase === 'knockout' ? ['auto', 'table', 'stats', 'fixtures']
      : ['auto', 'bracket', 'table', 'chart', 'stats'];
  return views.filter((v) => (v !== 'chart' || hasChart) && (v !== 'stats' || hasStats));
}
function currentView(s) {
  if (PINNED) return PINNED;
  if (!rotateSeconds(s)) return 'auto';
  const v = viewsFor(s);
  return v[rotateIndex % v.length];
}
/** Seconds per screen, 0 = no rotation. The admin preview pane follows the setting too. */
function rotateSeconds(s) {
  if (PINNED) return 0;
  return URL_ROTATE ?? s?.config?.tvRotate ?? 0;
}
let rotateTimer = 0;
let rotateEvery = 0;
/** (Re)start the rotation timer; `restart` gives the current screen its full time. */
function scheduleRotation({ restart = false } = {}) {
  const secs = rotateSeconds(store.get());
  if (secs === rotateEvery && !restart) return;
  clearInterval(rotateTimer);
  rotateEvery = secs;
  if (!secs) return;
  rotateTimer = setInterval(() => {
    rotateIndex++;
    render({ transition: true });
  }, secs * 1000);
}

// ---------------------------------------------------------------- change tracking (for animations)

let prevLegs = new Map(); // fixtureId -> "h-a"
let prevPositions = null; // teamId -> position
const movement = new Map(); // teamId -> {dir, until}
let prevPhase = null;
let prevDone = null;

function trackChanges(s) {
  const bumps = new Set();
  const legs = new Map();
  for (const f of s.fixtures) {
    if (f.status !== 'live') continue;
    legs.set(f.id, [f.homeLegs, f.awayLegs]);
    const p = prevLegs.get(f.id);
    if (p) {
      if (p[0] !== f.homeLegs) bumps.add(`${f.id}-home`);
      if (p[1] !== f.awayLegs) bumps.add(`${f.id}-away`);
    }
  }
  prevLegs = legs;

  const rows = T.liveStandings(s);
  const now = Date.now();
  if (prevPositions) {
    for (const r of rows) {
      const before = prevPositions.get(r.teamId);
      if (before && before !== r.position) movement.set(r.teamId, { dir: r.position < before ? 'up' : 'down', until: now + 12000 });
    }
  }
  prevPositions = new Map(rows.map((r) => [r.teamId, r.position]));

  const done = new Set(s.fixtures.filter((f) => f.status === 'done').map((f) => f.id));
  const fresh = prevDone ? [...done].filter((id) => !prevDone.has(id)) : [];
  prevDone = done;

  const phaseChanged = prevPhase !== null && prevPhase !== s.phase;
  prevPhase = s.phase;
  return { bumps, rows, fresh, phaseChanged };
}

// ---------------------------------------------------------------- render

let lastKey = '';
function render({ transition = false, changes = null } = {}) {
  const s = store.get();
  if (!s) {
    stage.innerHTML = waitingScreen();
    return;
  }
  applyTheme(s);
  document.title = `${s.config.title} · Live`;
  const ch = changes ?? { bumps: new Set(), rows: T.liveStandings(s), fresh: [], phaseChanged: false };
  const view = currentView(s);

  // FLIP: remember where table rows were before re-rendering.
  const before = new Map($$('[data-team-row]', stage).map((el) => [el.dataset.teamRow, el.getBoundingClientRect().top]));

  const key = `${view}|${s.phase}`;
  const fade = transition || ch.phaseChanged || (lastKey && key !== lastKey);
  lastKey = key;

  stage.className = `phase-${s.phase}`;
  stage.innerHTML = `${header(s)}<main class="body view-${view} phase-${s.phase}">${body(s, view, ch)}</main>`;
  if (fade && !reducedMotion) stage.querySelector('main').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' });

  if (!reducedMotion) {
    for (const el of $$('[data-team-row]', stage)) {
      const top = before.get(el.dataset.teamRow);
      if (top === undefined) continue;
      const dy = (top - el.getBoundingClientRect().top) / scale;
      if (Math.abs(dy) > 1) {
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 1100, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    }
    for (const id of ch.bumps) $(`[data-legs="${id}"]`, stage)?.classList.add('bump');
  }
  updateClock();
  confetti.toggle(s.phase === 'complete' && view === 'auto');
}

function waitingScreen() {
  return `<div class="waiting-screen">
    <img class="waiting-logo" src="img/logo.png" alt="James Watkins Invitational">
    <h1>Waiting for the organiser…</h1>
    <p>Open <strong>admin.html</strong> in another window of <strong>this browser</strong> on this laptop. This screen updates by itself.</p>
    <p class="origin">The admin page must use the same address: <strong>${esc(location.origin)}</strong> — and not a private window.</p>
  </div>`;
}

function header(s) {
  const { played, total } = T.leagueProgress(s);
  let phase = '';
  if (s.phase === 'setup') phase = 'Starting soon';
  else if (s.phase === 'league') phase = `League · ${played} of ${total} played`;
  else if (s.phase === 'knockout') phase = 'Knockout';
  else phase = 'Final result';
  const pct = s.phase === 'league' && total ? Math.round((played / total) * 100) : s.phase === 'setup' ? 0 : 100;
  return `<header class="tv-head">
    <div class="tv-title">
      ${s.config.showLogo ? '<img class="head-logo" src="img/logo.png" alt="">' : '<span class="dart-logo">🎯</span>'}
      <div><h1>${esc(s.config.title)}</h1>${s.config.subtitle ? `<p>${esc(s.config.subtitle)}</p>` : ''}</div>
    </div>
    <div class="tv-phase">
      <span>${esc(phase)}</span>
      ${s.phase === 'league' ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
    </div>
    <div class="tv-clock num" id="clock"></div>
  </header>`;
}

function body(s, view, ch) {
  if (s.phase === 'setup') return setupView(s);
  switch (view) {
    case 'table': return `<section class="panel full">${panelTitle('League table')}${tableHTML(s, ch.rows, { full: true })}</section>`;
    case 'fixtures': return fixturesView(s, ch);
    case 'chart': return `<section class="panel full">${panelTitle('Race for the top', `<span class="hint">League position after each match · top ${s.config.qualifiers} highlighted</span>`)}${positionChartHTML(s)}</section>`;
    case 'grid': return `<section class="panel full">${panelTitle('Head to head', '<span class="hint">Read across: the row team’s score first</span>')}${gridHTML(s, ch.rows)}</section>`;
    case 'stats': return statsView(s);
    case 'bracket': return `<section class="panel full">${panelTitle(s.phase === 'league' ? 'Knockout · if the league ended now' : 'Knockout')}${bracketHTML(s, ch.rows)}</section>`;
    default:
      if (s.phase === 'league') return leagueView(s, ch);
      if (s.phase === 'knockout') return knockoutView(s, ch);
      return championView(s);
  }
}

/** The logo already spells out the tournament name, so don't repeat it next to the logo. */
const logoSaysTitle = (s) => s.config.showLogo && /james\s+watkins\s+invitational/i.test(s.config.title);

const panelTitle = (t, extra = '') => `<h2 class="panel-title">${esc(t)}${extra}</h2>`;

// ---------- setup

function setupView(s) {
  const n = s.teams.length;
  const cols = n > 12 ? 4 : n > 6 ? 3 : 2;
  return `<section class="setup">
    <div class="setup-hero">
      ${s.config.showLogo ? `<img class="hero-logo" src="img/logo.png" alt="${esc(s.config.title)}">` : '<div class="eyebrow">Doubles darts</div>'}
      ${logoSaysTitle(s) ? '' : `<h2 class="${s.config.showLogo ? 'with-logo' : ''}">${esc(s.config.title)}</h2>`}
      ${s.config.subtitle ? `<p class="sub">${esc(s.config.subtitle)}</p>` : ''}
      <p class="rules">${s.config.doubleRoundRobin ? 'Everyone plays everyone twice' : 'Everyone plays everyone once'} · ${legsFormat(s.config.bestOf.league)}${s.config.fixtureRule === 'pairs' ? ' · 2 on, 1 off' : ''} · top 4 to the semi-finals</p>
    </div>
    <div class="setup-teams">
      <h3>${n ? `${n} team${n === 1 ? '' : 's'} registered` : 'Teams to be announced'}</h3>
      <div class="team-grid" style="--cols:${cols}">
        ${s.teams.map((t) => `<div class="team-card"><strong>${esc(t.name)}</strong><span>${esc(t.players.filter(Boolean).join(' & '))}</span></div>`).join('')}
      </div>
    </div>
  </section>`;
}

// ---------- live cards

function liveCards(s, ch, { compact = false, stacked = false } = {}) {
  const next = T.nextUp(s);
  return `<section class="live-row ${compact ? 'compact' : ''} ${stacked ? 'stacked' : ''}">${[1, 2].map((b) => liveCard(s, b, next[b] ?? next.waiting?.[b], ch, !next[b] && !!next.waiting?.[b])).join('')}</section>`;
}

function liveCard(s, board, suggested, ch, waiting = false) {
  const name = esc(s.config.boardNames[board - 1]);
  const f = T.liveOnBoard(s, board);
  if (!f) {
    return `<article class="live-card idle">
      <div class="lc-head"><span class="board-name">${name}</span><span class="pill">${suggested ? 'Next up' : 'Free'}</span></div>
      ${suggested
        ? nextUpHTML(s, suggested, waiting)
        : `<div class="lc-next muted-big">${s.phase === 'complete' ? 'All done' : 'No match'}</div>`}
    </article>`;
  }
  const need = legsToWinFor(s.config, f.stage);
  const side = (which) => {
    const legs = which === 'home' ? f.homeLegs : f.awayLegs;
    const id = which === 'home' ? f.homeId : f.awayId;
    const lead = legs > (which === 'home' ? f.awayLegs : f.homeLegs);
    return `<div class="lc-team ${which} ${legs === need ? 'won' : lead ? 'leading' : ''}">
      <div class="lc-name">${esc(slotName(s, f, which))}</div>
      <div class="lc-players">${esc(playersText(s, id))}</div>
      <div class="lc-pips">${Array.from({ length: need }, (_, i) => `<i class="${i < legs ? 'on' : ''}"></i>`).join('')}</div>
      ${f[`${which}Avg`] != null ? `<div class="lc-avg">3-dart avg <b class="num" data-avg="${f.id}-${which}">${fmtAvg(f[`${which}Avg`])}</b></div>` : ''}
    </div>`;
  };
  return `<article class="live-card">
    <div class="lc-head"><span class="board-name">${name}</span><span class="pill live">● LIVE</span><span class="lc-stage">${esc(stageName(f))}</span></div>
    <div class="lc-body">
      ${side('home')}
      <div class="lc-score num"><span data-legs="${f.id}-home">${f.homeLegs}</span><b>–</b><span data-legs="${f.id}-away">${f.awayLegs}</span></div>
      ${side('away')}
    </div>
    ${stakesHTML(s, f)}
  </article>`;
}

/** "What's at stake" line under a live match (falls back to the match format). */
function stakesHTML(s, f) {
  const line = I.matchStakes(s, f).lines[0];
  if (!line) return `<div class="lc-meta">${esc(formatLine(s, f))}</div>`;
  return `<div class="lc-meta stakes"><b>At stake</b>${esc(line)}</div>`;
}

/** Next-up card: both teams with table position, points and form, plus their last meeting. */
function nextUpHTML(s, f, waiting) {
  const p = f.homeId && f.awayId ? I.matchupPreview(s, f) : null;
  const stat = (x) => (x && s.phase === 'league' && x.played
    ? `<div class="nx-stat"><span>${I.ordinal(x.position)} · ${x.points} pts</span><span class="pips">${x.form.map((r) => `<i class="${r}">${r}</i>`).join('')}</span></div>`
    : '');
  let meta = `${esc(stageName(f))} · ${waiting ? 'after the other board finishes' : 'get ready!'}`;
  if (p?.last) {
    const w = winnerOf(p.last);
    meta = `${esc(stageName(f))} · Last time: <strong>${esc(T.teamName(s, w))}</strong> won ${Math.max(p.last.homeLegs, p.last.awayLegs)}–${Math.min(p.last.homeLegs, p.last.awayLegs)}${waiting ? ' · after the other board finishes' : ''}`;
  }
  return `<div class="lc-next">
      <div class="nx h">${slotBlock(s, f, 'home', { cls: 'end' })}${stat(p?.home)}</div><em>v</em><div class="nx a">${slotBlock(s, f, 'away')}${stat(p?.away)}</div>
    </div>
    <div class="lc-meta">${meta}</div>`;
}

// ---------- league

function leagueView(s, ch) {
  if (s.teams.length > 10) {
    // Big league: the table gets the full height so the text stays readable.
    return `<section class="league-tall">
      <div class="panel table-panel">${panelTitle('League table', `<span class="hint">Top ${s.config.qualifiers} reach the semi-finals</span>`)}${tableHTML(s, ch.rows, { avail: 790 })}</div>
      <div class="side-col tall">
        ${liveCards(s, ch, { stacked: true })}
        <div class="panel">${panelTitle('Up next')}${upNextHTML(s, 2)}</div>
        <div class="panel">${panelTitle('Latest results')}${resultsHTML(s, 2, ch.fresh)}</div>
      </div>
    </section>`;
  }
  return `${liveCards(s, ch)}
  <section class="league-grid">
    <div class="panel table-panel">${panelTitle('League table', `<span class="hint">Top ${s.config.qualifiers} reach the semi-finals</span>`)}${tableHTML(s, ch.rows)}</div>
    <div class="side-col">
      <div class="panel">${panelTitle('Up next')}${upNextHTML(s, 3)}</div>
      <div class="panel">${panelTitle('Latest results')}${resultsHTML(s, 3, ch.fresh)}</div>
    </div>
  </section>`;
}

function tableHTML(s, rows, { full = false, avail: availOverride } = {}) {
  const q = s.config.qualifiers;
  const avail = availOverride ?? (full ? 790 : 460);
  const rowH = Math.max(28, Math.min(full ? 72 : 60, Math.floor(avail / Math.max(rows.length, 1))));
  const now = Date.now();
  const anyLive = rows.some((r) => r.live);
  const league = s.phase === 'league';
  const quals = league ? I.qualificationStatus(s) : new Map();
  const { streaks } = I.records(s);
  // The race column only appears once someone is through, out, or close to sure.
  const race = full && league && [...quals.values()].some((x) => x.status !== 'alive' || (x.needs && x.needs <= 3));
  return `<table class="tv-table with-avg ${full ? 'full' : 'compact'} ${anyLive ? 'any-live' : ''}" style="--row-h:${rowH}px">
    <thead><tr><th class="pos">#</th><th class="team">Team</th><th>P</th><th>W</th><th>L</th><th>+/-</th><th class="avg-h">Avg</th><th class="pts">Pts</th><th class="form-h">Form</th>${race ? '<th class="race-h">Semi-finals</th>' : ''}</tr></thead>
    <tbody>${rows.map((r, i) => {
      const mv = movement.get(r.teamId);
      const arrow = mv && mv.until > now ? `<span class="mv ${mv.dir}">${mv.dir === 'up' ? '▲' : '▼'}</span>` : '';
      const qs = quals.get(r.teamId);
      const run = streaks.get(r.teamId)?.current ?? 0;
      const marks = `${qs?.status === 'in' ? '<span class="qmark" title="Sure of a semi-final place">✓</span>' : ''}${run >= 3 ? `<span class="hot" title="${run} wins in a row">🔥${run}</span>` : ''}`;
      return `<tr data-team-row="${r.teamId}" class="${i < q ? 'q' : ''} ${i === q - 1 && rows.length > q ? 'cut' : ''} ${r.live ? 'playing' : ''} ${qs?.status === 'out' ? 'out' : ''}">
        <td class="pos num">${r.position}${r.tiedWithPrev ? '<span class="tie">=</span>' : ''}</td>
        <td class="team"><span class="tcell">${teamBlock(s, r.teamId, { inline: rows.length > 10, cls: 'nm' })}${marks}${arrow}</span></td>
        <td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.lost}</td>
        <td class="num">${r.legDiff > 0 ? '+' : ''}${r.legDiff}</td><td class="num avg">${fmtAvg(r.avg) || '–'}</td>
        <td class="pts num">${r.points}</td>
        <td class="form">${formHTML(r)}</td>
        ${race ? `<td class="race ${qs?.status ?? ''}">${raceText(qs)}</td>` : ''}
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function raceText(qs) {
  if (!qs) return '';
  if (qs.status === 'in') return '✓ Through';
  if (qs.status === 'out') return 'Can’t make it';
  if (qs.needs && qs.needs <= 3) return qs.needs === qs.remaining ? `Win all ${qs.remaining} to be sure` : `Win ${qs.needs} of ${qs.remaining} to be sure`;
  return 'Still in it';
}

/**
 * Last 5 finished league matches, oldest → newest. A match being played now
 * is added on the right as a pulsing pip showing how it stands (W / L / –).
 */
function formHTML(r) {
  const past = r.form.map((x) => `<i class="${x}">${x}</i>`).join('');
  const live = r.live
    ? `<i class="now ${r.liveResult === 'level' ? 'D' : r.liveResult}" title="Playing now">${r.liveResult === 'level' ? '–' : r.liveResult}</i>`
    : '';
  return past || live ? past + live : '<span class="none">–</span>';
}

function upNextHTML(s, n) {
  const q = T.upcoming(s).slice(0, n);
  if (!q.length) return `<p class="empty">${s.phase === 'knockout' ? 'Waiting for results…' : 'No more matches'}</p>`;
  const next = T.nextUp(s);
  const boardOf = new Map([[next[1]?.id, 1], [next[2]?.id, 2]]);
  return `<ol class="list">${q.map((f) => {
    const b = boardOf.get(f.id);
    const board = b ?? f.plannedBoard;
    return `<li><span class="tagc ${board ? `b${board}` : ''}">${board ? esc(s.config.boardNames[board - 1]) : esc(stageName(f, { short: true }))}</span>
      <span class="teams">${slotBlock(s, f, 'home')}<em>v</em>${slotBlock(s, f, 'away')}</span></li>`;
  }).join('')}</ol>`;
}

function resultsHTML(s, n, fresh = []) {
  const list = T.recentResults(s, n);
  if (!list.length) return '<p class="empty">No results yet</p>';
  return `<ol class="list results">${list.map((f) => {
    const w = winnerOf(f);
    return `<li class="${fresh.includes(f.id) ? 'fresh' : ''}">
      <span class="tagc">${esc(stageName(f, { short: true }))}</span>
      <span class="res">${slotBlock(s, f, 'home', { cls: w === f.homeId ? 'w' : 'l' })}
      <b class="num">${f.homeLegs}–${f.awayLegs}</b>
      ${slotBlock(s, f, 'away', { cls: w === f.awayId ? 'w' : 'l' })}</span></li>`;
  }).join('')}</ol>`;
}

function fixturesView(s, ch) {
  return `<section class="fixtures-grid">
    <div class="panel">${panelTitle('Up next')}${upNextHTML(s, 8)}</div>
    <div class="panel">${panelTitle('Results')}${resultsHTML(s, 8, ch.fresh)}</div>
  </section>`;
}

// ---------- knockout

function knockoutView(s, ch) {
  return `${liveCards(s, ch, { compact: true })}
  <section class="panel bracket-panel">${panelTitle('Knockout')}${bracketHTML(s, ch.rows)}</section>`;
}

function bracketHTML(s, rows) {
  let v = bracketView(s.fixtures);
  let projected = false;
  let seeds = s.seeds;
  if (!v.semis[0]) {
    // League phase: show who would qualify if it ended now.
    seeds = knockoutSeeding(rows).seeds;
    if (seeds.length < 4) return '<p class="empty">Knockout starts after the league.</p>';
    projected = true;
    const fake = [
      { id: 'SF1', stage: 'semi', homeId: seeds[0], awayId: seeds[3], status: 'scheduled', homeLegs: 0, awayLegs: 0 },
      { id: 'SF2', stage: 'semi', homeId: seeds[1], awayId: seeds[2], status: 'scheduled', homeLegs: 0, awayLegs: 0 },
      { id: 'F', stage: 'final', homeId: null, awayId: null, status: 'scheduled', homeLegs: 0, awayLegs: 0 },
    ];
    v = bracketView(fake);
  }
  const seedNo = (id) => {
    const i = (seeds ?? []).indexOf(id);
    return i >= 0 ? `<span class="seed">${i + 1}</span>` : '<span class="seed"></span>';
  };
  const box = (f, cls = '') => {
    if (!f) return '';
    const w = winnerOf(f);
    const line = (which) => {
      const id = which === 'home' ? f.homeId : f.awayId;
      const legs = which === 'home' ? f.homeLegs : f.awayLegs;
      const state = w ? (w === id ? 'win' : 'lose') : '';
      return `<div class="bm-team ${state} ${id ? '' : 'tbd'}">${f.stage === 'semi' ? seedNo(id) : ''}${slotBlock(s, f, which, { cls: 'nm' })}
        <span class="lg num" ${f.status === 'live' ? `data-legs="${f.id}-${which}"` : ''}>${f.status === 'scheduled' ? '' : legs}</span></div>`;
    };
    const status = f.status === 'live' ? `<span class="pill live">● LIVE · ${esc(s.config.boardNames[f.board - 1])}</span>` : '';
    return `<div class="bm ${f.status} ${cls}"><div class="bm-head">${esc(stageName(f))}${status}</div>${line('home')}${line('away')}</div>`;
  };
  const champ = v.championId;
  return `<div class="bracket ${projected ? 'projected' : ''}">
    <div class="br-col semis">${box(v.semis[0])}${box(v.semis[1])}</div>
    <div class="br-join"><i></i></div>
    <div class="br-col final">${box(v.final, 'final-box')}${v.third ? box(v.third, 'third-box') : ''}</div>
    <div class="br-join single"><i></i></div>
    <div class="br-col champ ${champ ? 'has' : ''}">
      <div class="trophy">🏆</div>
      <div class="champ-label">Champions</div>
      <div class="champ-name">${champ ? esc(T.teamName(s, champ)) : '?'}</div>
    </div>
  </div>`;
}

// ---------- position chart

// Four categorical hues for the current top 4 (checked for colour-blind
// separation against the panel; every line also carries a direct label).
const CHART_COLORS = ['#3987e5', '#d95926', '#199e70', '#e66767'];

function positionChartHTML(s) {
  const { fixtures, steps } = I.positionHistory(s);
  if (steps.length < 2) return '<p class="empty">The chart appears after a couple of results.</p>';
  const n = s.teams.length;
  const q = s.config.qualifiers;
  const VW = 1760;
  const VH = 800;
  const L = 70;
  const R = 380;
  const TOP = 24;
  const B = 64;
  const pw = VW - L - R;
  const ph = VH - TOP - B;
  const x = (i) => L + (steps.length === 1 ? pw : (i / (steps.length - 1)) * pw);
  const y = (p) => TOP + (n === 1 ? 0 : ((p - 1) / (n - 1)) * ph);
  const last = steps[steps.length - 1];
  const order = [...last].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  const color = new Map(order.slice(0, q).map((id, i) => [id, CHART_COLORS[i]]));
  const path = (id) => steps.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(m.get(id)).toFixed(1)}`).join('');
  const grid = Array.from({ length: n }, (_, i) => `<line class="grid" x1="${L}" x2="${L + pw}" y1="${y(i + 1)}" y2="${y(i + 1)}"/>
    <text class="axis" x="${L - 18}" y="${y(i + 1)}" text-anchor="end" dominant-baseline="central">${i + 1}</text>`).join('');
  const cutY = n > q ? (y(q) + y(q + 1)) / 2 : null;
  const every = Math.max(1, Math.ceil(steps.length / 12));
  const ticks = steps.map((_, i) => i).filter((i) => (i + 1) % every === 0 || i === 0)
    .map((i) => `<text class="axis" x="${x(i)}" y="${TOP + ph + 36}" text-anchor="middle">${i + 1}</text>`).join('');
  const grey = order.slice(q).map((id) => `<path class="ln dim" d="${path(id)}"/>`).join('');
  const lit = order.slice(0, q).reverse().map((id) => `<path class="ln" d="${path(id)}" stroke="${color.get(id)}"/>
    <circle cx="${x(steps.length - 1)}" cy="${y(last.get(id))}" r="8" fill="${color.get(id)}" class="end"/>`).join('');
  const labels = order.map((id) => {
    const p = last.get(id);
    const c = color.get(id);
    return `<text class="lbl ${c ? '' : 'dim'}" x="${L + pw + 24}" y="${y(p)}" dominant-baseline="central">${p}. ${esc(T.teamName(s, id))}</text>`;
  }).join('');
  return `<svg class="pos-chart" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="League position of each team after each of ${fixtures.length} matches">
    ${grid}
    ${cutY ? `<line class="cut" x1="${L}" x2="${L + pw}" y1="${cutY}" y2="${cutY}"/>` : ''}
    ${ticks}<text class="axis title" x="${L + pw / 2}" y="${VH - 4}" text-anchor="middle">League matches played</text>
    ${grey}${lit}${labels}
  </svg>`;
}

// ---------- head-to-head grid

function gridHTML(s, rows) {
  const h2h = I.headToHead(s);
  const ids = rows.map((r) => r.teamId);
  const n = ids.length;
  const rowH = Math.min(90, Math.floor((750 - (n + 2) * 4) / (n + 0.7))); // rows + header + spacing fit the panel
  const cell = (a, b) => {
    if (a === b) return '<td class="self"></td>';
    const list = h2h.get(`${a}|${b}`) ?? [];
    const chips = list.map((f) => {
      const mine = f.homeId === a ? f.homeLegs : f.awayLegs;
      const theirs = f.homeId === a ? f.awayLegs : f.homeLegs;
      if (f.status === 'scheduled') return '<i class="todo">·</i>';
      const cls = f.status === 'live' ? 'live' : mine > theirs ? 'W' : 'L';
      return `<i class="${cls}">${mine}–${theirs}</i>`;
    }).join('');
    return `<td>${chips}</td>`;
  };
  return `<table class="h2h" style="--cell-h:${rowH}px">
    <thead><tr><th class="corner"></th>${ids.map((_, i) => `<th>${i + 1}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><th class="rowh"><span class="p">${r.position}</span>${teamBlock(s, r.teamId, { inline: true, cls: 'nm' })}</th>${ids.map((b) => cell(r.teamId, b)).join('')}</tr>`).join('')}</tbody>
  </table>`;
}

// ---------- stats: averages, streaks and records

function statsView(s) {
  const a = I.averagesBoard(s);
  const r = I.records(s);
  const name = (id) => esc(T.teamName(s, id));
  const vsOf = (f, id) => name(f.homeId === id ? f.awayId : f.homeId);
  const max = Math.max(1, ...a.season.map((x) => x.avg));
  const avgPanel = !a.count ? '<p class="empty">No 3-dart averages recorded yet.</p>' : `
    <h3>Best average</h3>
    <ol class="bars">${a.season.map((x, i) => `<li><span class="rk">${i + 1}</span><span class="nm">${name(x.teamId)}</span>
      <span class="bar"><i style="width:${((x.avg / max) * 100).toFixed(1)}%"></i></span><b class="num">${fmtAvg(x.avg)}</b><em>${x.count} match${x.count === 1 ? '' : 'es'}</em></li>`).join('')}</ol>
    <h3>Best single match</h3>
    <ol class="facts">${a.bestMatch.slice(0, 3).map((x) => `<li><b class="num">${fmtAvg(x.avg)}</b><span>${name(x.teamId)} <em>v ${vsOf(x.fixture, x.teamId)} · ${esc(stageName(x.fixture, { short: true }))}</em></span></li>`).join('')}</ol>
    ${a.improved.length ? `<h3>On the up</h3><ol class="facts">${a.improved.map((x) => `<li><b class="num up">+${x.change.toFixed(1)}</b><span>${name(x.teamId)} <em>last 3: ${fmtAvg(x.recent)} · before: ${fmtAvg(x.earlier)}</em></span></li>`).join('')}</ol>` : ''}`;
  const up = r.upset;
  const recPanel = `
    <ol class="facts big">
      <li><b class="num">${r.longest.length || '–'}</b><span>Longest winning run<em>${r.longest.teamIds.map(name).join(', ') || 'No results yet'}</em></span></li>
      <li><b class="num">${r.hot[0]?.length ?? '–'}</b><span>On fire now 🔥<em>${r.hot.length ? r.hot.map((h) => `${name(h.teamId)} (${h.length})`).join(', ') : 'Nobody on 3+ wins in a row'}</em></span></li>
      <li><b class="num">${r.whitewashes[0]?.count ?? '–'}</b><span>Most whitewashes<em>${r.whitewashes.length ? r.whitewashes.filter((w) => w.count === r.whitewashes[0].count).map((w) => name(w.teamId)).join(', ') + ' · wins without dropping a leg' : 'Wins without dropping a leg'}</em></span></li>
      <li><b class="num">${up ? `↑${up.gap}` : '–'}</b><span>Biggest upset${up ? ` · ${up.gap} place${up.gap === 1 ? '' : 's'} apart` : ''}<em>${up ? `${name(up.winnerId)} (${I.ordinal(up.winnerPos)}) beat ${name(up.loserId)} (${I.ordinal(up.loserPos)}) ${Math.max(up.fixture.homeLegs, up.fixture.awayLegs)}–${Math.min(up.fixture.homeLegs, up.fixture.awayLegs)}` : 'None yet'}</em></span></li>
    </ol>`;
  return `<section class="stats-grid">
    <div class="panel">${panelTitle('3-dart averages')}${avgPanel}</div>
    <div class="panel">${panelTitle('Streaks & records')}${recPanel}</div>
  </section>`;
}

// ---------- champion

function championView(s) {
  const v = bracketView(s.fixtures);
  const f = v.final;
  const champ = v.championId;
  const players = playersText(s, champ);
  const score = f ? `${Math.max(f.homeLegs, f.awayLegs)}–${Math.min(f.homeLegs, f.awayLegs)}` : '';
  return `<section class="champion">
    ${s.config.showLogo
      ? `<img class="ch-logo" src="img/logo.png" alt=""><div class="ch-eyebrow">${logoSaysTitle(s) ? '' : `${esc(s.config.title)} · `}Champions</div>`
      : `<div class="ch-eyebrow">${esc(s.config.title)} · Champions</div><div class="ch-trophy">🏆</div>`}
    <h2 class="ch-name">${esc(T.teamName(s, champ))}</h2>
    ${players ? `<p class="ch-players">${esc(players)}</p>` : ''}
    <p class="ch-final">beat <strong>${esc(T.teamName(s, v.runnerUpId))}</strong> <span class="num">${score}</span> in the final</p>
    <div class="ch-podium">
      <div><span>Runners-up</span><strong>${esc(T.teamName(s, v.runnerUpId))}</strong>${playersText(s, v.runnerUpId) ? `<em>${esc(playersText(s, v.runnerUpId))}</em>` : ''}</div>
      ${v.thirdId ? `<div><span>Third place</span><strong>${esc(T.teamName(s, v.thirdId))}</strong>${playersText(s, v.thirdId) ? `<em>${esc(playersText(s, v.thirdId))}</em>` : ''}</div>` : ''}
    </div>
  </section>`;
}

// ---------------------------------------------------------------- clock

function updateClock() {
  const el = $('#clock');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 10000);

// Expire movement arrows.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of movement) if (v.until <= now) { movement.delete(k); changed = true; }
  if (changed) render();
}, 3000);

// ---------------------------------------------------------------- confetti

const confetti = (() => {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  let parts = [];
  let running = false;
  let started = 0;
  let raf = 0;
  const colors = ['#ffc928', '#ef4b4f', '#2fc172', '#5b9bff', '#ffffff'];
  const resize = () => { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; };
  addEventListener('resize', resize);
  resize();
  const spawn = (n, burst) => {
    for (let i = 0; i < n; i++) {
      parts.push({
        x: Math.random() * canvas.width,
        y: burst ? -Math.random() * canvas.height * 0.5 : -20,
        vx: (Math.random() - 0.5) * 2 * devicePixelRatio,
        vy: (2 + Math.random() * 3) * devicePixelRatio,
        r: (5 + Math.random() * 7) * devicePixelRatio,
        a: Math.random() * Math.PI,
        va: (Math.random() - 0.5) * 0.2,
        c: colors[(Math.random() * colors.length) | 0],
      });
    }
  };
  const tick = () => {
    if (!running) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Big burst for 6 s, then a gentle trickle.
    if (Date.now() - started > 6000 ? Math.random() < 0.15 : true) spawn(Date.now() - started > 6000 ? 1 : 4, false);
    parts = parts.filter((p) => p.y < canvas.height + 30);
    for (const p of parts) {
      p.x += p.vx + Math.sin(p.a) * 0.6;
      p.y += p.vy;
      p.a += p.va;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    }
    raf = requestAnimationFrame(tick);
  };
  return {
    toggle(on) {
      if (reducedMotion) on = false;
      if (on === running) return;
      running = on;
      cancelAnimationFrame(raf);
      if (on) {
        started = Date.now();
        parts = [];
        spawn(160, true);
        tick();
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    },
  };
})();

// ---------------------------------------------------------------- TV niceties: wake lock, fullscreen, cursor

let wakeLock = null;
async function keepAwake() {
  if (PREVIEW || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not allowed yet (e.g. needs a click) — retried on click/visibility */ }
}
document.addEventListener('visibilitychange', () => { if (!wakeLock) keepAwake(); });

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

if (!PREVIEW) {
  const hint = $('#fs-hint');
  if (!document.fullscreenElement) {
    hint.hidden = false;
    setTimeout(() => hint.classList.add('gone'), 15000);
  }
  document.addEventListener('click', () => {
    hint.hidden = true;
    if (!document.fullscreenElement) toggleFullscreen();
    if (!wakeLock) keepAwake();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') { hint.hidden = true; toggleFullscreen(); if (!wakeLock) keepAwake(); }
  });
  document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) hint.hidden = true; });

  let cursorTimer = 0;
  const showCursor = () => {
    document.body.classList.remove('no-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.add('no-cursor'), 2000);
  };
  addEventListener('mousemove', showCursor);
  showCursor();
  keepAwake();
} else {
  document.body.classList.add('preview', 'no-cursor');
}

// ---------------------------------------------------------------- presence
// Tell the admin window we're here; notice if the admin window goes quiet.
let adminSeenAt = 0;
store.onMessage((msg) => {
  if (msg.type === 'admin-beat') {
    adminSeenAt = Date.now();
    if ((Number(msg.version) || 0) > APP_VERSION) refreshForUpdate(Number(msg.version));
    updateLink();
  }
});
function updateLink() {
  const badge = $('#link-badge');
  if (!badge || PREVIEW) return;
  // Only warn once the page has had time to hear from the admin window.
  const quiet = Date.now() - adminSeenAt > 10000 && performance.now() > 10000;
  badge.hidden = !quiet;
}
// Also tells the admin page what's on screen, so Settings can say whether the TV is rotating.
const beat = () => {
  const s = store.get();
  store.post({
    type: 'tv-beat', at: Date.now(), preview: PREVIEW, version: APP_VERSION,
    view: currentView(s), rotate: rotateSeconds(s), screens: viewsFor(s).length, pinned: PINNED, urlRotate: URL_ROTATE,
  });
};

/**
 * The admin page is running a newer release than this TV window (which may
 * have been open since before the deploy): reload to pick it up. Guarded so a
 * stubborn cache can't cause a reload loop.
 */
function refreshForUpdate(version) {
  const KEY = 'dartsDashboard.tvUpdateTried';
  try {
    const last = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (last && last.version === version && Date.now() - last.at < 120000) return;
    sessionStorage.setItem(KEY, JSON.stringify({ version, at: Date.now() }));
  } catch { /* no sessionStorage: still try once per page load */ }
  location.reload();
}
beat();
setInterval(() => { beat(); updateLink(); }, 2000);

// ---------------------------------------------------------------- go

store.subscribe((s) => {
  if (!s) return render();
  const changes = trackChanges(s);
  // A score change brings a rotating screen back to the live view, for a full turn.
  const scored = changes.bumps.size || changes.fresh.length;
  if (rotateSeconds(s) && scored) rotateIndex = 0;
  scheduleRotation({ restart: !!scored });
  render({ changes });
});

if (store.get()) render({ changes: trackChanges(store.get()) });
else render();
scheduleRotation();
registerServiceWorker();
