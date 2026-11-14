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
1. Open **admin.html** and check the **Settings** tab: title, venue, best-of, points, once or twice. The JWI logo is shown on the TV by default (you can turn it off there).
2. **Teams** tab: add teams one by one, or paste a list with one team per line (`Team name: Player A & Player B`).
3. Open the TV window and put it on the TV. It shows the logo and the registered teams. Check the admin page says **📺 TV connected**.
4. Click **Generate fixtures & start league**, or **…start with an empty fixture list** to set every match yourself. After this, teams can be renamed but not added or removed.

**Setting the fixtures yourself** (Fixtures tab, any time during the league)
- **Add a match:** pick the home and away teams, then click **Add**. It goes to the end of the queue.
- **Paste a fixture list:** one match per line, in play order, as `Team A v Team B` (`vs` and `-` also work). Team names must match the Teams tab. Any line that can't be read stays in the box with the reason, so you can fix it.
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
- When a side reaches the winning number of legs, a box pops up. Press **Enter** to finish the match, or choose **Undo last leg**.
- Mistake? Press **Ctrl+Z** (or **↶ Undo**). To correct an older result, go to **Fixtures → Edit**.
- Need a different order? Go to **Fixtures** and use **↑ ↓** or **Play next**. The team filter there shows one team's matches.

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

Add these to the TV address:

| URL | Shows |
| --- | --- |
| `index.html` | Automatic: the best layout for the current phase |
| `index.html?view=table` | Only the full league table (with form) |
| `index.html?view=fixtures` | Up next and results |
| `index.html?view=bracket` | The knockout bracket (during the league: "if it ended now") |
| `index.html?rotate=15` | Cycles through views every 15 seconds, jumping back to the live view when a score changes |

The TV is designed for 1920×1080. On other screen shapes it scales down and adds black bars, so nothing is ever cut off or scrolled. With more than 10 teams the league table takes the full height so it stays readable.

---

## 7. Rules and settings (all editable in Settings)

| Setting | Default |
| --- | --- |
| Teams | 4–16 (pairs, optional player names) |
| League | Every team plays every other team **twice** (or once) |
| Best of | League **3**, semi-finals **3**, final **3**, 3rd place **3** |
| Points | Win **3**, loss **0** |
| Knockout | Top 4: 1st v 4th, 2nd v 3rd, then the final. 3rd-place play-off off. The final is played on its own |
| Branding | Title *James Watkins Invitational*, JWI logo on the TV (both changeable) |
| Boards | 2 ("Board 1", "Board 2"; can be renamed) |

Once/twice can only change before the league starts. A best-of value can change until the first match of that stage starts.

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
- After changing cached files, bump `VERSION` in `sw.js` so browsers pick up the new version promptly.
