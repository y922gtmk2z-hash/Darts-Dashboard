// Browser tests: admin + TV together in a real Chromium.
// Run with `npm run test:e2e` (needs the `playwright` package and a Chromium;
// see README "For developers"). Skipped automatically if Playwright is missing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, extname, normalize } from 'node:path';
import * as T from '../../js/logic/tournament.js';
import { loadDemoTeams, simulateUntil } from '../../js/logic/simulate.js';
import { seededRandom } from '../../js/logic/util.js';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }
const skip = chromium ? false : 'playwright is not installed';

const ROOT = new URL('../..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const KEY = 'dartsDashboard.state.v1';
let server;
let base;
let altBase;
let browser;

before(async () => {
  if (skip) return;
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? `${path}index.html` : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  base = `http://localhost:${port}`;
  altBase = `http://127.0.0.1:${port}`; // a *different origin* for the same files
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

async function openPair({ state } = {}) {
  const ctx = await browser.newContext();
  const errors = [];
  if (state) {
    await ctx.addInitScript(([k, v]) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem(k, v);
        sessionStorage.setItem('seeded', '1');
      }
    }, [KEY, JSON.stringify(state)]);
  }
  const admin = await ctx.newPage();
  admin.on('pageerror', (e) => errors.push(`admin: ${e.message}`));
  await admin.setViewportSize({ width: 1280, height: 800 });
  await admin.goto(`${base}/admin.html`);
  const tv = await ctx.newPage();
  tv.on('pageerror', (e) => errors.push(`tv: ${e.message}`));
  await tv.setViewportSize({ width: 1920, height: 1080 });
  await tv.goto(`${base}/index.html`);
  return { ctx, admin, tv, errors };
}

/** Choose a team in a dropdown by name (options read "Name (Player & Player)"). */
async function pickTeam(page, selector, name) {
  await page.waitForSelector(`${selector} option:nth-child(2)`, { state: "attached" }); // the tab renders just after a dialog closes
  const value = await page.$eval(selector, (el, n) => [...el.options].find((o) => o.text === n || o.text.startsWith(`${n} (`))?.value, name);
  assert.ok(value, `${name} in ${selector}`);
  await page.selectOption(selector, value);
}

const leagueState = (teams = 8, played = 0, extra = {}) => {
  let s = loadDemoTeams(T.createTournament(extra), teams);
  s = T.startLeague(s);
  if (!played) return s;
  s = simulateUntil(s, (x) => T.leagueProgress(x).played >= played, seededRandom(teams));
  for (const f of T.liveFixtures(s)) s = T.cancelMatch(s, f.id); // leave both boards free
  return s;
};

test('admin → TV sync, TV connection indicator, refresh recovery', { skip }, async () => {
  const { ctx, admin, tv, errors } = await openPair();
  await admin.click('.tabs [data-tab="teams"]');
  await admin.click('text=Load demo teams');
  await tv.waitForSelector('.team-card');
  assert.equal(await tv.locator('.team-card').count(), 8);
  await admin.waitForSelector('.tv-status.ok', { timeout: 8000 });

  await admin.click('text=Generate fixtures & start league');
  await admin.click('dialog button:has-text("Start league")');
  await admin.click('text=Start on Board 1');
  await admin.keyboard.press('q');
  await tv.waitForFunction(() => document.querySelector('[data-legs$="-home"]')?.textContent === '1');

  await tv.reload();
  await tv.waitForSelector('.live-card:not(.idle)');
  await admin.reload();
  assert.match(await admin.textContent('.board.live'), /1/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('scoring keys work from any tab and confirm with a toast', { skip }, async () => {
  const s = T.startMatch(leagueState(), 'L1', 1);
  const { ctx, admin, errors } = await openPair({ state: s });
  await admin.click('.tabs [data-tab="table"]');
  await admin.keyboard.press('q');
  await admin.waitForSelector('.toast:has-text("1–0")');
  const stored = await admin.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  assert.equal(stored.fixtures.find((f) => f.id === 'L1').homeLegs, 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('no-op actions do not create undo steps; focus stays on the button', { skip }, async () => {
  const s = T.startMatch(leagueState(), 'L1', 1);
  const { ctx, admin } = await openPair({ state: s });
  const rev = () => admin.evaluate((k) => JSON.parse(localStorage.getItem(k)).rev, KEY);
  const before = await rev();
  await admin.keyboard.press('Shift+Q'); // −1 at 0 legs
  assert.equal(await rev(), before);
  const plus = '[data-action="leg"][data-side="away"][data-delta="1"]';
  await admin.focus(plus);
  await admin.keyboard.press('Enter');
  assert.equal(await admin.evaluate(() => document.activeElement.dataset.side), 'away');
  assert.equal(await rev(), before + 1);
  await ctx.close();
});

test('finishing from the keyboard: Enter confirms, result reaches the table', { skip }, async () => {
  const s = T.startMatch(leagueState(), 'L1', 1);
  const { ctx, admin, tv } = await openPair({ state: s });
  await admin.keyboard.press('a');
  await admin.keyboard.press('a');
  await admin.waitForSelector('dialog[open]');
  await admin.keyboard.press('Enter');
  await tv.waitForFunction(() => [...document.querySelectorAll('.tv-table .pts')].some((el) => el.textContent === '3'));
  await ctx.close();
});

test('3-dart averages: typed on the live board, confirmed when finishing, shown on TV and in the table', { skip }, async () => {
  const s = T.startMatch(leagueState(), 'L1', 1);
  const { ctx, admin, tv, errors } = await openPair({ state: s });
  assert.equal(await tv.locator('.tv-table .avg-h').count(), 1, 'Avg column shown before any average is recorded');
  await admin.fill('#avg-L1-home', '54,3');
  await admin.press('#avg-L1-home', 'Enter');
  await tv.waitForFunction(() => document.querySelector('[data-avg="L1-home"]')?.textContent === '54.30');
  await admin.fill('#avg-L1-away', 'abc');
  await admin.press('#avg-L1-away', 'Tab');
  await admin.waitForSelector('.toast.error');
  assert.equal(await admin.inputValue('#avg-L1-away'), '', 'invalid entry rolled back');
  // Win the match; the finish box offers both averages (home prefilled).
  await admin.click('.kbd-help'); // somewhere with no text box, so keys score
  await admin.keyboard.press('q');
  await admin.keyboard.press('q');
  await admin.waitForSelector('dialog[open] input[name="awayAvg"]');
  assert.equal(await admin.inputValue('dialog input[name="homeAvg"]'), '54.30');
  await admin.fill('dialog input[name="awayAvg"]', '47.5');
  await admin.press('dialog input[name="awayAvg"]', 'Enter');
  // The Avg column is always on the TV table; the team's average lands in it once the match is finished.
  assert.equal(await tv.locator('.tv-table .avg-h').count(), 1);
  await tv.waitForFunction(() => [...document.querySelectorAll('.tv-table td.avg')].some((td) => td.textContent === '54.30'));
  const stored = await admin.evaluate((k) => JSON.parse(localStorage.getItem(k)).fixtures.find((f) => f.id === 'L1'), KEY);
  assert.deepEqual([stored.status, stored.homeAvg, stored.awayAvg], ['done', 54.3, 47.5]);
  await admin.click('.tabs [data-tab="table"]');
  assert.match(await admin.textContent('table.standings'), /54\.30/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a TV left open from an older release refreshes itself (once) when the admin page is newer', { skip }, async () => {
  // No service worker here so route() sees every request.
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const tv = await ctx.newPage();
  let tvLoads = 0;
  tv.on('load', () => { tvLoads++; });
  await tv.goto(`${base}/index.html?preview=1`);
  // The admin page gets a "newer release" (the server still serves the old one to the TV).
  const admin = await ctx.newPage();
  await admin.route('**/js/version.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export const APP_VERSION = 999;' }));
  await admin.goto(`${base}/admin.html`);
  await tv.waitForEvent('load', { timeout: 8000 });
  // Still "old" after reloading: the guard must stop it reloading again and again.
  await admin.waitForTimeout(5000);
  assert.equal(tvLoads, 2, 'reloaded exactly once');
  // A TV running a *newer* release makes the admin page ask to be reloaded.
  const admin2 = await ctx.newPage();
  await tv.route('**/js/version.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'export const APP_VERSION = 1000;' }));
  await admin2.goto(`${base}/admin.html`);
  await tv.reload();
  await admin2.waitForSelector('text=This admin page is out of date', { timeout: 8000 });
  await ctx.close();
});

test('fixtures screen: each pair once on each board; set boards, per-board queue, balance', { skip }, async () => {
  const { ctx, admin, tv, errors } = await openPair({ state: leagueState(8) });
  await admin.click('.tabs [data-tab="fixtures"]');
  assert.match(await admin.textContent('.fixture-tools'), /Every pair plays once on Board 1 and once on Board 2/);
  // Board 1 view lists only Board 1 matches, numbered in that board's order.
  await admin.click('[data-action="fixture-board-view"][data-board-view="1"]');
  const boards = await admin.$$eval('table.fixtures tbody select.board-select', (els) => els.map((e) => e.value));
  assert.ok(boards.length === 28 && boards.every((v) => v === '1'));
  assert.equal(await admin.textContent('table.fixtures tbody tr:nth-child(1) td:first-child'), '1');
  // Move a match to Board 2: the check notices; balancing fixes it.
  const id = await admin.$eval('table.fixtures tbody tr:nth-child(2) select.board-select', (e) => e.dataset.id);
  await admin.selectOption(`#fb-${id}`, '2');
  await admin.waitForFunction(() => /Not once on each board/.test(document.querySelector('.fixture-tools').textContent));
  await admin.click('text=Balance boards automatically');
  await admin.click('dialog button:has-text("Balance boards")');
  await admin.waitForFunction(() => /Every pair plays once on Board 1 and once on Board 2/.test(document.querySelector('.fixture-tools').textContent));
  // Live scoring follows the plan; the TV labels up-next matches with their board.
  await admin.click('.tabs [data-tab="live"]');
  await admin.click('text=Start on Board 1');
  const started = await admin.evaluate((k) => JSON.parse(localStorage.getItem(k)).fixtures.find((f) => f.status === 'live'), KEY);
  assert.equal(started.plannedBoard, 1);
  await tv.waitForSelector('.tagc.b2');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('"2 on, 1 off" rule: planned in pairs, boards wait for the right teams', { skip }, async () => {
  const state = T.startLeague(loadDemoTeams(T.createTournament({ fixtureRule: 'pairs' }), 6));
  const { ctx, admin, tv, errors } = await openPair({ state });
  await admin.click('.tabs [data-tab="fixtures"]');
  assert.match(await admin.textContent('.fixture-tools'), /2 on, 1 off: every team plays its matches in pairs and never 3 in a row/);
  await admin.click('.tabs [data-tab="live"]');
  await admin.click('text=Start on Board 1');
  await admin.click('text=Start on Board 2');
  await admin.click('.kbd-help');
  await admin.keyboard.press('q');
  await admin.keyboard.press('q');
  await admin.waitForSelector('dialog[open]');
  await admin.keyboard.press('Enter');
  // Board 1's planned next match needs a team still on Board 2: it waits rather than jumping ahead.
  await admin.waitForSelector('.board .waiting-why');
  await tv.waitForFunction(() => /after the other board finishes/.test(document.querySelector('.live-card')?.textContent ?? ''));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('match day: Board 1 and Board 2 side by side; type a result and averages straight into the list', { skip }, async () => {
  const { ctx, admin, tv, errors } = await openPair({ state: leagueState(8) });
  await admin.click('.tabs [data-tab="matchday"]');
  // Row k holds the k-th match of each board.
  const firstRow = await admin.$$eval('.md-row:first-child .mcard', (els) => els.map((e) => e.id.slice(2)));
  const s0 = leagueState(8);
  assert.deepEqual(firstRow, [T.upcoming(s0).find((f) => f.plannedBoard === 1).id, T.upcoming(s0).find((f) => f.plannedBoard === 2).id]);
  // Type a result for a match that was never started.
  const id = firstRow[1];
  await admin.fill(`#d-${id}-homeLegs`, '1');
  await admin.fill(`#d-${id}-awayLegs`, '2');
  await admin.fill(`#d-${id}-homeAvg`, '44,4');
  await admin.fill(`#d-${id}-awayAvg`, '61');
  await admin.press(`#d-${id}-awayAvg`, 'Enter');
  await admin.waitForSelector(`#m-${id}.done`);
  const f = await admin.evaluate(([k, fid]) => JSON.parse(localStorage.getItem(k)).fixtures.find((x) => x.id === fid), [KEY, id]);
  assert.deepEqual([f.status, f.homeLegs, f.awayLegs, f.homeAvg, f.awayAvg], ['done', 1, 2, 44.4, 61]);
  await tv.waitForFunction(() => [...document.querySelectorAll('.tv-table td.avg')].some((td) => td.textContent === '61.00'));
  // An invalid typed score is refused and nothing is saved.
  const other = firstRow[0];
  await admin.fill(`#d-${other}-homeLegs`, '1');
  await admin.fill(`#d-${other}-awayLegs`, '1');
  await admin.click(`#m-${other} [data-action="md-save"]`);
  await admin.waitForSelector('.toast.error');
  assert.equal(await admin.locator(`#m-${other}.todo`).count(), 1);
  // Correct the saved result in place.
  await admin.click(`#m-${id} [data-action="md-edit"]`);
  await admin.selectOption(`#e-${id}-homeLegs`, '0');
  await admin.fill(`#e-${id}-awayAvg`, '62.5');
  await admin.click(`#m-${id} [data-action="md-edit-save"]`);
  await admin.waitForFunction((fid) => /62\.50/.test(document.getElementById(`m-${fid}`)?.textContent ?? ''), id);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('league table is live: points, W/L and +/- move with matches still being played; rows highlighted', { skip }, async () => {
  const s = T.startMatch(leagueState(8), 'L1', 1);
  const away = T.fixtureById(s, 'L1').awayId;
  const { ctx, admin, tv, errors } = await openPair({ state: s });
  await admin.click('.kbd-help');
  await admin.keyboard.press('a'); // leg to the away team on Board 1
  await tv.waitForFunction((id) => {
    const row = document.querySelector(`.tv-table tr[data-team-row="${id}"]`);
    if (!row || row !== document.querySelector('.tv-table tbody tr') || !row.classList.contains('playing')) return false;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
    return cells.includes('+1') && row.querySelector('td.pts').textContent === '3';
  }, away);
  // Both teams in the match are highlighted; nobody else is.
  assert.equal(await tv.locator('.tv-table tr.playing').count(), 2);
  // Form on the main TV view: the match in progress is a provisional pip (W for the leader).
  assert.equal(await tv.textContent(`.tv-table tr[data-team-row="${away}"] td.form i.now`), 'W');
  assert.equal(await tv.locator('.tv-table td.form i.now').count(), 2);
  await admin.click('.tabs [data-tab="table"]');
  const top = await admin.textContent('table.standings tbody tr:first-child');
  assert.match(top, /\+1/);
  assert.match(top, /LIVE · winning/);
  assert.equal(await admin.locator('table.standings tr.playing').count(), 2);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('TV insights: stakes line, next-up preview and the chart / head-to-head / stats screens', { skip }, async () => {
  const s = T.startMatch(leagueState(8, 20), T.nextUp(leagueState(8, 20))[1].id, 1);
  const { ctx, tv, errors } = await openPair({ state: s });
  await tv.waitForSelector('.live-card .lc-meta.stakes');
  assert.match(await tv.textContent('.live-card .lc-meta.stakes'), /At stake/);
  // The free board previews the next match with positions and form.
  await tv.waitForSelector('.live-card.idle .nx-stat');
  for (const [view, sel] of [['chart', 'svg.pos-chart path.ln'], ['grid', 'table.h2h td i'], ['stats', '.stats-grid .bars li']]) {
    await tv.goto(`${base}/index.html?view=${view}`);
    await tv.waitForSelector(sel);
    if (view === 'chart') assert.equal(await tv.locator('svg.pos-chart path.ln').count(), 8);
    if (view === 'grid') assert.equal(await tv.locator('table.h2h tbody tr').count(), 8);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the final waits for the 3rd place play-off', { skip }, async () => {
  let s = loadDemoTeams(T.createTournament({ thirdPlace: true }), 4);
  s = simulateUntil(s, (x) => x.phase === 'knockout' && ['SF1', 'SF2'].every((id) => T.fixtureById(x, id).status === 'done'), seededRandom(5));
  const { ctx, admin } = await openPair({ state: s });
  await admin.click('.tabs [data-tab="live"]');
  const boards = await admin.locator('.board').allTextContents();
  assert.ok(boards.some((t) => /3rd place/.test(t)));
  assert.ok(!boards.some((t) => /Final/.test(t) && /Start on/.test(t)), 'final not offered yet');
  // Same on the Match day list.
  await admin.click('.tabs [data-tab="matchday"]');
  assert.ok(await admin.locator('#m-3P [data-action="start"]').count() > 0, '3rd place can start');
  assert.equal(await admin.locator('#m-F [data-action="start"]').count(), 0, 'final not offered yet');
  await ctx.close();
});

test('importing an inconsistent backup is refused and nothing changes', { skip }, async () => {
  const { ctx, admin } = await openPair({ state: leagueState(4) });
  const bad = { state: { phase: 'league', teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], fixtures: [{ id: 'L1', stage: 'league', homeId: 'a', awayId: 'b', status: 'done', homeLegs: 5, awayLegs: 5 }] } };
  await admin.click('.tabs [data-tab="backup"]');
  await admin.setInputFiles('input[type=file]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) });
  await admin.waitForSelector('dialog[open] .problems');
  assert.match(await admin.textContent('dialog'), /no winner/);
  await admin.click('dialog button:has-text("OK")');
  const stored = await admin.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
  assert.equal(stored.teams.length, 4);
  await ctx.close();
});

test('manual fixtures: start empty, add, paste, edit position', { skip }, async () => {
  const { ctx, admin, errors } = await openPair();
  await admin.click('.tabs [data-tab="teams"]');
  await admin.click('text=Load demo teams');
  await admin.click('text=…or start with an empty fixture list');
  await admin.click('dialog button:has-text("Start league")');
  await pickTeam(admin, '#af-home', 'Double Trouble');
  await pickTeam(admin, '#af-away', 'Oche Dear');
  // Dropdowns show who is in each team.
  assert.match(await admin.textContent('#af-home'), /Double Trouble \(Sam Reid & Alex Moore\)/);
  await admin.click('form[data-form="add-fixture"] button');
  await admin.click('summary:has-text("Paste a fixture list")');
  await admin.fill('#bulk-fixtures', 'The Bullseyes v Treble Makers\nNobody v Oche Dear');
  await admin.click('form[data-form="bulk-fixtures"] button');
  assert.equal(await admin.locator('table.fixtures tbody tr').count(), 2);
  assert.equal(await admin.inputValue('#bulk-fixtures'), 'Nobody v Oche Dear');
  await admin.click('table.fixtures tbody tr:nth-child(2) [data-action="fixture-edit"]');
  await admin.fill('dialog input[name="pos"]', '1');
  await admin.click('dialog button:has-text("Save")');
  // The table re-renders just after the dialog closes.
  await admin.waitForFunction(() => /The Bullseyes/.test(document.querySelector('table.fixtures tbody tr')?.textContent ?? ''));
  await pickTeam(admin, '#fx-team', 'Oche Dear');
  assert.equal(await admin.locator('table.fixtures tbody tr').count(), 1);
  assert.match(await admin.textContent('table.fixtures tbody tr'), /Robin Hart & Dee Walsh/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('TV opened from a different address explains why it is waiting', { skip }, async () => {
  const ctx = await browser.newContext();
  const tv = await ctx.newPage();
  await tv.goto(`${altBase}/index.html`);
  assert.match(await tv.textContent('.waiting-screen'), /same address/);
  await ctx.close();
});

// Layout guard: nothing on the TV may spill outside the 1920×1080 stage.
const layoutCases = [];
for (const teams of [4, 8, 16]) {
  layoutCases.push([`${teams} teams · setup`, () => loadDemoTeams(T.createTournament(), teams)]);
  layoutCases.push([`${teams} teams · league live`, () => {
    const s = leagueState(teams, Math.min(6, teams));
    let x = s;
    for (const b of [1, 2]) {
      const n = T.nextUp(x)[b];
      if (n) x = T.setAverage(T.setAverage(T.startMatch(x, n.id, b), n.id, 'home', '101.25'), n.id, 'away', '58.5');
    }
    return x;
  }]);
  layoutCases.push([`${teams} teams · knockout`, () => {
    let x = simulateUntil(leagueState(teams), (y) => y.phase === 'knockout' && T.liveFixtures(y).length > 0, seededRandom(1));
    for (const f of T.liveFixtures(x)) x = T.setAverage(T.setAverage(x, f.id, 'home', '77.7'), f.id, 'away', '180');
    return x;
  }]);
  layoutCases.push([`${teams} teams · complete`, () => simulateUntil(leagueState(teams), (x) => x.phase === 'complete', seededRandom(2))]);
}

test('TV layout stays inside the screen for 4/8/16 teams in every phase', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await ctx.newPage();
  const errors = [];
  tv.on('pageerror', (e) => errors.push(e.message));
  await tv.goto(`${base}/index.html?preview=1`);
  for (const [name, make] of layoutCases) {
    const state = make();
    await tv.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify(state)]);
    await tv.reload();
    await tv.waitForSelector('#stage main');
    const overflow = await tv.evaluate(() => {
      const stage = document.getElementById('stage').getBoundingClientRect();
      const bad = [];
      for (const el of document.querySelectorAll('#stage *')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
        const clipped = el.closest('.panel, .live-card, .bm, .lc-body, .team-card');
        const box = clipped ? clipped.getBoundingClientRect() : stage;
        if (r.right > box.right + 2 || r.bottom > box.bottom + 2 || r.left < box.left - 2 || r.top < box.top - 2) {
          if (clipped && getComputedStyle(clipped).overflow === 'hidden' && el.closest('.tv-table, .list, .lc-name, .lc-players')) continue;
          bad.push(`${el.tagName}.${el.className}`);
        }
      }
      return bad.slice(0, 5);
    });
    assert.deepEqual(overflow, [], name);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('works offline after the first load (service worker)', { skip }, async () => {
  const { ctx, admin, tv } = await openPair({ state: leagueState(8, 3) });
  await tv.evaluate(() => navigator.serviceWorker.ready);
  await admin.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  await tv.reload();
  await admin.reload();
  await tv.waitForSelector('.tv-table');
  assert.match(await tv.textContent('.tv-phase'), /3 of 56/);
  await ctx.close();
});
