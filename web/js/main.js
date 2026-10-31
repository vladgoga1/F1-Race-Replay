// Glue: loads a race, wires the controls and runs the animation loop.
import { loadRaceList, loadRace } from "./data.js";
import { Replay, stepValue } from "./replay.js";
import { TrackMap } from "./map.js";
import { Leaderboard } from "./leaderboard.js";
import { Timeline, trackStatus } from "./timeline.js";
import { OvertakeList } from "./overtakes.js";
import { TelemetryStore, TelemetryPanel } from "./telemetry.js";
import { FocusPanel, neighbours } from "./focus.js";
import { MiniSectors } from "./minisectors.js";
import { MessageFeed } from "./messages.js";
import { RaceTrace } from "./racetrace.js";
import { Highlights } from "./highlights.js";
import { WeatherBadge } from "./weather.js";
import { Sectors } from "./sectors.js";
import { BattleList } from "./battles.js";
import { RadioList } from "./radio.js";
import { Compare } from "./compare.js";
import { FloatingTabs } from "./floating.js";
import { Settings, applyToPage, buildSettingsForm } from "./settings.js";
import { setupManager } from "./manager.js";
import { refreshThemeColors } from "./theme.js";
import { formatTime, retirementTimes } from "./util.js";

const $ = (id) => document.getElementById(id);

const JS_VERSION = 12;   // must match window.PAGE_VERSION in index.html

