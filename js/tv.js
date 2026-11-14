// TV dashboard. Read-only: follows the admin window through the store.
// Designed on a fixed 1920×1080 stage that is scaled to fit (letterboxed).
import { createStore, createLocalStorageAdapter } from './store.js';
import * as T from './logic/tournament.js';
import { bracketView, winnerOf, knockoutSeeding } from './logic/bracket.js';
import { legsToWinFor } from './logic/config.js';
import { esc, stageName, slotName, playersText, teamBlock, slotBlock, fmtAvg, formatLine, legsFormat, applyTheme, registerServiceWorker } from './view.js';

const W = 1920;
const H = 1080;
const params = new URLSearchParams(location.search);
const PREVIEW = params.has('preview');
const PINNED = ['table', 'fixtures', 'bracket'].includes(params.get('view')) ? params.get('view') : null;
const ROTATE = Math.max(0, Number(params.get('rotate')) || 0);
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
  if (s.phase === 'league') return ['auto', 'table', 'fixtures'];
  if (s.phase === 'knockout') return ['auto', 'table', 'fixtures'];
  return ['auto', 'bracket', 'table'];
}
function currentView(s) {
  if (PINNED) return PINNED;
  if (!ROTATE) return 'auto';
  const v = viewsFor(s);
  return v[rotateIndex % v.length];
}
if (ROTATE && !PINNED) {
  setInterval(() => {
    rotateIndex++;
    render({ transition: true });
  }, ROTATE * 1000);
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

  const rows = T.standings(s);
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
  const ch = changes ?? { bumps: new Set(), rows: T.standings(s), fresh: [], phaseChanged: false };
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
      <p class="rules">${s.config.doubleRoundRobin ? 'Everyone plays everyone twice' : 'Everyone plays everyone once'} · ${legsFormat(s.config.bestOf.league)} · top 4 to the semi-finals</p>
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
  return `<section class="live-row ${compact ? 'compact' : ''} ${stacked ? 'stacked' : ''}">${[1, 2].map((b) => liveCard(s, b, next[b], ch)).join('')}</section>`;
}

function liveCard(s, board, suggested, ch) {
  const name = esc(s.config.boardNames[board - 1]);
  const f = T.liveOnBoard(s, board);
  if (!f) {
    return `<article class="live-card idle">
      <div class="lc-head"><span class="board-name">${name}</span><span class="pill">${suggested ? 'Next up' : 'Free'}</span></div>
      ${suggested
        ? `<div class="lc-next">${slotBlock(s, suggested, 'home', { cls: 'h end' })}<em>v</em>${slotBlock(s, suggested, 'away', { cls: 'a' })}</div>
           <div class="lc-meta">${esc(stageName(suggested))} · get ready!</div>`
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
    <div class="lc-meta">${esc(formatLine(s, f))}</div>
  </article>`;
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
  const live = new Set(T.liveFixtures(s).flatMap((f) => [f.homeId, f.awayId]));
  const avail = availOverride ?? (full ? 790 : 460);
  const rowH = Math.max(28, Math.min(full ? 72 : 60, Math.floor(avail / Math.max(rows.length, 1))));
  const now = Date.now();
  const showForm = full;
  const showAvg = rows.some((r) => r.avg !== null);
  return `<table class="tv-table ${showAvg ? 'with-avg' : ''}" style="--row-h:${rowH}px">
    <thead><tr><th class="pos">#</th><th class="team">Team</th><th>P</th><th>W</th><th>L</th><th>+/-</th>${showAvg ? '<th class="avg-h">Avg</th>' : ''}<th class="pts">Pts</th>${showForm ? '<th class="form-h">Form</th>' : ''}</tr></thead>
    <tbody>${rows.map((r, i) => {
      const mv = movement.get(r.teamId);
      const arrow = mv && mv.until > now ? `<span class="mv ${mv.dir}">${mv.dir === 'up' ? '▲' : '▼'}</span>` : '';
      return `<tr data-team-row="${r.teamId}" class="${i < q ? 'q' : ''} ${i === q - 1 && rows.length > q ? 'cut' : ''}">
        <td class="pos num">${r.position}</td>
        <td class="team">${teamBlock(s, r.teamId, { inline: rows.length > 10, cls: 'nm' })}${live.has(r.teamId) ? '<span class="live-dot"></span>' : ''}${arrow}</td>
        <td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.lost}</td>
        <td class="num">${r.legDiff > 0 ? '+' : ''}${r.legDiff}</td>${showAvg ? `<td class="num avg">${fmtAvg(r.avg) || '–'}</td>` : ''}
        <td class="pts num">${r.points}</td>
        ${showForm ? `<td class="form">${r.form.map((x) => `<i class="${x}">${x}</i>`).join('')}</td>` : ''}
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function upNextHTML(s, n) {
  const q = T.upcoming(s).slice(0, n);
  if (!q.length) return `<p class="empty">${s.phase === 'knockout' ? 'Waiting for results…' : 'No more matches'}</p>`;
  const next = T.nextUp(s);
  const boardOf = new Map([[next[1]?.id, 1], [next[2]?.id, 2]]);
  return `<ol class="list">${q.map((f) => {
    const b = boardOf.get(f.id);
    return `<li><span class="tagc">${b ? esc(s.config.boardNames[b - 1]) : esc(stageName(f, { short: true }))}</span>
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
const beat = () => store.post({ type: 'tv-beat', at: Date.now(), preview: PREVIEW });
beat();
setInterval(() => { beat(); updateLink(); }, 2000);

// ---------------------------------------------------------------- go

store.subscribe((s) => {
  if (!s) return render();
  const changes = trackChanges(s);
  // A score change brings a rotating screen back to the live view.
  if (ROTATE && !PINNED && (changes.bumps.size || changes.fresh.length)) rotateIndex = 0;
  render({ changes });
});

if (store.get()) render({ changes: trackChanges(store.get()) });
else render();
registerServiceWorker();
