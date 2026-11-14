# Darts Tournament Live Dashboard — Build Brief

## 1. What we're building
A static web app, hosted on **GitHub Pages**, that runs a **doubles darts tournament** and shows it live on a TV.

- **TV view** (`/index.html`): read-only, full-screen dashboard. Live scores on both boards, league table, fixtures/results, then knockout bracket. Updates instantly with no refresh.
- **Admin view** (`/admin.html`): used by the organiser **on the same laptop**. Enter team names, generate fixtures, update live scores, finish matches, correct mistakes.

## 2. Tournament rules (all configurable in a `config` object / admin settings)
- **Teams:** pairs (doubles). Number of teams is variable (default 8, support 4–16). Each team has a name and optional two player names.
- **Boards:** 2 dartboards ("Board 1", "Board 2"). Two matches can run at once.
- **League stage:** round robin — every team plays every other team once (option: twice).
- **Match format:** best of N legs (default best of 3). Game type is cosmetic (default 501, double out).
- **Points:** win = 3, loss = 0 (configurable).
- **Table order / tiebreakers:** points → leg difference → legs won → head-to-head → name (alphabetical). Keep this as a pure, tested function.
- **Knockout:** top 4 qualify. Semi-finals 1st v 4th, 2nd v 3rd. Winners play the final. Optional 3rd-place playoff (default off). Knockout best-of defaults: semi best of 5, final best of 7 (configurable).
- **Phases:** `setup → league → knockout → complete`.

## 3. How it will be used (drives the architecture)
- **One laptop does everything.** I score from the laptop, and the laptop is screen-shared / cast / extended to the TV.
- Two browser windows on the laptop: **Admin** (stays on the laptop screen) and **TV** (shown on the TV). The TV window must update live from the admin window.
- Preferred setup is an **extended display** (TV as a second monitor, TV window dragged onto it). If only mirroring is possible, I will share/cast **just the TV window or tab**, never the whole screen, so admin controls are not visible. Explain both in `README.md`.
- The TV page must look right fullscreen in a normal browser, need no cursor/keyboard, and keep the laptop awake (Screen Wake Lock, plus a README note on power settings).

## 4. Architecture (decision made — please follow)
**Local-first, no backend, no accounts, no wifi dependency after the page loads.**

- Pure static site: vanilla HTML/CSS/JS with ES modules, **no build step**; repo root deploys straight to GitHub Pages.
- State lives in **`localStorage`** under one key, written on every change. Admin and TV windows (same browser, same origin) stay in sync via **`BroadcastChannel`** plus the `storage` event as a fallback, so the TV updates instantly.
- Both pages must tolerate a refresh or the browser being closed and reopened: state reloads from `localStorage`. Add an **autosave history** (last ~20 snapshots) for recovery.
- **Data-loss protection is a must-have** because browser storage is fragile: one-click **Export JSON backup** (also auto-prompt a download after every finished match, optional toggle), **Import JSON**, and a visible "last saved" indicator on admin. Warn if storage is unavailable (e.g. private window).
- Make the data layer a small **`store.js` interface** (`get`, `set`, `subscribe`) with a localStorage adapter, so a Firebase adapter could be added later for scoring from a phone. **Do not build Firebase now.**
- Pages must also work when opened from the GitHub Pages URL with wifi switched off after loading (static assets cached; optionally add a tiny service worker for offline).

Suggested structure:
```
/index.html        TV dashboard
/admin.html        organiser controls
/js/logic/         PURE functions: fixtures, standings, bracket (unit-tested)
/js/store.js       data layer (localStorage + BroadcastChannel adapter)
/js/tv.js  /js/admin.js
/css/
/tests/            logic tests (node --test, no deps)
/README.md         running the night cheat-sheet + display setup
```

## 5. Data model (single tournament object)
- `config`: rules above
- `phase`
- `teams[]`: `{id, name, players?}`
- `fixtures[]`: `{id, stage: league|semi|final|third, round, homeId, awayId, board: 1|2|null, status: scheduled|live|done, homeLegs, awayLegs, order}`
- Standings and bracket are **derived**, never stored.

## 6. Admin features (laptop, mouse/keyboard and touchscreen friendly)
1. Add / edit / remove teams (editable until league starts; names editable any time). Quick bulk-paste (one team per line).
2. **Generate fixtures** (circle method). Order the list so no team plays back-to-back where possible and both boards stay busy. Allow reorder/swap of upcoming matches.
3. **Start match** on Board 1 or 2 (assign from the upcoming queue). Show "next up" per board.
4. **Live scoring:** big +/- leg buttons per side, plus keyboard shortcuts (e.g. Q/A for Board 1, P/L for Board 2, configurable). Auto-finish when a side reaches the winning leg count, with confirm and **Undo**.
5. **Edit any past result** (standings recalc instantly).
6. **Start knockout:** auto-seed the top 4; preview and confirm. Flag a tie at 4th place for a manual decision.
7. Advance semi-final winners to the final automatically.
8. Reset tournament (double-confirm), export/import JSON backup.
9. A **"Preview TV"** mini-pane or button is nice-to-have; the admin layout must never require the TV window to be visible.

## 7. TV dashboard requirements
Target: **1920×1080 landscape on a TV**, viewed from several metres away. Design for 16:9 but letterbox (never scroll or cut off) on other ratios.

- Big type, high contrast, dark theme, no scrolling, no mouse needed. Scale with `clamp`/`vw` units.
- **League phase layout:** two large "Live now" cards (Board 1 / Board 2: team names, leg score, match status), the **live league table** (pos, team, P, W, L, leg diff, pts) with the top-4 qualification line highlighted, plus "Up next" and "Latest results" panels.
- **Knockout layout:** bracket (semis → final), live cards for the boards, qualified teams.
- **Champion screen** when complete (confetti/animation, tasteful).
- Subtle animation when a score changes or a team moves up/down the table.
- Request a **Screen Wake Lock**, hide the cursor, offer click-to-fullscreen on first load.
- Idle/setup state: show tournament title and registered teams.
- Optional URL params: `?view=table|fixtures|bracket` to pin a view, `?rotate=15` to cycle views every N seconds.

## 8. Quality bar
- Unit tests for fixtures generation (every pair exactly once, no team twice in a round), standings/tiebreakers, and bracket seeding. Cover odd team counts (bye handling).
- A **seed/simulate** button or script that loads 8 demo teams and plays through a full tournament so I can rehearse before the night.
- Test admin + TV together in two windows, and the refresh/reopen recovery path.
- Accessible contrast, no tiny text on TV.

## 9. Deliverables
1. Working app, deployable by pushing to `main` with GitHub Pages enabled.
2. `README.md`: how to enable GitHub Pages; how to set up the laptop + TV (extended display vs sharing a single window); a short "running the night" cheat-sheet; backup/recovery steps.

## 10. How to work
1. **Plan first:** read this brief, ask at most 5 questions if anything blocks you, otherwise assume the defaults above.
2. Build in this order: pure logic + tests → store → admin → TV → polish → docs.
3. Commit in small steps with clear messages. Run the tests before each commit.
4. List anything I must do manually at the end rather than guessing.

## 11. Open details to fill in before you start
- Tournament name / branding colours: ______
- Number of teams: configurable in admin settings (4–16, default 8)  Matches once or twice: ______
- Best-of legs in league: ______  Semi: ______  Final: ______
- Points for a win: 3 (loss: 0)