// Show a problem on the page instead of failing silently (the browser console is easy to miss).
function showError(text) {
  const bar = $("errorBar");
  bar.textContent = text;
  bar.hidden = false;
}
window.addEventListener("error", (e) => showError(`Script error: ${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => showError(`Error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
if (window.PAGE_VERSION !== JS_VERSION) {
  showError("Your browser is using an old cached copy of this page. Press Ctrl+F5 (Cmd+Shift+R on a Mac) to reload it, " +
            "or start the server with 'py serve.py'.");
}

const PRE_ROLL = 3;   // seconds: jumping to an event starts a little before it, so you see it happen
const ZOOMS = { close: 250, medium: 500, wide: 900 };   // metres from the driver to the edge of the view

const settings = new Settings();   // the user's personal settings (see settings.js)

// What the user has chosen to look at. Shared by the map, the leaderboard, the timeline and the list.
const state = {
  highlighted: new Set(),   // abbreviations of the highlighted drivers
  selected: null,           // the selected overtake (marked on the map), or null
  onlyHighlighted: false,   // overtake list: show only overtakes of highlighted drivers
  focusAbbr: null,          // driver the camera follows (focus mode), or null
  zoomMetres: 500,
  focus: null,              // recomputed every frame: { abbr, ahead, behind } for the map and the panel
  telemetry: null,          // TelemetryStore of the current race
  miniOn: false,            // mini-sector colouring switched on?
  miniLapChoice: "follow",  // "follow" (the lap of the replay) or a lap number
  mini: null,               // recomputed every frame: { data, lap } for the map, or null
  options: settings.values, // map options from the settings (refreshed every frame)
  highlightsOn: false,      // Highlights mode: play only the interesting moments
  hlOnlyHighlighted: false, // ... and only those of the highlighted drivers
  hlZoom: true,             // ... and the camera goes to the place of the moment
  action: null,             // recomputed every frame: { abbrs, event } the camera looks at, or null
  sectorsOn: false,         // the 3 official sectors coloured on the map?
  sectors: null,            // recomputed every frame: { data, lap, driver } for the map, or null
  battle: null,             // the battle selected in the Battles tab
  battleLines: true,        // draw lines between the cars of the battles in progress
  btOnlyHighlighted: false, // battle list: only battles of highlighted drivers
  battleLinks: [],          // recomputed every frame: the lines for the map
};

let replay = null;
let map = null;
let leaderboard = null;
let timeline = null;
let overtakeList = null;
let telemetryPanel = null;
let focusPanel = null;
let miniSectors = null;
let messageFeed = null;
let raceTrace = null;
let highlights = null;
let weatherBadge = null;
let sectors = null;
let battleList = null;
let radioList = null;
let compare = null;
let retiredAt = {};
let currentTab = "leaderboard";
let lastFrame = null;
let shown = {};           // last text written to the lap counter / badge, to avoid useless updates

function refreshOvertakeList() {
  overtakeList.render(state.selected, state.highlighted, state.onlyHighlighted);
}

function highlight(abbr) {
  state.highlighted.add(abbr);
  state.telemetry.request(abbr);                        // start downloading his telemetry
  if (raceTrace) raceTrace.setHighlighted(state.highlighted);
}

function toggleHighlight(abbr) {
  if (state.highlighted.has(abbr)) {
    state.highlighted.delete(abbr);
    if (state.focusAbbr === abbr) setFocus(null);       // no focus without highlight
  } else {
    highlight(abbr);
  }
  refreshOvertakeList();
  updateLegend();
  if (raceTrace) raceTrace.setHighlighted(state.highlighted);
}

// Focus mode: the camera follows this driver (null = back to the overview).
function setFocus(abbr) {
  state.focusAbbr = abbr || null;
  $("focusSelect").value = abbr || "";
  if (abbr && !state.highlighted.has(abbr)) {
    highlight(abbr);
    refreshOvertakeList();
  }
  updateLegend();
}

function updateLegend() {
  $("trailLegend").hidden = state.highlighted.size === 0 || state.sectorsOn;
}

// A click on a timeline marker or on an item of the overtake list.
function selectEvent(event) {
  if (event.type === "seek") {                 // click on empty space of the timeline
    replay.seek(event.t);
    return;
  }
  replay.seek(event.t - PRE_ROLL);
  // Overtakes are also marked on the map; clicking the selected one again removes the mark.
  state.selected = event.type === "overtake" && state.selected !== event ? event : null;
  refreshOvertakeList();
}

// Click on a battle of the Battles tab: jump to its start and mark it on the map.
function selectBattle(battle) {
  state.battle = state.battle === battle ? null : battle;
  if (state.battle) replay.seek(battle.t - PRE_ROLL);
}

// Highlights mode on / off. Turning it on starts playing from the next moment.
function setHighlightsMode(on) {
  state.highlightsOn = on;
  $("hlBtn").classList.toggle("active", on);
  $("hlBar").hidden = !on;
  if (!on) return;
  highlights.build(timeline.hidden, state.highlighted, state.hlOnlyHighlighted);
  highlights.enter(replay);
  replay.playing = true;
}

function openTrace() {
  raceTrace.open();
  $("traceBtn").classList.add("active");
}

function closeTrace() {
  if (!raceTrace) return;
  raceTrace.close();
  $("traceBtn").classList.remove("active");
}

// Mini-sectors and sectors share the lap menu and the top right corner of the map: only one of
// them can be on.
function refreshSectorControls() {
  $("miniBtn").classList.toggle("active", state.miniOn);
  $("secBtn").classList.toggle("active", state.sectorsOn);
  $("miniLap").hidden = !(state.miniOn || state.sectorsOn);
  $("secDriver").hidden = !state.sectorsOn;
  $("miniPanel").hidden = !state.miniOn;
  $("secPanel").hidden = !state.sectorsOn;
  shown.mini = undefined;                      // force the summaries to be redrawn
  shown.sectors = undefined;
  updateLegend();
}

// Mini-sectors on / off.
function setMini(on) {
  state.miniOn = on && miniSectors !== null;
  if (state.miniOn) state.sectorsOn = false;
  refreshSectorControls();
}

// Sectors on / off. Switching them on colours them for the first highlighted driver (if any).
function setSectors(on) {
  state.sectorsOn = on && sectors !== null;
  if (state.sectorsOn) {
    state.miniOn = false;
    $("secDriver").value = state.focusAbbr || [...state.highlighted][0] || "";
  }
  refreshSectorControls();
}

function setCompare(on) {
  $("cmpOn").checked = on;
  $("chartBox").hidden = on;
  if (on) compare.suggest(state.highlighted);
}

async function startRace(folder) {
  const race = await loadRace(folder);
  state.highlighted.clear();
  state.selected = null;
  state.focusAbbr = null;
  state.telemetry = new TelemetryStore(folder);
  retiredAt = retirementTimes(race.events);

  replay = new Replay(race);
  map = new TrackMap($("map"), race.track);
  map.resize();
  leaderboard = new Leaderboard($("leaderboard"), race, toggleHighlight);
  timeline = new Timeline($("timeline"), $("filters"), $("tip"), race, selectEvent);
  timeline.resize();
  overtakeList = new OvertakeList($("otList"), $("otNote"), race, selectEvent);
  $("otCount").textContent = `(${overtakeList.count})`;
  telemetryPanel = new TelemetryPanel($("tCards"), $("speedChart"), race, state.telemetry);
  focusPanel = new FocusPanel($("focusPanel"), race, state.telemetry);
  messageFeed = new MessageFeed($("rcList"), $("rcFilters"), $("rcNote"), race, (m) => replay.seek(m.t - PRE_ROLL));
  $("rcCount").textContent = race.racecontrol ? `(${race.racecontrol.length})` : "";
  raceTrace = new RaceTrace(
    { panel: $("tracePanel"), canvas: $("traceCanvas"), refSelect: $("traceRef"), rangeSelect: $("traceRange") },
    race, { onSeek: (t) => replay.seek(t), onToggle: toggleHighlight });
  raceTrace.close();
  $("traceBtn").disabled = !raceTrace.available;
  $("traceBtn").classList.remove("active");
  $("traceBtn").title = raceTrace.available ? "Gap of every driver after every lap"
                                            : "This race was exported without race trace data: run the export again";
  highlights = new Highlights(race);
  setHighlightsMode(false);
  miniSectors = race.minisectors ? new MiniSectors(race.minisectors, race) : null;
  sectors = race.sectors ? new Sectors(race.sectors, race) : null;
  weatherBadge = new WeatherBadge($("weather"), race.weather);
  state.battle = null;
  battleList = new BattleList($("btList"), $("btNote"), race, selectBattle);
  $("btCount").textContent = race.battles ? `(${battleList.count})` : "";
  if (radioList) radioList.stop();                       // a clip of the previous race may still be playing
  radioList = new RadioList($("rdList"), $("rdFilters"), $("rdNote"), race, (c) => replay.seek(c.t - PRE_ROLL));
  $("rdCount").textContent = race.teamradio ? `(${radioList.count})` : "";
  compare = new Compare({
    box: $("cmpBox"), on: $("cmpOn"), a: $("cmpA"), b: $("cmpB"), lap: $("cmpLap"), info: $("cmpInfo"),
    speedCanvas: $("cmpSpeed"), deltaCanvas: $("cmpDelta"),
  }, race, state.telemetry);
  $("cmpOn").checked = false;
  $("chartBox").hidden = false;

  $("scrubber").max = replay.duration;
  $("playBtn").textContent = "Play";
  $("lapTotal").textContent = race.meta.totalLaps;
  shown = {};

  const lapSelect = $("lapSelect");
  lapSelect.innerHTML = "";
  const miniLap = $("miniLap");
  miniLap.innerHTML = "";
  miniLap.add(new Option("Follow replay", "follow"));
  for (let lap = 1; lap <= race.meta.totalLaps; lap++) {
    lapSelect.add(new Option(lap, lap));
    miniLap.add(new Option(`Lap ${lap}`, lap));
  }
  state.miniLapChoice = "follow";
  $("miniBtn").disabled = miniSectors === null;
  $("miniBtn").title = miniSectors ? "Colour the track by the fastest driver in each of 25 mini-sectors"
                                   : "This race was exported without mini-sectors: run the export again";
  $("secBtn").disabled = sectors === null;
  $("secBtn").title = sectors ? "The 3 official sectors, coloured like the TV timing: purple = best so far, green = personal best, yellow = slower"
                              : "This race was exported without sectors: run the export again";
  const secDriver = $("secDriver");
  secDriver.length = 1;                                  // keep "Fastest in lap"
  for (const d of race.meta.drivers) {
    if (d.status !== "DNS") secDriver.add(new Option(`${d.abbr} - ${d.name}`, d.abbr));
  }
  state.sectorsOn = false;
  setMini(false);

  const focusSelect = $("focusSelect");
  focusSelect.length = 1;                      // keep "Off"
  for (const d of race.meta.drivers) {
    if (d.status !== "DNS") focusSelect.add(new Option(`${d.abbr} - ${d.name}`, d.abbr));
  }

  // Personal start-up settings: speed, focus zoom, favourite drivers.
  setSpeed(settings.values.defaultSpeed);
  state.zoomMetres = settings.values.defaultZoom;
  $("zoomSelect").value = String(state.zoomMetres);
  highlightFavorites();
  refreshOvertakeList();
  updateLegend();
}

// Highlights the favourite drivers from the settings (those that are in this race).
function highlightFavorites() {
  const present = new Set(replay.race.meta.drivers.filter((d) => d.status !== "DNS").map((d) => d.abbr));
  for (const abbr of settings.values.favorites) {
    if (present.has(abbr)) highlight(abbr);
  }
}

function setSpeed(speed) {
  replay.speed = speed;
  document.querySelectorAll("#speedBtns button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.speed) === speed);
  });
}

// requestAnimationFrame calls this before every screen repaint (~60 times/s).
// `now` is a timestamp in milliseconds; we use the difference between frames
// so the replay speed does not depend on the monitor refresh rate.
function frame(now) {
  // Schedule the next frame FIRST: if something below throws, the animation keeps running
  // instead of freezing the whole page. The error is shown in the red bar.
  requestAnimationFrame(frame);
  const dt = lastFrame === null ? 0 : (now - lastFrame) / 1000;
  lastFrame = now;
  if (!replay) return;
  try {
    replay.tick(dt);

    state.options = settings.values;
    state.focus = state.focusAbbr ? neighbours(replay.race, retiredAt, state.focusAbbr, replay.time) : null;
    const miniLap = !(state.miniOn || state.sectorsOn) ? null      // the lap shown by mini-sectors or sectors
      : state.miniLapChoice === "follow" ? replay.currentLap() : Number(state.miniLapChoice);
    state.mini = miniLap && state.miniOn ? { data: miniSectors, lap: miniLap } : null;
    state.sectors = miniLap && state.sectorsOn ? { data: sectors, lap: miniLap, driver: $("secDriver").value } : null;
    state.action = state.highlightsOn && state.hlZoom ? highlights.actionAt(replay.time) : null;
    state.battleLinks = battleList.linesAt(replay.time, state.battle, state.battleLines);

    map.draw(replay, state, dt);
    leaderboard.update(replay, state.highlighted);
    timeline.draw(replay.time, state.selected);
    focusPanel.update(replay, state.focus);
    if (state.highlightsOn) {
      highlights.build(timeline.hidden, state.highlighted, state.hlOnlyHighlighted);
      highlights.update(replay);
    }
    if (isOpen("messages")) messageFeed.update(replay);
    if (isOpen("battles")) battleList.update(replay.time, state.battle, state.highlighted, state.btOnlyHighlighted);
    if (isOpen("radio")) radioList.update(replay.time, state.highlighted);
    if (isOpen("telemetry")) compare.update(replay);
    weatherBadge.update(replay.time);
    if (!$("tracePanel").hidden) raceTrace.update(replay.time);
    telemetryPanel.update(replay, [...state.highlighted], isOpen("telemetry"));
    updateControls(miniLap);
  } catch (err) {
    console.error(err);
    showError(`Drawing error: ${err.message}`);
  }
}

const STATUS_TEXT = { sc: "SAFETY CAR", vsc: "VIRTUAL SAFETY CAR", yellow: "YELLOW FLAG", red: "RED FLAG" };

function updateControls(miniLap) {
  $("scrubber").value = replay.time;
  $("timeLabel").textContent = formatTime(replay.time);
  $("lapSelect").value = replay.currentLap();
  if (state.highlightsOn) {
    const info = highlights.describe();
    $("hlCounter").textContent = info.counter;
    $("hlText").textContent = info.text;
  }
  $("hlOnly").disabled = state.highlighted.size === 0;     // nothing to filter by until a driver is highlighted
  $("hlOnlyLabel").classList.toggle("off", state.highlighted.size === 0);
  $("playBtn").textContent = replay.playing ? "Pause" : "Play";

  // Lap counter (top left of the map): the leader's lap.
  const lap = replay.currentLap();
  if (shown.lap !== lap) {
    $("lapNow").textContent = lap;
    shown.lap = lap;
  }
  const status = trackStatus(replay.race.events, replay.time);
  if (shown.status !== status) {
    const badge = $("statusBadge");
    badge.hidden = status === null;
    badge.className = status || "";
    badge.textContent = status ? STATUS_TEXT[status] : "";
    shown.status = status;
  }
  // Mini-sector summary: only rewritten when the lap it describes changes.
  if (miniLap && state.miniOn && shown.mini !== miniLap) {
    $("miniPanel").innerHTML = miniSectors.summaryHtml(miniLap);
    shown.mini = miniLap;
  }
  // Same for the sector table (it also depends on the chosen driver).
  const sectorKey = miniLap && state.sectorsOn ? `${miniLap}|${$("secDriver").value}` : null;
  if (sectorKey && shown.sectors !== sectorKey) {
    $("secPanel").innerHTML = sectors.summaryHtml(miniLap, $("secDriver").value);
    shown.sectors = sectorKey;
  }
}

// Applies the settings to the page. Called at start and after every change of a setting.
function applySettings(changedKey) {
  applyToPage(settings.values);
  refreshThemeColors();
  if (changedKey === null || changedKey === "tabOrder") applyTabOrder();
  if (changedKey === null || changedKey === "floating") floating.applySaved();
  if (changedKey === null || changedKey === "units") {
    if (overtakeList) refreshOvertakeList();            // the list shows speed differences
  }
  if (changedKey === "favorites" && replay) {
    highlightFavorites();
    refreshOvertakeList();
    updateLegend();
  }
  // Panels appearing / disappearing change the size of the map and the timeline.
  setTimeout(() => { if (map) { map.resize(); timeline.resize(); } }, 0);
}

function setupSettings() {
  const panel = $("settings");
  const rebuild = () => buildSettingsForm($("settingsForm"), settings);
  rebuild();
  settings.onChange((key) => {
    applySettings(key);
    if (key === null) rebuild();                        // after a reset the inputs must show the defaults
  });
  $("settingsBtn").onclick = () => { panel.hidden = !panel.hidden; };
  $("settingsClose").onclick = () => { panel.hidden = true; };
  $("settingsReset").onclick = () => settings.reset();
  applySettings(null);
}

// Called when the Races panel finished an export: add the new races to the selector,
// keeping the race that is open now.
async function refreshRaceSelect() {
  const select = $("raceSelect");
  const current = select.value;
  select.replaceChildren();
  for (const r of await loadRaceList()) select.add(new Option(`${r.year} ${r.name}`, r.folder));
  select.value = current;
}

function setupControls() {
  $("playBtn").onclick = () => {
    if (state.highlightsOn) highlights.restartIfDone(replay);
    replay.playing = !replay.playing;
  };
  $("hlBtn").onclick = () => setHighlightsMode(!state.highlightsOn);
  $("hlPrev").onclick = () => highlights.jump(replay, -1);
  $("hlNext").onclick = () => highlights.jump(replay, +1);
  $("hlOnly").onchange = (e) => { state.hlOnlyHighlighted = e.target.checked; };
  $("hlZoom").onchange = (e) => { state.hlZoom = e.target.checked; };
  $("secBtn").onclick = () => setSectors(!state.sectorsOn);
  $("cmpOn").onchange = (e) => setCompare(e.target.checked);
  $("btLines").onchange = (e) => { state.battleLines = e.target.checked; };
  $("btOnlyHl").onchange = (e) => { state.btOnlyHighlighted = e.target.checked; battleList.key = null; };
  $("keysBtn").onclick = () => { $("keysHelp").hidden = !$("keysHelp").hidden; };
  $("keysClose").onclick = () => { $("keysHelp").hidden = true; };
  $("traceBtn").onclick = () => ($("tracePanel").hidden ? openTrace() : closeTrace());
  $("traceClose").onclick = () => closeTrace();

  for (const btn of document.querySelectorAll("#speedBtns button")) {
    btn.onclick = () => setSpeed(Number(btn.dataset.speed));
  }

  $("scrubber").oninput = (e) => replay.seek(Number(e.target.value));
  $("lapSelect").onchange = (e) => replay.seek(replay.lapStart(Number(e.target.value)));
  $("raceSelect").onchange = (e) => startRace(e.target.value);
  $("focusSelect").onchange = (e) => setFocus(e.target.value);
  $("zoomSelect").onchange = (e) => { state.zoomMetres = Number(e.target.value); };
  $("miniBtn").onclick = () => setMini(!state.miniOn);
  $("miniLap").onchange = (e) => { state.miniLapChoice = e.target.value; };
  // The map and the timeline must follow the size of their box: it changes with the window, but also
  // when a panel appears (settings) or the side tabs wrap to a second row. ResizeObserver tells us
  // every time the box changes size, whatever the reason.
  new ResizeObserver(() => { if (map) { map.resize(); timeline.resize(); } }).observe($("mapWrap"));

  // Highlight a driver by clicking his dot on the map.
  $("map").onclick = (e) => {
    const rect = $("map").getBoundingClientRect();
    const abbr = map.carAt(e.clientX - rect.left, e.clientY - rect.top);
    if (abbr) toggleHighlight(abbr);
  };

  setupKeys();
  setupTabDragging();

  // Sidebar tabs.
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.onclick = () => showTab(btn.dataset.tab);
  }
  $("otOnlyHl").onchange = (e) => { state.onlyHighlighted = e.target.checked; refreshOvertakeList(); };
}

