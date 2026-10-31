# F1 Race Replay

A dashboard to re-watch a Formula 1 race after it has finished: the cars move on a 2D map of the
circuit, with a live leaderboard, tyre strategy, an event timeline, automatically detected
overtakes, driver highlight, a close-up "focus" camera and live telemetry.

It is a small Python script that exports a race to JSON files, plus a plain HTML + JavaScript
page (Canvas 2D and Chart.js, no framework, no backend) that plays them.

> **Disclaimer:** this is an unofficial fan project. It is not affiliated with, endorsed by or
> connected to Formula 1, the FIA, any team or any driver. "F1", "Formula 1" and related names and
> marks belong to their owners (Formula One Licensing B.V. and others) and are used here only to
> say what the data is about.

## What you can do
- **Map and replay:** track drawn from the fastest lap, numbered corners, one pixel-art car per driver in
  team colours (the two cars of a team differ by a white or black stripe), pointing the way it
  drives, with its abbreviation. Play/pause, 1x / 2x / 5x / 10x, scrubber and lap selector. A lap
  counter sits in the top left, with a badge during a Safety Car, Virtual Safety Car or flag.
- **Leaderboard:** position, driver, gap to the car ahead, tyre compound (S/M/H/I/W), laps on the
  current set and number of pit stops. Retired cars show OUT, non-starters DNS.
- **Timeline** under the map: overtakes, pit stops, Safety Car / VSC, yellow and red flags,
  retirements and the fastest lap. Click a marker to jump there (3 s before the event), hover to
  read it, use the checkboxes to filter by type.
- **Overtakes tab:** every detected overtake with lap, nearest corner, who passed whom, speed
  difference at the pass and DRS / Overtake Mode information. Click one to jump there; the place
  is marked on the map.
- **Highlight:** click a driver in the leaderboard or on the map. He gets a bigger car with a glowing ring, the
  other cars fade, and his trace on the map is coloured by what he is doing: green accelerating,
  red braking, yellow coasting.
- **Telemetry tab:** for each highlighted driver the live speed, gear, throttle and brake, and a
  speed-against-distance graph of the current lap.
- **Focus mode:** pick a driver in the *Focus* menu and the camera follows him closely (zoom Close,
  Medium or Wide). Only he, the car ahead and the car behind are shown, with the gaps to them.
- **Mini-sectors:** the *Mini-sectors* button cuts the lap into 25 equal pieces and colours every
  piece of the track in the team colour of the driver who was fastest through it, with his name on
  it. The box in the corner counts how many pieces each driver won. The menu next to the button
  chooses the lap (*Follow replay* or a fixed lap).
- **Highlights mode:** the *Highlights* button plays only the interesting moments: overtakes, pit
  stops, Safety Car / VSC / red flag, retirements and the fastest lap, one after another, skipping
  everything in between. It follows the timeline filters (a type switched off there is not played;
  yellow flags are never played). The bar on the map has previous / next moment and *Only moments of my highlighted drivers* (race-wide events like the Safety Car stay). Press Play after the last moment to start again.
  With *Zoom on the action* (on by default) the camera also goes to the place of the moment: it centres
  on the drivers of the event (the two cars of an overtake, the car that pits or stops) and zooms until
  they fit; the cars of the moment get a white ring. For events of the whole race (Safety Car...) it
  shows the whole track. The Zoom menu in the header sets how close it goes.
- **Race trace:** the *Race trace* button covers the map with a chart of the gap of every driver after
  every lap (Chart.js). By default the gap is to the leader; *Gap to* can be any driver (a line going up
  means faster than him). Dots are pit stops, coloured bands are Safety Car / VSC / red flag, the white
  line is the replay time. Click a line to highlight that driver, click elsewhere to jump to that lap.
  *Range* Auto ignores extreme gaps (a car that spent minutes in the garage), All shows everything.
