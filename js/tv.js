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
const PINNED = ['table', 'fixtures', 'bracket', 'chart', 'grid', 'stats', 'team', 'tape', 'final'].includes(params.get('view')) ? params.get('view') : null;
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
  const ov = document.getElementById('overlay');
  if (ov) ov.style.transform = stage.style.transform;
}
addEventListener('resize', fit);
fit();

// ---------------------------------------------------------------- view rotation

let rotateIndex = 0;
function viewsFor(s) {
  if (!s || s.phase === 'setup') return ['auto'];
  const hasChart = I.finishedLeague(s).length >= 2;
  const hasStats = s.fixtures.some((f) => f.status === 'done');
  // The knockout gets its own set: tale of the tape for the next match(es), the
  // bracket, the final league table, the four teams still in, and stats. Once
  // the finalists are known the live screen itself becomes the final spotlight.
  const ko = finalFixture(s) ? [] : ['tape'];
  const views = s.phase === 'league' ? ['auto', 'table', 'chart', 'grid', 'team', 'stats', 'fixtures']
    : s.phase === 'knockout' ? ['auto', ...ko, 'bracket', 'table', 'team', 'stats']
      : ['auto', 'bracket', 'table', 'chart', 'team', 'stats'];
  return views.filter((v) => (v !== 'chart' || hasChart) && (v !== 'stats' || hasStats)
    && (v !== 'tape' || pendingKnockout(s).length > 0) && (v !== 'team' || hasStats));
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
    if (currentView(store.get()) === 'team') spotlightIndex++;
    render({ transition: true });
  }, secs * 1000);
}

// ---------------------------------------------------------------- change tracking (for animations)