// The side tabs can be dragged to another place; the order is saved in the settings (tabOrder).
const DEFAULT_TABS = [...document.querySelectorAll("#tabs button")].map((b) => b.dataset.tab);
const floating = new FloatingTabs({
  layer: $("floatLayer"), sidebar: $("sidebar"), bar: $("tabs"), settings,
  onLayout: () => showTab(currentTab),                    // a tab left or came back: refresh what the side panel shows
});

function applyTabOrder() {
  const bar = $("tabs");
  // Saved order first; tabs it does not mention (added later) follow in their default order.
  const wanted = [...settings.values.tabOrder, ...DEFAULT_TABS].filter((name, i, all) => all.indexOf(name) === i);
  for (const name of wanted) {
    const button = bar.querySelector(`button[data-tab="${name}"]`);
    if (button) bar.appendChild(button);                 // appending an existing child moves it to the end
  }
}

function setupTabDragging() {
  const bar = $("tabs");
  let dragged = null;
  const clearMarks = () => bar.querySelectorAll("button").forEach((b) => b.classList.remove("dropBefore", "dropAfter"));
  // Is the mouse in the left half of the button? Then the dragged tab goes before it, else after it.
  const isBefore = (e, button) => e.clientX < button.getBoundingClientRect().left + button.offsetWidth / 2;

  for (const button of bar.querySelectorAll("button")) {
    button.draggable = true;
    button.title = "Drag to move this tab. Drop it on the map to make a floating window (or double-click it).";
  }
  bar.addEventListener("dragstart", (e) => {
    dragged = e.target.closest("button");
    if (dragged) e.dataTransfer.setData("text/plain", dragged.dataset.tab);   // Firefox needs some data to start a drag
  });
  bar.addEventListener("dragover", (e) => {
    const over = e.target.closest("button");
    if (!dragged || !over || over === dragged) return;
    e.preventDefault();                                  // without this the browser does not allow a drop here
    clearMarks();
    over.classList.add(isBefore(e, over) ? "dropBefore" : "dropAfter");
  });
  bar.addEventListener("drop", (e) => {
    const over = e.target.closest("button");
    if (!dragged || !over || over === dragged) return;
    e.preventDefault();
    bar.insertBefore(dragged, isBefore(e, over) ? over : over.nextSibling);
    settings.set("tabOrder", [...bar.children].map((b) => b.dataset.tab));
  });
  bar.addEventListener("dragend", () => { dragged = null; clearMarks(); });

  // Dropped anywhere outside the side panel (e.g. on the map): the tab becomes a floating window.
  document.addEventListener("dragover", (e) => {
    if (dragged && !e.target.closest("#sidebar")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!dragged || e.target.closest("#sidebar")) return;
    e.preventDefault();
    floating.float(dragged.dataset.tab, { x: e.clientX - 30, y: e.clientY - 14 });
  });
  bar.addEventListener("dblclick", (e) => {
    const button = e.target.closest("button");
    if (button) floating.float(button.dataset.tab, { x: 60 + 30 * floating.windows.size, y: 70 + 30 * floating.windows.size });
  });
}

