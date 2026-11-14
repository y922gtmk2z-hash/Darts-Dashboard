# 🎯 Darts Dashboard

A live dashboard for a **doubles darts tournament**, shown on a TV and scored from the same laptop.

- **TV view**: `index.html`. A full-screen, read-only dashboard showing live scores on both boards, the league table, what's up next, results, the knockout bracket and the champion screen.
- **Admin view**: `admin.html`. The organiser uses it to manage teams, generate fixtures, score live, fix mistakes, run the knockout and make backups.

It's a plain static site with no server, accounts or build step. Everything is saved in the laptop's browser, and the TV window updates instantly from the admin window. **After the first load it works with wifi switched off.**

---

## 1. Put it online (GitHub Pages)

1. Push this repository to GitHub with the files on the `main` branch.
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose **`main`** and **`/ (root)`**, and click **Save**.
4. Wait a minute or two. Your links are:
   - TV: `https://<your-github-username>.github.io/Darts-Dashboard/`
   - Admin: `https://<your-github-username>.github.io/Darts-Dashboard/admin.html`

> GitHub Pages on a free account needs the repository to be **public**. Nothing private is stored in the repo; tournament data only lives in your browser.

**Running it without GitHub:** from this folder, run `python3 -m http.server 8080` and open `http://localhost:8080/admin.html`. Don't double-click the HTML files: pages opened as `file://` can't load their scripts.

---

## 2. Set up the laptop and TV

Both windows must be in **the same browser, on the same laptop, opened from the same address** (for example both on `…github.io/Darts-Dashboard/`). Use a **normal window, not private/incognito**.

### Option A: Extended display (recommended)

The TV acts as a second monitor. The admin page stays on the laptop and the TV shows only the dashboard.

1. Connect the TV with HDMI (or AirPlay / Miracast as a *separate display*).
2. Make it an **extended** display, not mirrored:
   - **Windows:** press `Win + P` and choose **Extend**.
   - **macOS:** open **System Settings → Displays**, select the TV and choose **Use as: Extended display**. With AirPlay, pick *Use as Separate Display*, not *Mirror*.
3. Open **admin.html** on the laptop and click **📺 Open TV window**. If nothing opens, allow pop-ups for the site.
4. Drag the new window onto the TV and **click once inside it** (or press `F`) to go full screen. The cursor hides itself.
5. Click back on the admin window on the laptop and start scoring.
6. Check the top of the admin page says **📺 TV connected** in green. If it says *TV not connected*, the TV window isn't receiving updates (see *TV not updating* below).

### Option B: Mirroring or casting only

If the TV can only mirror the laptop, **share just the TV window or tab, never the whole screen**, so the admin controls stay private.

- **Chromecast / Google TV:** open the TV page in its own Chrome window, then open **⋮ menu → Cast… → Sources → Cast tab** and pick your TV. Don't choose *Cast screen*.
- **Teams / Zoom / Meet on a TV:** share the **window** that holds the TV page, not "Entire screen".
- Keep the TV window **visible and not minimised**. Put the admin window beside it or on top of it.

### Keep everything awake

- The TV page asks the browser to keep the screen on (Screen Wake Lock). It may only kick in after you click the TV window once.
- **Plug the laptop into power** and turn off sleep while plugged in:
  - **Windows:** go to **Settings → System → Power & battery → Screen and sleep** and set everything *When plugged in* to **Never**.
  - **macOS:** in **System Settings → Lock Screen**, set *Turn display off on power adapter when inactive* to **Never**. In **Battery → Options**, turn on *Prevent automatic sleeping on power adapter when the display is off*.
- Turn on **Do Not Disturb / Focus** so notifications don't pop up, especially when mirroring.

---

## 3. Running the night: cheat-sheet