- **Messages tab:** the race director's messages as a live feed (newest on top): flags, Safety Car,
  investigations, penalties, deleted lap times... Filter by group; by default only what has already
  happened is shown. Click a message to jump there. Driver abbreviations are in team colours.
- **Weather:** under the lap counter: air and track temperature, humidity, wind (speed and the
  direction it blows to) and a RAIN badge while it rains. One sample per minute, the last one before
  the replay time. Can be switched off in Settings.
- **Sectors:** the *Sectors* button colours the three official timing sectors like the TV timing
  screens, for the driver chosen in the menu next to it: **purple** = the best time anybody had set in
  that sector up to that moment, **green** = his own best so far, **yellow** = slower than his best.
  The table in the corner has his three times, the difference to the best of that lap and the lap time.
  Choose *Fastest in lap* to colour every sector in the team colour of the fastest driver in it. The lap
  menu works as for the mini-sectors (only one of the two modes is on at a time). The sector times are
  OpenF1's official ones; where the sectors start on the track is estimated (see *How it works*).
- **Battles tab:** pairs of cars that ran less than one second apart for 3 laps or more (safety car
  periods and pit stops are left out), with the laps, average and closest gap and the number of
  overtakes between them. Click one to jump to its start. While a battle is in progress (LIVE) the map
  draws a dashed line between the two cars with the gap; untick the box to hide the lines. In 2026,
  "less than 1 s" is the Overtake Mode range (an estimate, like everywhere in 2026).