// Keyboard shortcuts (the list is in the "Keys" panel of the header).
function setupKeys() {
  const SPEEDS = { 1: 1, 2: 2, 3: 5, 4: 10 };
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Do not steal the keys from menus and text boxes (arrows change a menu, letters are typed).
    const tag = e.target.tagName;
    const typing = tag === "TEXTAREA" || tag === "SELECT" ||
      (tag === "INPUT" && !["range", "checkbox", "button"].includes(e.target.type));
    if (typing) return;

    if (e.key === "Escape") {
      $("settings").hidden = true;
      $("keysHelp").hidden = true;
      closeTrace();
      if (state.selected) { state.selected = null; refreshOvertakeList(); }
      return;
    }
    if (!replay) return;

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const clips = state.highlightsOn;
    let handled = true;
    if (key === " ") {
      if (state.highlightsOn) highlights.restartIfDone(replay);
      replay.playing = !replay.playing;
    } else if (key === "ArrowLeft") replay.seek(replay.time - (e.shiftKey ? 30 : 5));
    else if (key === "ArrowRight") replay.seek(replay.time + (e.shiftKey ? 30 : 5));
    else if (key === "[" || key === "]") {
      const step = key === "[" ? -1 : 1;
      if (clips) {
        highlights.jump(replay, step);
      } else {
        // "[" first goes back to the start of the lap in progress (if it started more than 3 s ago).
        const lap = replay.currentLap();
        const here = replay.lapStart(lap);
        const target = step > 0 ? lap + 1 : (replay.time - here > 3 ? lap : lap - 1);
        if (target >= 1 && target <= replay.race.meta.totalLaps) replay.seek(replay.lapStart(target));
      }
    } else if (key === "f") {
      if (state.focusAbbr) {
        setFocus(null);
      } else {
        const leader = replay.race.meta.drivers.find((d) => stepValue(replay.race.standings.position[d.abbr], replay.time) === 1);
        setFocus([...state.highlighted][0] || (leader && leader.abbr));
      }
    } else if (key in SPEEDS) setSpeed(SPEEDS[key]);
    else if (key === "h") setHighlightsMode(!state.highlightsOn);
    else if (key === "t") { if (raceTrace.available) ($("tracePanel").hidden ? openTrace() : closeTrace()); }
    else if (key === "s") setSectors(!state.sectorsOn);
    else if (key === "m") setMini(!state.miniOn);
    else if (key === "?") $("keysHelp").hidden = !$("keysHelp").hidden;
    else handled = false;
    if (handled) e.preventDefault();            // e.g. Space must not scroll the page or press a button
  });
  // A button that has the focus is pressed by Space when the key is released: not wanted here.
  document.addEventListener("keyup", (e) => {
    if (e.key === " " && e.target.tagName === "BUTTON") e.preventDefault();
  });
}