let prevLegs = new Map(); // fixtureId -> "h-a"
let prevBoards = new Map(); // live fixtureId -> board
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
  const boards = new Map(s.fixtures.filter((f) => f.status === 'live').map((f) => [f.id, f.board]));
  const lastBoards = prevBoards;
  prevBoards = boards;

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
  const finished = fresh.map((id) => ({ id, board: lastBoards.get(id) ?? T.fixtureById(s, id)?.plannedBoard ?? null }));

  const phaseChanged = prevPhase !== null && prevPhase !== s.phase;
  const knockoutStarted = prevPhase === 'league' && s.phase === 'knockout';
  prevPhase = s.phase;
  return { bumps, rows, fresh, finished, phaseChanged, knockoutStarted };
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
    for (const id of ch.bumps) for (const el of $$(`[data-legs="${id}"]`, stage)) el.classList.add('bump');
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
  else if (s.phase === 'knockout') phase = finalFixture(s) ? 'The Final' : 'Knockout';
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
      <div class="tv-eta" id="eta">${etaText(s)}</div>
    </div>
    <div class="tv-clock num" id="clock"></div>
  </header>`;
}

// Height the live strip takes from the other screens (strip + gap).
const STRIP_H = 142;

function body(s, view, ch) {
  if (s.phase === 'setup') return setupView(s);
  if (view === 'auto' && finalFixture(s)) view = 'final';
  if (view === 'final') {
    // The final has the stage; anything else still being played goes along the bottom.
    const others = T.liveFixtures(s).filter((f) => f.stage !== 'final');
    return finalView(s, others.length > 0) + liveStripHTML(s, others);
  }
  if (view === 'auto') return viewBody(s, view, ch, false);
  // Every other screen (rotating or pinned) keeps the live scores along the bottom.
  const strip = T.liveFixtures(s).length > 0;
  return viewBody(s, view, ch, strip) + liveStripHTML(s);
}

function viewBody(s, view, ch, strip) {
  switch (view) {
    case 'team': return spotlightHTML(s, strip);
    case 'tape': return tapeView(s);
    case 'table': return `<section class="panel full">${panelTitle(s.phase === 'league' ? 'League table' : 'Final league table')}${tableHTML(s, ch.rows, { full: true, avail: 790 - (strip ? STRIP_H : 0) })}</section>`;
    case 'fixtures': return fixturesView(s, ch);
    case 'chart': return `<section class="panel full">${panelTitle('Race for the top', `<span class="hint">League position after each match${T.liveFixtures(s).some((f) => f.stage === 'league') ? ' · <span class="now-key">- - Now</span> = as it stands' : ''} · top ${s.config.qualifiers} highlighted</span>`)}${positionChartHTML(s)}</section>`;
    case 'grid': return `<section class="panel full">${panelTitle('Head to head', '<span class="hint">Read across: the row team’s score first</span>')}${gridHTML(s, ch.rows, strip ? STRIP_H : 0)}</section>`;
    case 'stats': return statsView(s, strip);
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

/**
 * Live scores along the bottom of the non-live screens: only the matches in
 * progress (one centred slot when just one board is playing; nothing when none).
 */
function liveStripHTML(s, matches = T.liveFixtures(s)) {
  const list = [...matches].sort((a, b) => (a.board ?? 0) - (b.board ?? 0));
  if (!list.length) return '';
  const slot = (f) => {
    const name = esc(s.config.boardNames[(f.board ?? 1) - 1]);
    const lead = f.homeLegs === f.awayLegs ? '' : f.homeLegs > f.awayLegs ? 'home' : 'away';
    const stake = I.matchStakes(s, f).lines[0];
    return `<div class="ls-slot"><span class="ls-board">${name}<i>● LIVE</i></span>
      <div class="ls-main">
        <span class="ls-team h ${lead === 'home' ? 'lead' : ''}">${esc(slotName(s, f, 'home'))}</span>
        <span class="ls-score num"><b data-legs="${f.id}-home">${f.homeLegs}</b>–<b data-legs="${f.id}-away">${f.awayLegs}</b></span>
        <span class="ls-team a ${lead === 'away' ? 'lead' : ''}">${esc(slotName(s, f, 'away'))}</span>
      </div>
      <span class="ls-sub">${esc(stake ?? stageName(f))}</span></div>`;
  };
  return `<section class="live-strip n${list.length}">${list.map(slot).join('')}</section>`;
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
  // Form and average count knockout matches too; P/W/L/+/-/Pts stay league (they decide the seeding).
  const overall = league ? null : I.overallRecords(s);
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
        <td class="num">${r.legDiff > 0 ? '+' : ''}${r.legDiff}</td><td class="num avg">${fmtAvg(overall ? overall.get(r.teamId)?.avg : r.avg) || '–'}</td>
        <td class="pts num">${r.points}</td>
        <td class="form">${formHTML(overall ? { ...r, form: overall.get(r.teamId)?.form ?? r.form } : r)}</td>
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
  // While league matches are being played, the line ends on a "Now" point: the
  // live table as it stands (provisional), joined by a dashed segment.
  const liveRows = T.liveStandings(s);
  const playing = new Set(liveRows.filter((r) => r.live).map((r) => r.teamId));
  const hasNow = s.phase === 'league' && playing.size > 0;
  const now = new Map(liveRows.map((r) => [r.teamId, r.position]));
  const pts = hasNow ? [...steps, now] : steps;
  if (pts.length < 2) return '<p class="empty">The chart appears after a couple of results.</p>';
  const n = s.teams.length;
  const q = s.config.qualifiers;
  const VW = 1760;
  const VH = 800;
  const L = 70;
  const R = 400;
  const TOP = 24;
  const B = 64;
  const pw = VW - L - R;
  const ph = VH - TOP - B;
  // The "Now" point gets its own space after the last result, so live moves stand out.
  const span = hasNow ? pw - 90 : pw;
  const x = (i) => (i >= steps.length ? L + pw : L + (steps.length === 1 ? 0 : (i / (steps.length - 1)) * span));
  const y = (p) => TOP + (n === 1 ? 0 : ((p - 1) / (n - 1)) * ph);
  const last = pts[pts.length - 1];
  const order = [...last].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  // Colours follow the team, not the rank: fixed by the last finished results, so a
  // live swing doesn't repaint lines. A team climbing into the top 4 live takes the
  // colour of the team it pushed out.
  const settled = steps.length ? [...steps[steps.length - 1]].sort((a, b) => a[1] - b[1]).map(([id]) => id) : order;
  const base = new Map(settled.slice(0, q).map((id, i) => [id, CHART_COLORS[i]]));
  const top = order.slice(0, q);
  const spare = [...base].filter(([id]) => !top.includes(id)).map(([, c]) => c);
  const color = new Map(top.map((id) => [id, base.get(id) ?? spare.shift()]));
  const path = (id) => steps.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(m.get(id)).toFixed(1)}`).join('');
  const nowSeg = (id) => (hasNow && steps.length
    ? `M${x(steps.length - 1).toFixed(1)},${y(steps[steps.length - 1].get(id)).toFixed(1)}L${x(pts.length - 1).toFixed(1)},${y(now.get(id)).toFixed(1)}`
    : '');
  const grid = Array.from({ length: n }, (_, i) => `<line class="grid" x1="${L}" x2="${L + pw}" y1="${y(i + 1)}" y2="${y(i + 1)}"/>
    <text class="axis" x="${L - 18}" y="${y(i + 1)}" text-anchor="end" dominant-baseline="central">${i + 1}</text>`).join('');
  const cutY = n > q ? (y(q) + y(q + 1)) / 2 : null;
  const every = Math.max(1, Math.ceil(steps.length / 12));
  const ticks = steps.map((_, i) => i).filter((i) => (i + 1) % every === 0 || i === 0)
    .filter((i) => !hasNow || x(pts.length - 1) - x(i) > 50) // keep clear of the "Now" label
    .map((i) => `<text class="axis" x="${x(i)}" y="${TOP + ph + 36}" text-anchor="middle">${i + 1}</text>`).join('')
    + (hasNow ? `<text class="axis now" x="${x(pts.length - 1)}" y="${TOP + ph + 36}" text-anchor="middle">Now</text>` : '');
  const nowLine = hasNow ? `<line class="now-line" x1="${x(pts.length - 1)}" x2="${x(pts.length - 1)}" y1="${TOP - 10}" y2="${TOP + ph + 10}"/>` : '';
  const grey = order.slice(q).map((id) => `<path class="ln dim" d="${path(id)}"/>${hasNow ? `<path class="ln dim now-seg" d="${nowSeg(id)}"/>` : ''}`).join('');
  const lit = order.slice(0, q).reverse().map((id) => `<path class="ln" d="${path(id)}" stroke="${color.get(id)}"/>
    ${hasNow ? `<path class="ln now-seg" d="${nowSeg(id)}" stroke="${color.get(id)}"/>` : ''}
    <circle cx="${x(pts.length - 1)}" cy="${y(last.get(id))}" r="8" fill="${color.get(id)}" class="end ${playing.has(id) ? 'live' : ''}"/>`).join('');
  const labels = order.map((id) => {
    const p = last.get(id);
    const c = color.get(id);
    return `<text class="lbl ${c ? '' : 'dim'}" x="${L + pw + 24}" y="${y(p)}" dominant-baseline="central">${p}. ${esc(T.teamName(s, id))}${playing.has(id) ? '<tspan class="live-mark" dx="10">●</tspan>' : ''}</text>`;
  }).join('');
  return `<svg class="pos-chart" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="League position of each team after each of ${fixtures.length} matches${hasNow ? ', and now with matches in progress' : ''}">
    ${grid}
    ${cutY ? `<line class="cut" x1="${L}" x2="${L + pw}" y1="${cutY}" y2="${cutY}"/>` : ''}
    ${nowLine}
    ${ticks}<text class="axis title" x="${L + pw / 2}" y="${VH - 4}" text-anchor="middle">League matches played</text>
    ${grey}${lit}${labels}
  </svg>`;
}