**Before people arrive**
1. Open **admin.html** and check the **Settings** tab: title, venue, match length (first to …), points, once or twice. The JWI logo is shown on the TV by default (you can turn it off there).
2. **Teams** tab: add teams one by one, or paste a list with one team per line (`Team name: Player A & Player B`).
   - Add the player names: they're shown under the team name everywhere, so people can see who is in which team. This covers the fixtures, up next, results, table, bracket, live boards and team dropdowns, on both the TV and the admin page.
3. Open the TV window and put it on the TV. It shows the logo and the registered teams. Check the admin page says **📺 TV connected**.
4. Click **Generate fixtures & start league**, or **…start with an empty fixture list** to set every match yourself. After this, teams can be renamed but not added or removed.

**Fixture rule: "2 on, 1 off"** (Settings → Rules → *Fixture rule*, set before generating)
- Every team plays its matches **in pairs**, two in a row, **never 3 in a row**, then rests.
- With two boards, 4 teams play at a time, so how long a team rests depends on the number of teams:
  - **6 teams: exactly 2 on, 1 off** for everyone, both boards always busy.
  - **8 teams:** half the teams rest at any time, so some rests are longer (mostly 1–2 matches).
  - **10 or more:** longer rests again.
  - **4–5 teams:** the closest possible compromise (a rest after every pair can't keep both boards busy).
- Each team may have **one single match**. The very start needs this, as does an odd number of matches, and a single as a team's very last match is fine. Every pair still plays once on each board.
- On **Live scoring**, each board keeps to the plan. If its next match includes a team still playing on the other board, the card says **"Starts when X finishes on Board 2"** instead of the board jumping ahead. You can still start or type in any other match if you must.
- **Fixture check** confirms "2 on, 1 off" or says what's broken, and the Fixtures list shows the time **Slot** of each match. If you change the rule after the league has started, use *Regenerate unplayed matches* to re-plan.

**Boards** (Fixtures tab)
- Every match is planned for **Board 1** or **Board 2**. Generated fixtures give every pair one match on each board, so every team plays half its games on each. The two matches running side by side never involve the same team.
- Use the **Board 1 / Board 2 / Both boards** switch to see one board's queue in its own running order. There, **↑ ↓** and **Play next** move matches within that board only.
- Change any unplayed match's board with the dropdown in its **Board** column (or in **Edit**). *Either* lets whichever board is free take it.
- **Fixture check** shows each team's Board 1 / Board 2 split and lists any pair that isn't once on each board. **Balance boards automatically** re-plans the boards of all unplayed matches without changing their order.
- On **Live scoring**, each board's *Next up* comes from its own queue. If one board runs out while the other still has matches, it borrows the next one. *Move to the other board* (⋯) moves a match across; a match started on the other board is recorded as played there.

**Setting the fixtures yourself** (Fixtures tab, any time during the league)
- **Add a match:** pick the home and away teams (and optionally the board), then click **Add**. It goes to the end of the queue. *Board: auto* puts a pair's second meeting on the other board.
- **Paste a fixture list:** one match per line, in play order, as `Team A v Team B` (`vs` and `-` also work), optionally ending with the board: `Team A v Team B (Board 2)`. Team names must match the Teams tab. Any line that can't be read stays in the box with the reason, so you can fix it.
- On any match that hasn't started:
  - **Edit** changes the teams or its position in the queue (1 = next).
  - **⇄** swaps home and away.
  - **✕** deletes it.
  - **↑ ↓ / Play next** reorders it.
- **Fixture check** shows matches per team, pairings not scheduled yet, and pairings scheduled more than once/twice. Uneven fixtures are allowed: the table counts whatever is played.
- **Regenerate unplayed matches** keeps every played result and schedules exactly the meetings still owed. **Delete all unplayed matches** clears the queue so you can start again.
- Played and live matches can't be changed here. Use **Edit** / **Un-play** on their result instead.

**During the league** (Live scoring tab)
- Each board shows its **Next up** match. Click **▶ Start on Board 1/2**, or pick a different one from the list.
- Add a leg with the big **+ Leg** button or the keyboard. Take one off with **−**.
- **3-dart averages (optional):** each team on a live board has a **3-dart avg** box. Type the average, e.g. `54.3` (a comma works too), then press Enter or click away.
- When a side reaches the winning number of legs, a box pops up with both averages to confirm. Press **Enter** to finish the match, or choose **Undo last leg**.
- Mistake? Press **Ctrl+Z** (or **↶ Undo**). To correct an older result, use **Fixtures → Edit** or the **Match day** tab.

**Match day tab (optional overview)**
- Every fixture in two columns, **Board 1 | Board 2**, one row per time slot.
- You can type a result and averages straight into any match there and press **Save result** (no need to start it), score a live match with + / −, or **Edit result** in place. **⋯** on a card has the move / swap / delete options.

- **The league table is live ("as it stands").** Legs already won in matches being played count straight away. The team that's ahead gets a provisional win (played, W, points) and the team behind a provisional loss; while a match is level it adds legs only. If the lead changes, so does the table.
  - Teams in a match being played have their **whole row highlighted** with a red bar (admin also shows *LIVE · winning / losing / level*), so everyone can see those figures aren't final yet.
  - The TV table always shows **Form**: the last 5 finished league matches (oldest → newest). A match being played is added on the right as a pulsing pip showing how it stands (W / L / – for level).
  - Knockout seeding always uses finished results only.
- **TV extras** (worked out from the results, nothing to enter):
  - **At stake:** under each live match, the most dramatic thing riding on it, e.g. *"A win seals a semi-final place for Treble Makers"*, *"Arrows of Fury are out if they lose"*, *"The Bullseyes go top with a win"*. Knockout matches say what the winner gets.
  - **Next up:** a free board's next match shows both teams' position, points and form, and how their last meeting went.
  - **Race for the semi-finals:** a green ✓ by a team that's sure of a top-4 place whatever happens; teams that can no longer make it are faded. This is cautious: a tie on points is never assumed to go a team's way. The full table also says *"Win 2 of 3 to be sure"* when a team is close.
  - **🔥 N** by a team on 3 or more wins in a row.
- The league table's **Avg** column (TV and admin) is each team's mean over finished league matches with an average recorded.
- Mistake? Press **Ctrl+Z** (or **↶ Undo**). The Fixtures tab still has the full list tools (add, paste, fixture check, balance boards).

| Key | Action |
| --- | --- |
| `Q` / `A` | Board 1: leg to home / away team |
| `P` / `L` | Board 2: leg to home / away team |
| `Shift` + key | Remove that leg |
| `Ctrl` + `Z` | Undo the last change |
| `Enter` / `Esc` | In the "win" box: finish the match / keep it open |

You can change these keys in **Settings**. They work on every tab, as long as you're not typing in a box. On any tab other than Live scoring, a small message confirms the new score.

**Knockout**
1. When the last league match finishes, click **Start knockout…**.
2. Check the seeds (1st v 4th, 2nd v 3rd). If 4th and 5th are level on every tiebreaker you'll see a warning. Settle it how you like, then pick the team.
3. Play the semi-finals. The winners go into the final automatically.
   - If the 3rd-place play-off is on, the **final waits** until it's finished so the final is played on its own. To play both at once, untick *Play the final on its own* in **Settings**.
4. When the final finishes, the TV shows the **champion screen**. Click **Download final backup**.

**Table order:** points → leg difference → legs won → head-to-head → name.

---

## 4. Backups and recovery

Browser storage can be cleared, so take backups.

- **⬇ Backup** (top right) downloads a `.json` file of the whole tournament. Do this at least at half-time and at the end.
- On the **Backup & recovery** tab, tick **"Download a backup automatically after every finished match"**. It is the safest option for the night.
  - The first time, Chrome asks whether the site may **download multiple files**. Click **Allow**.
  - Expect one small file per match in your Downloads folder. Only the newest one matters.
- The **"✓ Saved …"** indicator at the top shows the last save. If it turns red and says **Not saved**, export a backup and switch to a normal (non-private) window.

**If something goes wrong**
| Problem | Fix |
| --- | --- |
| Wrong leg or wrong match finished | **Ctrl+Z** / **↶ Undo**, or a toast's **Undo** button |
| Need to go further back | **Backup & recovery → Recovery history → Restore** (keeps the last 25 changes) |
| A result entered wrongly long ago | **Fixtures → Edit** (or **Un-play** to put it back in the queue) |
| Browser closed or laptop restarted | Just reopen both pages. Everything reloads from storage |
| Storage wiped or a new laptop | **Backup & recovery → Import JSON backup** and choose your latest file |
| TV not updating / admin says **TV not connected** | Both windows must be in the same browser, on exactly the same address (the TV's waiting screen shows it), and not private. Reopen it with **📺 Open TV window**. Refreshing the TV is always safe |
| Admin says **📺 TV needs a refresh** | The TV window is running an older version of the app (it was open before an update). Click inside it and press **F5** (Mac: **Cmd+R**) once. Your tournament isn't affected |
| Admin shows **This admin page is out of date** | Click **Reload now**. Everything is saved and comes straight back |
| TV shows **Not connected to the admin window** (small, bottom right) | The admin window is closed or in another browser. Reopen admin.html in the same browser |
| Import says **This backup has problems** | The file is damaged or was edited. Nothing was changed. Import an earlier backup file |
| "Admin is open in another window" | Close the extra admin tab and only score from one |

---

## 5. Rehearse first

Open **Settings → Rehearsal** on a test run. Export a backup first if you already have real data.

- **Load demo teams** (Teams tab) adds 8 made-up teams.
- **Simulate next match**, **Simulate the rest of the league** and **Simulate to the end** play matches with random scores.
- **▶ Auto-play** scores a leg every second or so, so you can watch the TV react live.
- When you're done, go to **Backup & recovery → Reset tournament**, keeping teams and settings or not.

### Pre-night checklist on the real laptop and TV

These can't be tested automatically, so do them once on the actual equipment:

- [ ] TV window full screen on the TV, admin on the laptop, and admin shows **📺 TV connected**.
- [ ] If casting, only the TV window or tab is shared. Check from across the room that no admin controls are visible.
- [ ] Leave both untouched for 15 minutes: the laptop and TV don't sleep, and the screensaver doesn't start.
- [ ] Score a few legs with the keyboard and confirm the TV updates instantly.
- [ ] Refresh the TV, then close and reopen the browser. Everything comes back.
- [ ] Turn wifi off and refresh both windows. They still load and still sync.
- [ ] Download a backup, then import it again.
- [ ] Reset the tournament (keep teams if they're real) before people arrive.

---

## 6. TV options

**Rotating screens:** in admin **Settings → TV screens**, choose *Rotate … every 20 s* (or another interval). The TV starts cycling straight away, no address changes needed, and the setting is saved with the tournament. A scored leg or finished match always brings the TV back to the live screen for a full turn. The line under the setting says what the TV is doing right now (e.g. *✓ TV is rotating every 20 s · now showing the position chart*) or why it isn't rotating: before the league starts there's only the teams screen, so rotation begins once the league is under way. The admin **Preview TV** pane rotates too.

You can also add these to the TV address (they override the setting):

| URL | Shows |
| --- | --- |
| `index.html` | Automatic: the best layout for the current phase |
| `index.html?view=table` | Only the full league table (with a *Semi-finals* column once anyone is through, out, or close) |
| `index.html?view=chart` | Race for the top: every team's league position after each match, current top 4 highlighted |
| `index.html?view=grid` | Head to head: every result between each pair of teams (row team's score first) |
| `index.html?view=stats` | 3-dart averages (best average, best single match, on the up) and streaks & records |
| `index.html?view=fixtures` | Up next and results |
| `index.html?view=bracket` | The knockout bracket (during the league: "if it ended now") |
| `index.html?rotate=15` | Cycles through views every 15 seconds, jumping back to the live view when a score changes (`?rotate=0` = never rotate, whatever the setting) |

When rotating, the league cycles live → table → chart → head to head → stats → fixtures (the chart and stats join once there are results); the knockout cycles live → table → stats → fixtures; after the final it cycles champion → bracket → table → chart → stats.

The TV is designed for 1920×1080. On other screen shapes it scales down and adds black bars, so nothing is ever cut off or scrolled. With more than 10 teams the league table takes the full height so it stays readable.

---

## 7. Rules and settings (all editable in Settings)

| Setting | Default |
| --- | --- |
| Teams | 4–16 (pairs, optional player names) |
| League | Every team plays every other team **twice** (or once) |
| Match length | League, semi-finals, final and 3rd place each set separately: single leg, or **first to 2, 3, 4, 5 or 6 legs** (best of 3, 5, 7, 9, 11). Default first to 2 |
| Points | Win **3**, loss **0** |
| Knockout | Top 4: 1st v 4th, 2nd v 3rd, then the final. 3rd-place play-off off. The final is played on its own |
| Branding | Title *James Watkins Invitational*, JWI logo on the TV (both changeable) |
| Boards | 2 ("Board 1", "Board 2"; can be renamed) |

Once/twice can only change before the league starts. Each match length can change until the first match of that stage starts. For example, set the league to *first to 3* and the semi-finals and final to *first to 5* in **Settings → Rules → Match length**.

---

## 8. For developers

```
index.html, admin.html   TV and organiser pages
js/logic/                pure functions, no DOM: fixtures, standings, bracket, tournament actions, simulator
js/store.js              data layer: get / set / subscribe, localStorage + BroadcastChannel adapter, undo, history
js/view.js               shared HTML helpers
js/tv.js, js/admin.js    the two pages
css/                     base, tv, admin styles
img/                     JWI logo (transparent PNG) and app icon
sw.js                    offline cache (update the ASSETS list when adding files; a test checks this)
tests/                   node --test unit tests, no dependencies
tests/e2e/               browser tests (admin + TV together), need Playwright
.github/workflows/       runs both test suites on every push to main and every pull request
```

- Run the unit tests with `node --test` (or `npm test`). Node 18+ is needed and nothing has to be installed.
- Run the browser tests with `npm run test:e2e`. They start their own web server and need Playwright: `npm install --no-save playwright && npx playwright install chromium`. Without Playwright they're skipped.
  - They cover admin→TV sync, the TV-connected indicator, recovery after refresh, keyboard scoring from any tab, finishing a match, the final waiting for the 3rd-place match, refusing a bad backup, manual fixtures, a TV opened from the wrong address, offline reload, and a layout guard that nothing spills off the 1920×1080 TV at 4, 8 or 16 teams in every phase.
- The unit tests include random sequences of organiser actions that must never break the tournament's rules: one match per board, no team on two boards, valid scores, and a valid state at every step.
- **Data model:** a single tournament object `{config, phase, teams[], fixtures[], seeds}`. Standings and the bracket are always derived and never stored.
- **Adding remote scoring later:** write another adapter with the same shape as `createLocalStorageAdapter` in `js/store.js` (`load`, `save`, `listen`, `broadcast`…), for example backed by Firebase, and pass it to `createStore`. Nothing else needs to change.
- **Releasing a change:** bump `APP_VERSION` in `js/version.js` *and* `VERSION` in `sw.js` (a test fails if they differ).
  - When online, the service worker fetches the latest files first. It falls back to its saved copy only when offline or the network is slow, so one reload picks up a deploy.
  - A TV window left open from an older release refreshes itself as soon as a newer admin page is open. It tries once, so a stubborn cache can't cause a reload loop.
  - If the TV is the newer one, the admin page shows a "This admin page is out of date — Reload now" banner.