// A tab in a floating window is always open; the others are open when they are the chosen side tab.
function isOpen(name) {
  return currentTab === name || floating.isFloating(name);
}

function showTab(name) {
  if (!document.getElementById(`tab-${name}`)) name = "leaderboard";   // e.g. a wrong ?tab= in the address
  if (floating.isFloating(name)) {
    floating.bringToFront(name);
    // The side panel keeps its tab, unless that one is in a window too: then it takes the first tab left.
    name = floating.isFloating(currentTab) ? DEFAULT_TABS.find((t) => !floating.isFloating(t)) : currentTab;
  }
  currentTab = name || null;                              // null: every tab is in a window
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.classList.toggle("active", btn.dataset.tab === name);
  }
  for (const tab of DEFAULT_TABS) {
    if (!floating.isFloating(tab)) $(`tab-${tab}`).hidden = name !== tab;
  }
  $("sidebar").classList.toggle("empty", !name);          // no tab left: the map takes the whole width
}

async function init() {
  setupControls();
  setupSettings();
  const manager = setupManager({ onRacesChanged: refreshRaceSelect });
  const races = await loadRaceList();
  const select = $("raceSelect");
  for (const r of races) select.add(new Option(`${r.year} ${r.name}`, r.folder));

  // Optional deep link, e.g.
  //   /web/?race=2026_australian-grand-prix&t=600&hl=VER,NOR&tab=telemetry&focus=VER&zoom=close
  //   /web/?race=2025_italian-grand-prix&mini=1&minilap=12
//   /web/?panel=races   (opens the Races panel)
  // `trace=1` opens the race trace, `highlights=1` starts the Highlights mode (tab=messages: the messages tab)
  // `ot=5` selects the 6th overtake of the list; `mini=1` switches the mini-sectors on.
  // `sectors=1&secdriver=VER&minilap=12` shows the sectors; `compare=1&hl=VER,NOR&tab=telemetry` the comparison;
  // tab=battles / radio / messages open those tabs.
  const params = new URLSearchParams(location.search);
  if (params.get("panel") === "races") manager.open();
  const wanted = races.find((r) => r.folder === params.get("race")) || races[0];
  if (wanted) {
    select.value = wanted.folder;
    await startRace(wanted.folder);
    showTab(params.get("tab") || settings.values.defaultTab);
    replay.seek(Number(params.get("t")) || 0);
    for (const abbr of (params.get("hl") || "").split(",").filter(Boolean)) {
      if (!state.highlighted.has(abbr)) highlight(abbr);
    }
    const index = Number(params.get("ot"));
    if (params.has("ot") && overtakeList.overtakes[index]) state.selected = overtakeList.overtakes[index];
    if (params.get("zoom") in ZOOMS) {
      state.zoomMetres = ZOOMS[params.get("zoom")];
      $("zoomSelect").value = String(state.zoomMetres);
    }
    if (params.get("focus")) {
      setFocus(params.get("focus"));
      // Start already zoomed in, instead of animating from the overview.
      map.updateCamera(100, replay.positionOf(state.focusAbbr), state.zoomMetres);
    }
    if (params.get("trace") === "1" && raceTrace.available) openTrace();
    if (params.get("compare") === "1") setCompare(true);
    if (params.get("highlights") === "1") setHighlightsMode(true);
    if (params.get("mini") === "1") {
      setMini(true);
      if (params.has("minilap")) {
        state.miniLapChoice = params.get("minilap");
        $("miniLap").value = params.get("minilap");
      }
    }
    if (params.get("sectors") === "1") {
      setSectors(true);
      if (params.has("secdriver")) $("secDriver").value = params.get("secdriver");
      if (params.has("minilap")) {
        state.miniLapChoice = params.get("minilap");
        $("miniLap").value = params.get("minilap");
      }
    }
    refreshOvertakeList();
    updateLegend();
  }
  requestAnimationFrame(frame);
}

init().catch((err) => {
  document.querySelector("main").textContent =
    `Error: ${err.message}. Did you run the export script and start the server from the project root?`;
});
