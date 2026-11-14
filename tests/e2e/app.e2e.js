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
  await admin.fill('#avg-L1-home', '54,3');
  await admin.press('#avg-L1-home', 'Enter');
  await tv.waitForFunction(() => document.querySelector('[data-avg="L1-home"]')?.textContent === '54.30');
  await admin.fill('#avg-L1-away', 'abc');
  await admin.press('#avg-L1-away', 'Tab');
  await admin.waitForSelector('.toast.error');
  assert.equal(await admin.inputValue('#avg-L1-away'), '', 'invalid entry rolled back');
  // Win the match; the finish box offers both averages (home prefilled).
  await admin.click('body');
  await admin.keyboard.press('q');
  await admin.keyboard.press('q');
  await admin.waitForSelector('dialog[open] input[name="awayAvg"]');
  assert.equal(await admin.inputValue('dialog input[name="homeAvg"]'), '54.30');
  await admin.fill('dialog input[name="awayAvg"]', '47.5');
  await admin.press('dialog input[name="awayAvg"]', 'Enter');
  await tv.waitForSelector('.tv-table .avg-h');
  const stored = await admin.evaluate((k) => JSON.parse(localStorage.getItem(k)).fixtures.find((f) => f.id === 'L1'), KEY);
  assert.deepEqual([stored.status, stored.homeAvg, stored.awayAvg], ['done', 54.3, 47.5]);
  await admin.click('.tabs [data-tab="table"]');
  assert.match(await admin.textContent('table.standings'), /54\.30/);
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