// ---------- head-to-head grid

function gridHTML(s, rows, less = 0) {
  const h2h = I.headToHead(s);
  const ids = rows.map((r) => r.teamId);
  const n = ids.length;
  const rowH = Math.min(90, Math.floor((750 - less - (n + 2) * 4) / (n + 0.7))); // rows + header + spacing fit the panel
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

function statsView(s, strip = false) {
  const few = strip ? 2 : 3; // the live strip takes the room of one entry per list
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
    <ol class="facts">${a.bestMatch.slice(0, few).map((x) => `<li><b class="num">${fmtAvg(x.avg)}</b><span>${name(x.teamId)} <em>v ${vsOf(x.fixture, x.teamId)} · ${esc(stageName(x.fixture, { short: true }))}</em></span></li>`).join('')}</ol>
    ${a.improved.length ? `<h3>On the up</h3><ol class="facts">${a.improved.slice(0, few).map((x) => `<li><b class="num up">+${x.change.toFixed(1)}</b><span>${name(x.teamId)} <em>last 3: ${fmtAvg(x.recent)} · before: ${fmtAvg(x.earlier)}</em></span></li>`).join('')}</ol>` : ''}`;
  const up = r.upset;
  const recPanel = `
    <ol class="facts big">
      <li><b class="num">${r.longest.length || '–'}</b><span>Longest winning run<em>${r.longest.teamIds.map(name).join(', ') || 'No results yet'}</em></span></li>
      <li><b class="num">${r.hot[0]?.length ?? '–'}</b><span>On fire now 🔥<em>${r.hot.length ? r.hot.map((h) => `${name(h.teamId)} (${h.length})`).join(', ') : 'Nobody on 3+ wins in a row'}</em></span></li>
      <li><b class="num">${r.whitewashes[0]?.count ?? '–'}</b><span>Most whitewashes<em>${r.whitewashes.length ? r.whitewashes.filter((w) => w.count === r.whitewashes[0].count).map((w) => name(w.teamId)).join(', ') + ' · wins without dropping a leg' : 'Wins without dropping a leg'}</em></span></li>
      <li><b class="num">${up ? `↑${up.gap}` : '–'}</b><span>Biggest upset${up ? ` · ${up.gap} place${up.gap === 1 ? '' : 's'} apart` : ''}<em>${up ? `${name(up.winnerId)} (${I.ordinal(up.winnerPos)}) beat ${name(up.loserId)} (${I.ordinal(up.loserPos)}) ${Math.max(up.fixture.homeLegs, up.fixture.awayLegs)}–${Math.min(up.fixture.homeLegs, up.fixture.awayLegs)}${up.fixture.stage !== 'league' ? ` · ${esc(stageName(up.fixture))}` : ''}` : 'None yet'}</em></span></li>
    </ol>`;
  return `<section class="stats-grid">
    <div class="panel">${panelTitle('3-dart averages')}${avgPanel}</div>
    <div class="panel">${panelTitle('Streaks & records')}${recPanel}</div>
  </section>`;
}

// ---------- team spotlight

let spotlightIndex = 0;
if (PINNED === 'team') setInterval(() => { spotlightIndex++; render({ transition: true }); }, 15000);

/** Teams to feature: everyone in table order; from the knockout on, the four still in. */
function spotlightTeams(s) {
  const fin = finalFixture(s);
  if (fin) return [fin.homeId, fin.awayId];
  if (s.phase !== 'league' && s.seeds?.length) return s.seeds.filter((id) => T.teamById(s, id));
  return T.liveStandings(s).map((r) => r.teamId);
}

function sparklineHTML(values) {
  if (values.length < 2) return '<p class="empty small">The line appears after two matches with an average recorded.</p>';
  const VW = 860;
  const VH = 230;
  const P = { l: 20, r: 150, t: 44, b: 30 };
  const lo = Math.floor(Math.min(...values) - 3);
  const hi = Math.ceil(Math.max(...values) + 3);
  const x = (i) => P.l + (i / (values.length - 1)) * (VW - P.l - P.r);
  const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (VH - P.t - P.b);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1];
  return `<svg class="spark" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="3-dart average in each match: ${values.map(fmtAvg).join(', ')}">
    <line class="mean" x1="${P.l}" x2="${VW - P.r}" y1="${y(avg)}" y2="${y(avg)}"/>
    <text class="mean-lbl" x="${VW - P.r + 10}" y="${y(avg)}" dominant-baseline="central">avg ${fmtAvg(avg)}</text>
    <polyline points="${pts}"/>
    ${values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="${i === values.length - 1 ? 9 : 6}"/>`).join('')}
    <text class="last" x="${x(values.length - 1) - 14}" y="${y(last) - 16}" text-anchor="end">${fmtAvg(last)}</text>
  </svg>`;
}

function spotlightHTML(s, strip) {
  const ids = spotlightTeams(s);
  if (!ids.length) return '<section class="panel full"><p class="empty">No teams yet.</p></section>';
  const k = spotlightIndex % ids.length;
  const id = ids[k];
  const sp = I.teamSpotlight(s, id);
  const r = sp.row;
  // Played, won–lost, leg diff, average and form count every stage; while a league
  // match is on, the league row's provisional figures are used (as the table does).
  const o = s.phase === 'league' ? (r ?? {}) : (sp.overall ?? r ?? {});
  const name = (x) => esc(T.teamName(s, x));
  const players = playersText(s, id);
  const seed = (s.seeds ?? []).indexOf(id) + 1;
  const tile = (label, value) => `<div class="tile"><b class="num">${value}</b><span>${label}</span></div>`;
  let now = '';
  if (sp.live) {
    const home = sp.live.homeId === id;
    now = `<div class="spot-now live"><span class="pill live">● LIVE · ${esc(s.config.boardNames[sp.live.board - 1])}</span>
      v <strong>${name(home ? sp.live.awayId : sp.live.homeId)}</strong>
      <b class="num">${home ? sp.live.homeLegs : sp.live.awayLegs}–${home ? sp.live.awayLegs : sp.live.homeLegs}</b></div>`;
  } else if (sp.next) {
    now = `<div class="spot-now"><span class="pill">Next</span> v <strong>${name(sp.next.homeId === id ? sp.next.awayId : sp.next.homeId)}</strong> <em>${esc(stageName(sp.next))}</em></div>`;
  } else {
    now = `<div class="spot-now"><em>${s.phase === 'league' ? 'All league matches played' : 'No more matches'}</em></div>`;
  }
  const max = strip ? 5 : 7;
  const results = [...sp.results].reverse().slice(0, max);
  return `<section class="spot">
    <div class="panel spot-main">
      ${panelTitle('Team spotlight', `<span class="hint">${k + 1} of ${ids.length}</span>`)}
      <div class="spot-id">
        <div class="spot-pos"><b>${r ? I.ordinal(r.position) : '–'}</b><span>${s.phase === 'league' ? 'in the table' : seed ? `seed ${seed}` : 'in the league'}</span></div>
        <div class="spot-who"><h2>${name(id)}</h2>${players ? `<p>${esc(players)}</p>` : ''}</div>
      </div>
      ${r ? `<div class="spot-tiles">${tile('Played', o.played)}${tile('Won – lost', `${o.won}–${o.lost}`)}${tile(s.phase === 'league' ? 'Points' : 'League pts', r.points)}${tile('Leg diff', o.legDiff > 0 ? `+${o.legDiff}` : o.legDiff)}${tile('Average', fmtAvg(o.avg) || '–')}</div>` : ''}
      <div class="spot-form"><span>Form</span>${(o.form ?? []).map((x) => `<i class="${x}">${x}</i>`).join('') || '<em>No results yet</em>'}</div>
      ${now}
    </div>
    <div class="panel spot-side">
      ${panelTitle('3-dart average, match by match')}
      ${sparklineHTML(sp.averages)}
      ${panelTitle('Results')}
      ${results.length ? `<ol class="spot-res">${results.map((x) => `<li><i class="${x.won ? 'W' : 'L'}">${x.won ? 'W' : 'L'}</i><b class="num">${x.forLegs}–${x.againstLegs}</b><span>v ${name(x.opponentId)}</span><em>${esc(stageName(x.f, { short: true }))}${typeof x.avg === 'number' ? ` · ${fmtAvg(x.avg)}` : ''}</em></li>`).join('')}</ol>` : '<p class="empty small">No results yet.</p>'}
    </div>
  </section>`;
}

// ---------- knockout: tale of the tape

/** Knockout matches still to play with both teams known: the semis first, then what follows. */
function pendingKnockout(s) {
  const ko = s.fixtures.filter((f) => f.stage !== 'league' && f.status !== 'done' && f.homeId && f.awayId).sort((a, b) => a.order - b.order);
  const semis = ko.filter((f) => f.stage === 'semi');
  return semis.length ? semis : ko;
}

function tapeView(s) {
  const list = pendingKnockout(s);
  if (!list.length) return `<section class="panel full">${panelTitle('Knockout')}<p class="empty">Waiting for the next knockout match.</p></section>`;
  return `<section class="tape-grid n${list.length}">${list.map((f) => tapeCard(s, f)).join('')}</section>`;
}

function tapeCard(s, f) {
  const t = I.taleOfTheTape(s, f);
  const status = f.status === 'live'
    ? `<span class="pill live">● LIVE · ${esc(s.config.boardNames[f.board - 1])}</span>`
    : `<span class="pill">Up next</span>`;
  const side = (which) => {
    const id = which === 'home' ? f.homeId : f.awayId;
    const seed = t.seeds[which];
    return `<div class="tp-team ${which}">
      ${seed ? `<span class="tp-seed">Seed ${seed}</span>` : ''}
      <div class="tp-name">${esc(T.teamName(s, id))}</div>
      <div class="tp-players">${esc(playersText(s, id))}</div>
      <div class="tp-form">${t.form[which].map((x) => `<i class="${x}">${x}</i>`).join('')}</div>
    </div>`;
  };
  const score = f.status === 'live'
    ? `<div class="tp-score num"><span data-legs="${f.id}-home">${f.homeLegs}</span>–<span data-legs="${f.id}-away">${f.awayLegs}</span></div>`
    : '<div class="tp-vs">v</div>';
  const meet = t.meetings.length
    ? `<div class="tp-meet"><span>Tonight</span><strong>${t.meetingsWon.home}–${t.meetingsWon.away}</strong>
        ${t.meetings.map((m) => {
          const mine = m.homeId === f.homeId ? m.homeLegs : m.awayLegs;
          const theirs = m.homeId === f.homeId ? m.awayLegs : m.homeLegs;
          return `<i class="${mine > theirs ? 'W' : 'L'}">${mine}–${theirs}</i>`;
        }).join('')}<em>(left team's score first)</em></div>`
    : '<div class="tp-meet"><em>First meeting tonight</em></div>';
  return `<article class="panel tape">
    <div class="tp-head"><h2>${esc(stageName(f))}</h2>${status}</div>
    <div class="tp-top">${side('home')}${score}${side('away')}</div>
    <div class="tp-rows">${t.rows.map((row) => `<div class="tp-row">
      <span class="v ${row.better === 'home' ? 'best' : ''}">${esc(row.home)}</span><span class="lbl">${esc(row.label)}</span><span class="v ${row.better === 'away' ? 'best' : ''}">${esc(row.away)}</span>
    </div>`).join('')}</div>
    ${meet}
  </article>`;
}

// ---------- the final: spotlight with head-to-head and the live score

/** The final once both finalists are known, until it is finished. */
function finalFixture(s) {
  if (s?.phase !== 'knockout') return null;
  const f = s.fixtures.find((x) => x.stage === 'final');
  return f?.homeId && f?.awayId && f.status !== 'done' ? f : null;
}

/** One line for the big moment: deciding leg, a leg from the title, or what's at stake. */
function finalMoment(s, f) {
  if (f.status !== 'live') return 'Winner takes the title';
  const need = legsToWinFor(s.config, 'final');
  const h = f.homeLegs === need - 1;
  const a = f.awayLegs === need - 1;
  if (need === 1) return 'One leg for the title';
  if (h && a) return 'Deciding leg for the title';
  if (h || a) return `${T.teamName(s, h ? f.homeId : f.awayId)} a leg from the title`;
  return `First to ${need} takes the title`;
}

function finalView(s, strip = false) {
  const f = finalFixture(s);
  if (!f) return `<section class="panel full">${panelTitle('The Final')}<p class="empty">The final appears here once both finalists are known.</p></section>`;
  const t = I.taleOfTheTape(s, f);
  const live = f.status === 'live';
  const need = legsToWinFor(s.config, 'final');
  const name = (id) => esc(T.teamName(s, id));
  const otherLive = T.liveFixtures(s).find((x) => x.id !== f.id);
  const status = live
    ? `<span class="pill live">● LIVE · ${esc(s.config.boardNames[f.board - 1])}</span>`
    : `<span class="pill">Up next${otherLive ? ` · after the ${esc(stageName(otherLive).toLowerCase())}` : ''}</span>`;
  const side = (which) => {
    const id = which === 'home' ? f.homeId : f.awayId;
    const legs = which === 'home' ? f.homeLegs : f.awayLegs;
    const other = which === 'home' ? f.awayLegs : f.homeLegs;
    const seed = t.seeds[which];
    const route = t.route[which].map((r) => `<span class="fs-route-item">${r.won ? 'Beat' : 'Lost to'} <strong>${name(r.opponentId)}</strong> <b class="num">${r.forLegs}–${r.againstLegs}</b> <em>${esc(stageName(r.f, { short: true }))}</em></span>`).join('');
    return `<div class="fs-team ${which} ${live && legs > other ? 'leading' : ''}">
      ${seed ? `<span class="tp-seed">Seed ${seed}</span>` : ''}
      <div class="fs-name">${name(id)}</div>
      ${playersText(s, id) ? `<div class="fs-players">${esc(playersText(s, id))}</div>` : ''}
      ${route ? `<div class="fs-route">${route}</div>` : ''}
      <div class="tp-form fs-form">${t.form[which].map((x) => `<i class="${x}">${x}</i>`).join('')}</div>
    </div>`;
  };
  const pips = (legs) => `<span class="fs-pips">${Array.from({ length: need }, (_, i) => `<i class="${i < legs ? 'on' : ''}"></i>`).join('')}</span>`;
  const centre = live
    ? `<div class="fs-score num"><span data-legs="${f.id}-home">${f.homeLegs}</span><b>–</b><span data-legs="${f.id}-away">${f.awayLegs}</span></div>
       <div class="fs-pip-row">${pips(f.homeLegs)}<em>legs</em>${pips(f.awayLegs)}</div>`
    : '<div class="fs-vs">v</div>';
  // This match's 3-dart averages go first while they are being entered.
  const rows = [...t.rows];
  if (live && (f.homeAvg != null || f.awayAvg != null)) {
    const ha = f.homeAvg ?? null;
    const aa = f.awayAvg ?? null;
    const better = ha == null || aa == null || ha === aa ? null : ha > aa ? 'home' : 'away';
    const share = ha != null && aa != null && ha + aa > 0 ? ha / (ha + aa) : null;
    rows.unshift({ label: 'Average in the final', home: fmtAvg(ha) || '–', away: fmtAvg(aa) || '–', better, share, now: true });
  }
  const bar = (r) => (r.share == null ? '' : `<div class="fs-bar"><i class="h ${r.better === 'home' ? 'best' : ''}" style="width:${(r.share * 100).toFixed(1)}%"></i><i class="a ${r.better === 'away' ? 'best' : ''}" style="width:${((1 - r.share) * 100).toFixed(1)}%"></i></div>`);
  const compare = rows.map((r) => `<div class="fs-row ${r.now ? 'now' : ''}">
      <span class="v h ${r.better === 'home' ? 'best' : ''}">${esc(r.home)}</span>
      <div class="fs-mid"><span class="lbl">${r.now ? '<i class="dot">●</i> ' : ''}${esc(r.label)}</span>${bar(r)}</div>
      <span class="v a ${r.better === 'away' ? 'best' : ''}">${esc(r.away)}</span>
    </div>`).join('');
  const meetings = t.meetings.length
    ? `<span class="fs-foot-lbl">Tonight</span><strong class="num">${t.meetingsWon.home}–${t.meetingsWon.away}</strong>
       <span class="fs-chips">${t.meetings.map((m) => {
         const mine = m.homeId === f.homeId ? m.homeLegs : m.awayLegs;
         const theirs = m.homeId === f.homeId ? m.awayLegs : m.homeLegs;
         return `<i class="${mine > theirs ? 'W' : 'L'}">${mine}–${theirs}</i>`;
       }).join('')}</span><em>${name(f.homeId)}’s score first</em>`
    : '<span class="fs-foot-lbl">Tonight</span><em>First meeting of the night</em>';
  const edge = t.edge.home === t.edge.away
    ? `Level on the stats <strong class="num">${t.edge.home}–${t.edge.away}</strong>`
    : `${name(t.edge.home > t.edge.away ? f.homeId : f.awayId)} edge the stats <strong class="num">${Math.max(t.edge.home, t.edge.away)}–${Math.min(t.edge.home, t.edge.away)}</strong>`;
  return `<section class="final-spot ${live ? 'is-live' : ''} ${strip ? 'with-strip' : ''}">
    <div class="fs-head">
      <span class="fs-trophy" aria-hidden="true">🏆</span>
      <h2>The Final</h2>
      <span class="fs-format">${esc(formatLine(s, f))}</span>
      ${status}
    </div>
    <div class="fs-top">
      ${side('home')}
      <div class="fs-centre">${centre}<div class="fs-moment ${live ? 'live' : ''}">${esc(finalMoment(s, f))}</div></div>
      ${side('away')}
    </div>
    <div class="panel fs-compare">
      <div class="fs-compare-head"><span>${name(f.homeId)}</span><h3>Head to head</h3><span>${name(f.awayId)}</span></div>
      <div class="fs-rows">${compare}</div>
      <div class="fs-foot"><div class="fs-meet">${meetings}</div><div class="fs-edge">${edge}</div></div>
    </div>
  </section>`;
}

// ---------- result banner and "to the oche" call-up (an overlay above every screen)

const overlay = (() => {
  const el = document.getElementById('overlay');
  const queue = [];
  let busy = false;
  const RESULT_MS = 6500;
  const CALL_MS = 7500;
  const DRAW_MS = 13000;

  function resultHTML(s, f) {
    const r = I.resultSummary(s, f);
    return `<div class="ov-card result">
      <div class="ov-kicker">Result · ${esc(stageName(f))}</div>
      <div class="ov-big"><span class="w">${esc(T.teamName(s, r.winnerId))}</span></div>
      <div class="ov-mid">beat <strong>${esc(T.teamName(s, r.loserId))}</strong> <b class="num">${esc(r.score)}</b></div>
      ${r.detail ? `<div class="ov-detail">${esc(r.detail)}</div>` : ''}
    </div>`;
  }

  function callHTML(s, board) {
    if (T.liveOnBoard(s, board)) return ''; // already started
    const next = T.nextUp(s);
    const f = next[board] ?? next.waiting?.[board];
    if (!f) return '';
    const waiting = !next[board];
    const who = (side) => {
      const id = side === 'home' ? f.homeId : f.awayId;
      const p = playersText(s, id);
      return `<div class="ov-team"><strong>${esc(slotName(s, f, side))}</strong>${p ? `<span>${esc(p)}</span>` : ''}</div>`;
    };
    return `<div class="ov-card call">
      <div class="ov-kicker">To the oche · ${esc(s.config.boardNames[board - 1])}</div>
      <div class="ov-teams">${who('home')}<em>v</em>${who('away')}</div>
      <div class="ov-detail">${esc(stageName(f))}${waiting ? ' · after the other board finishes' : ''}</div>
    </div>`;
  }

  /** The semi-final draw: each pairing comes in turn (CSS delays), then the final. */
  function drawHTML(s) {
    const semis = ['SF1', 'SF2'].map((id) => T.fixtureById(s, id)).filter((f) => f?.homeId && f?.awayId);
    if (semis.length < 2) return '';
    const seed = (id) => (s.seeds ?? []).indexOf(id) + 1;
    const team = (id, side) => `<div class="dr-team ${side}">
      <span class="tp-seed">Seed ${seed(id)}</span>
      <strong>${esc(T.teamName(s, id))}</strong>
      ${playersText(s, id) ? `<span class="dr-players">${esc(playersText(s, id))}</span>` : ''}
    </div>`;
    const extra = s.config.thirdPlace ? ' · losers play for 3rd place' : '';
    return `<div class="ov-card draw">
      <div class="ov-kicker">The knockout draw</div>
      <div class="dr-title">Semi-finals</div>
      ${semis.map((f, i) => `<div class="dr-match" style="--d:${1.4 + i * 2.6}s">
        <span class="dr-label">${esc(stageName(f))} · ${esc(legsFormat(s.config.bestOf.semi))}</span>
        <div class="dr-pair">${team(f.homeId, 'h')}<em>v</em>${team(f.awayId, 'a')}</div>
      </div>`).join('')}
      <div class="ov-detail dr-final" style="--d:7s">Winners meet in the final · ${esc(legsFormat(s.config.bestOf.final))}${esc(extra)}</div>
    </div>`;
  }

  function next() {
    if (busy) return;
    const item = queue.shift();
    const s = store.get();
    if (!item || !s) {
      el.className = '';
      return;
    }
    let html = '';
    if (item.kind === 'result') {
      const f = T.fixtureById(s, item.id);
      // The final hands over to the champion screen instead.
      if (f && f.status === 'done' && f.stage !== 'final') html = resultHTML(s, f);
      if (item.board) queue.unshift({ kind: 'call', board: item.board });
    } else if (item.kind === 'draw') {
      html = s.phase === 'knockout' ? drawHTML(s) : '';
    } else {
      html = callHTML(s, item.board);
    }
    if (!html) return next();
    busy = true;
    el.innerHTML = html;
    el.className = 'show';
    setTimeout(() => {
      busy = false;
      if (!queue.length) el.className = '';
      setTimeout(next, queue.length ? 0 : 400);
    }, item.kind === 'result' ? RESULT_MS : item.kind === 'draw' ? DRAW_MS : CALL_MS);
  }

  return {
    result(id, board) {
      queue.push({ kind: 'result', id, board });
      next();
    },
    draw() {
      queue.push({ kind: 'draw' });
      next();
    },
  };
})();

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
  const eta = $('#eta');
  const s = store.get();
  if (eta && s) eta.innerHTML = etaText(s);
}

/** "Est. finish ~10:45 PM · 1h 40m to go" (rounded up to 5 minutes), or nothing. */
function etaText(s) {
  const e = I.finishEstimate(s);
  if (!e) return '';
  const mins = Math.ceil(e.ms / 300000) * 5;
  const left = mins <= 5 ? 'nearly done' : mins < 60 ? `${mins}m to go` : `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ''} to go`;
  const at = new Date(Math.ceil(e.finishAt / 300000) * 300000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Est. finish <b>~${esc(at)}</b> · ${esc(left)}`;
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
  for (const x of changes.finished) overlay.result(x.id, x.board);
  if (changes.knockoutStarted) overlay.draw();
});

if (store.get()) render({ changes: trackChanges(store.get()) });
else render();
scheduleRotation();
registerServiceWorker();