- **Driver comparison (Telemetry tab):** tick *Compare two drivers on the same lap*, choose two drivers
  and a lap (or follow the first driver's lap). The top graph overlays their speed against the distance
  in the lap, the bottom one shows how far the second is behind the first at every point (down =
  slower); the right end of that line is the difference of the lap times. The white line is the replay.
- **Radio tab:** the team radio clips of the race (when the data has them), newest first; click a row
  to jump there, the round button to listen. The sound comes from the Formula 1 servers (OpenF1 only
  gives links), so this is the one feature that needs an internet connection. Australia 2026 has none.
- **Keyboard shortcuts** (the *Keys* button lists them): `Space` play / pause, `Left` / `Right` 5 s
  back / forward (`Shift`: 30 s), `[` / `]` previous / next lap (in Highlights: moment), `F` focus
  on the highlighted driver or the leader, `1`-`4` speed, `H` highlights, `T` race trace, `S` sectors,
  `M` mini-sectors, `Esc` close panels, `?` the list.
- **Movable tabs:** drag any tab of the side panel (Leaderboard, Overtakes, Battles, Telemetry, Messages,
  Radio) to another place in the row; a line shows where it will land. The order is remembered in your
  browser, and *Reset* in Settings puts the tabs back.
- **Floating windows:** drag a tab out of the side panel and drop it on the map (or double-click the
  tab): it becomes a window on top of the map. Drag its title bar to move it, drag the bottom right
  corner to resize it (that sets how much of it you see; the rest scrolls), use the slider in the
  title bar to make it see-through, click a window to bring it in front of the others, and press
  *Dock* to put the tab back in the side panel. Several windows can be open at once; if every tab is in
  a window the side panel disappears and the map gets the whole width. Position, size, order and
  transparency are remembered in your browser (`js/floating.js`); *Reset* in Settings docks them all.
- **Settings (the gear button, top right):** make the pitwall yours. Everything is remembered in
  your browser (see below).

## Requirements
- **Python 3.10 or newer** (developed with 3.13). Check with `py --version` (Windows) or
  `python3 --version`.
- **A modern browser** (Chrome, Edge, Firefox).
- **Internet** for the first export of each race (the data comes from the free OpenF1 API).
  Afterwards everything works offline.
- Free disk space: about 200 MB per race for the download cache (`cache/`) and 5-6 MB for the
  exported data the page loads (`data/`). Once a race is exported you can delete `cache/` to
  save space; it is only needed to re-export quickly.

No account or API key is needed.

## Install (once)
Open a terminal in the project folder.

**Windows (PowerShell)**
```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

**macOS / Linux**
```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

A virtual environment (`.venv`) is a private copy of Python for this project, so the libraries do
not touch the rest of your system.

> On some Windows PCs the plain `python` command opens the Microsoft Store instead of Python.
> Use `py`, or the full path `.\.venv\Scripts\python.exe`, as in the commands below.

## Choose and export races from the page
The easiest way: start the server (`py serve.py`, see below), open the page and press **Races**
(top right).
1. Pick a **season** (2023 to the current year); its races are listed with a tick box. Races that
   are not run yet are greyed out, exported ones have a green *exported* mark.
2. Tick the races you want and press **Export selected**. Each one downloads about 200 MB and takes
   a few minutes; a progress bar and the current step are shown, and you can *Cancel* a race. The
   exports run one after another in the background, so you can keep watching another race, or even
   close the page. A finished race appears in the race selector by itself.
3. Decide what happens with the downloaded data with **Keep the downloaded data in the cache**.
   Kept: exporting the same race again takes seconds. Not kept: the ~200 MB of that race are
   deleted right after the export (the page's data, about 6 MB, stays).
4. At the bottom, **Exported races and cache** shows the size of each race and its cache, with
   **Delete cache** per race and **Delete all cache** for the whole `cache/` folder. Deleting a
   cache never removes an exported race, it only means that exporting it again downloads it again.

This needs `serve.py` (the plain `python -m http.server` has no API); the export itself still uses
the `.venv` from the install step. The same thing from the command line is below.

## Export a race (command line)
```powershell
.\.venv\Scripts\python.exe python\export_race.py 2025 Monza
.\.venv\Scripts\python.exe python\export_race.py 2026 1
```
(macOS / Linux: use `.venv/bin/python python/export_race.py 2025 Monza`.)
Add `--delete-cache` to delete the downloaded data of that race when the export is done.

- The first argument is the year (2023 to 2026).
- The second is either the round number (`1` = first race of the year) or a word from the country,
  city or circuit name (`Monza`, `Australia`, `Spa`). If the word matches several races (for
  example `Italy` is Imola and Monza in 2025) the script lists the options.
- The **first export of a race takes several minutes**: it downloads about 10 MB per driver. The
  downloads are cached in `cache/`, so exporting the same race again takes a few seconds.
  (Telemetry files are written by the export, so races exported before stage 4 need a re-export.)
- The result is written to `data/<year>_<race>/` and the race appears in the selector of the page.

You can export as many races as you like; the page has a selector.

## Run the page
From the project folder:
```powershell
py serve.py
```
(macOS / Linux: `python3 serve.py`; another port: `py serve.py 8001`.) Then open
**http://localhost:8000/web/** in the browser. Stop the server with Ctrl+C.

`serve.py` is the same as `py -m http.server 8000`, plus a small local API for the Races panel
(reachable only from your computer), plus a `Cache-Control: no-cache` header so
the browser never keeps using an old copy of the page's JavaScript after an update. The plain
`http.server` also works, but then press Ctrl+F5 in the browser after every update.

The server must be started from the **project root** (the folder that contains both `web/` and
`data/`), because the page reads `../data/`.

Optional deep link, handy for sharing a view:
`http://localhost:8000/web/?race=2025_italian-grand-prix&t=1500&hl=VER,NOR&tab=telemetry&focus=NOR&zoom=close`

| Parameter | Meaning |
|---|---|
| `race` | folder name inside `data/` |
| `panel` | `races` opens the Races panel |
| `t` | start time in seconds since lights-out |
| `hl` | highlighted drivers, comma separated (`VER,NOR`) |
| `tab` | `leaderboard`, `overtakes`, `battles`, `telemetry`, `messages` or `radio` |
| `compare` | `1` opens the driver comparison (with `tab=telemetry` and `hl=VER,NOR`) |
| `sectors` | `1` switches the sectors on (`secdriver=VER` for a driver, `minilap=12` for a lap) |
| `trace` | `1` opens the race trace |
| `highlights` | `1` starts the Highlights mode |
| `focus` | driver the camera follows |
| `zoom` | `close`, `medium` or `wide` |
| `ot` | index of the overtake to select (`0` is the first) |
| `mini` | `1` switches the mini-sectors on |
| `minilap` | lap shown by the mini-sectors (default: follow the replay) |

## Personalize the pitwall
Open **Settings** (gear button in the header). Changes apply immediately and are saved in your
browser (`localStorage`), so they are there the next time you open the page. Nothing is sent
anywhere. *Reset* goes back to the defaults.

| Group | What you can change |
|---|---|
| Appearance | theme (Dark, Midnight blue, Light), accent colour, side panel left or right, side panel width |
| Panels | show or hide the lap counter, the weather, the event timeline, the focus panel, the trace legend, the tyre and pit stop columns of the leaderboard |
| Map | corner numbers, pixel-art cars or dots, driver names next to the cars, car size, names on the mini-sectors |
| Telemetry | speed in km/h or mph |
| When the page opens | which side tab, replay speed, focus zoom, and **favourite drivers** (for example `VER, NOR`) that are highlighted automatically in every race they are in |

If your browser blocks `localStorage` (some private windows), the page still works but forgets
your choices when it is closed.

Ideas that would fit next (not built yet): drag and drop to reorder the panels, saved profiles
("my team", "race analysis"), a favourite team instead of single drivers, custom event colours.

## Seasons and the 2026 rules
- **Supported seasons: 2023 to 2026.** OpenF1 has no data before 2023.
- Up to 2025 the app shows DRS from the car telemetry (open / available / none).
- From 2026 DRS is gone. The data has **no Overtake Mode channel**, so for 2026 the page only
  shows whether the attacker was within 1 s of the car ahead and labels that clearly as an
  **estimate**. Nothing is invented.

## How it works
```
OpenF1 API --> python/ (load, detect, export) --> data/<race>/*.json --> web/ (HTML + JS)
```
- `python/openf1.py` downloads and caches the data. `data_loader.py` turns it into tables.
- `lap_timing.py` finds the laps by counting passes over the start line in the X/Y data, because
  OpenF1's own lap numbers are wrong or missing in some races.
- `detect_events.py` finds pit stops, flags, safety cars, retirements and the fastest lap.
- `detect_overtakes.py` takes swaps of the official race order as candidates, throws out the ones
  caused by pit stops, retirements, penalties (swaps after a driver's own finish) and red flags,
  and keeps only those confirmed by a real pass on the track.
- `export_minisectors.py` projects every car's X/Y onto the track outline to get its distance driven,
  then finds the time at which it passed each of the 25 boundaries of each lap. (The sum of a
  lap's sector times differs from OpenF1's lap time by a median of 0.03 s at Monza 2025.)
- `export_sectors.py` finds where sectors 1 and 2 end on the track: S1 ends `duration_sector_1` seconds
  after a lap starts, so it looks where the car was at that moment, projects that point onto the
  outline and takes the median over about 900 laps of all drivers (the spread is about 7 m). The
  sector times are OpenF1's own (matched to our laps by their start time).
- `detect_battles.py` reads the same race order and intervals as the leaderboard: two cars that are
  adjacent in the order with an interval of 1 s or less for 3 laps (gaps of up to 20 s in the contact
  are bridged) make a battle. Pit stops, safety car / VSC / red flag periods, retired and finished cars
  are left out.
- `export_weather.py` and `export_teamradio.py` copy OpenF1's `weather` and `team_radio` tables.
- `export_json.py` (with `export_leaderboard.py`, `export_telemetry.py`, `export_minisectors.py` and
  the exporters above) writes the JSON files.
- In the browser, `replay.js` runs the clock and **interpolates** positions: the file holds one
  position per second but the screen redraws about 60 times per second, so each frame draws the
  point on the straight line between the two nearest samples
  (`position = p0 + (p1 - p0) * f`, with `f` from 0 to 1). Without it the cars would jump once
  per second. The explanation with an example is in the comments of `web/js/replay.js`.

## Project structure
```
python/    data scripts (export_race.py is the entry point)
web/       the page: index.html, css/, js/ (one file per panel), lib/ (Chart.js)
data/      exported races (JSON); created by the export script
cache/     downloaded OpenF1 data; created by the export script
```

## Known limits
- Overtake detection is automatic and approximate, especially on lap 1 where the official order
  is noisy. It agrees well with OpenF1's own overtake list (for example 44 of our 45 Monza 2025
  overtakes are in it) but can miss or add a few.
- The nearest corner of an overtake is the nearest by distance, not necessarily the one the
  drivers were braking for.
- Some races have gaps in OpenF1 data (for example a stint without a tyre compound, shown as `?`).
- A few position samples per car jump by 150-300 m for one second (a data glitch).
- Mini-sector times come from the 4 Hz position data, so they are accurate to roughly 0.05-0.1 s;
  two drivers within that margin can be swapped. A mini-sector time that is implausibly short is
  ignored. Races exported before stage 5 need a re-export to get mini-sectors.
- Races exported before stages 6 and 7-9 lack some files (race trace, messages, sectors, weather,
  radio, battles); the matching buttons and tabs say so. Export them again from the Races panel.
- The sector borders are an estimate (about 7 m), good enough to colour the track, not to measure.
  A lap without an official sector time (a few laps per race) shows no colour for that sector.
- A battle only needs the official order and the intervals, so it can also count cars that ran close
  because the one in front was slow, not because they were fighting.
- Team radio: the links come from OpenF1 and may stop working; some races have no clips.

## Troubleshooting
- **The page is empty or shows an error:** start the server from the project root, and export at
  least one race first (`data/races.json` must exist).
- **A menu or tab does nothing (for example Focus or Telemetry):** the browser is probably using an
  old cached copy of the JavaScript. Press **Ctrl+F5** (Cmd+Shift+R on a Mac), and start the
  server with `py serve.py`. If a red bar appears at the bottom of the page it says what is wrong.
  If it still fails, open the browser console (F12, "Console" tab) and look for red messages.
- **`python` opens the Microsoft Store:** use `py` or the `.venv` path, see above.
- **Port 8000 is busy:** use another port, `py serve.py 8001`, and open that one. (Two servers on
  the same port can give blank pages: close the old one first.)
- **The export says it matches several races:** use a more specific word or the round number.
- **The export is slow:** that is the first download; it is cached afterwards.
- **No telemetry for a driver:** re-run the export; telemetry files are written by the export.

## Data source
Race data comes from the free [OpenF1](https://openf1.org) API. FastF1 is only used for the corner
numbers and the map rotation of each circuit (`fastf1.mvapi`); since FastF1 3.9 its session data
requires a paid F1TV subscription, which is why OpenF1 is used instead.

This repository contains **no race data**: the `data/` and `cache/` folders are not uploaded.
Everything is downloaded from OpenF1 on your own computer when you export a race, and stays there.
OpenF1 is a separate project with its own terms of use; the team radio recordings are not copied at
all, the page only links to the files on the Formula 1 servers. Please use the data for personal,
non-commercial purposes and respect the rules of OpenF1 and of Formula 1.

## License
The code of this project is released under the [MIT License](LICENSE). The Chart.js library in
`web/lib/` is also MIT-licensed and keeps its own notice at the top of the file. The license does not
cover the race data (OpenF1 / Formula 1) or the Formula 1 names and marks (see the disclaimer above).
