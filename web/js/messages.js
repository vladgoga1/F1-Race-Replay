// "Messages" tab: the race director's messages (flags, investigations, penalties...) as a live feed.
import { countUpTo } from "./replay.js";
import { formatTime, esc } from "./util.js";

// What the checkboxes filter. `kinds` are the types written by python/export_racecontrol.py.
const GROUPS = [
  { id: "flags", label: "Flags and Safety Car", kinds: ["safety", "flag", "session"], on: true },
  { id: "incidents", label: "Incidents and penalties", kinds: ["incident", "penalty"], on: true },
  { id: "limits", label: "Track limits", kinds: ["limits"], on: false },
  { id: "drs", label: "DRS / Overtake Mode", kinds: ["drs"], on: false },
  { id: "info", label: "Other", kinds: ["info"], on: true },
];

// Colour of the stripe at the left of a message.
const FLAG_COLORS = { YELLOW: "#f5e642", "DOUBLE YELLOW": "#f5e642", RED: "#ff3b3b", GREEN: "#2ecc40",
                      BLUE: "#3aa0ff", CLEAR: "#2ecc40", CHEQUERED: "#ffffff" };
const KIND_COLORS = { safety: "#ff8c1a", penalty: "#ff6fb0", incident: "#b266ff", limits: "#8a8aa0",
                      drs: "#2dd4bf", session: "#ffffff", info: "#8a8aa0" };

function stripeColor(m) {
  return FLAG_COLORS[m.flag] || KIND_COLORS[m.kind] || "#8a8aa0";
}

export class MessageFeed {
  constructor(listEl, filtersEl, noteEl, race, onSelect) {
    this.listEl = listEl;
    this.race = race;
    this.messages = race.racecontrol || [];
    this.times = this.messages.map((m) => m.t);
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.groups = GROUPS.map((g) => ({ ...g }));
    this.onlyPast = true;              // hide messages that have not happened yet (no spoilers)
    this.lastKey = null;

    noteEl.textContent = race.racecontrol ? "" : "This race was exported without messages: export it again from the Races panel.";
    this.buildFilters(filtersEl);
    listEl.onclick = (e) => {
      const item = e.target.closest("li[data-index]");
      if (item) onSelect(this.messages[Number(item.dataset.index)]);
    };
  }

  buildFilters(box) {
    box.replaceChildren();
    const make = (label, checked, onchange) => {
      const l = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      input.onchange = () => { onchange(input.checked); this.lastKey = null; };
      l.append(input, ` ${label}`);
      box.appendChild(l);
    };
    for (const g of this.groups) make(g.label, g.on, (on) => { g.on = on; });
    make("Only what has happened so far", this.onlyPast, (on) => { this.onlyPast = on; });
  }

  // Count of messages that have happened by `time` (the list only changes when this changes).
  update(replay) {
    const past = countUpTo(this.times, replay.time);
    const key = `${this.onlyPast ? past : "all"}|${past}|${this.groups.map((g) => +g.on).join("")}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const shownKinds = new Set(this.groups.filter((g) => g.on).flatMap((g) => g.kinds));
    const starts = this.race.meta.lapStarts;
    const items = [];
    this.messages.forEach((m, index) => {
      if (!shownKinds.has(m.kind)) return;
      if (this.onlyPast && index >= past) return;
      const lap = Math.max(countUpTo(starts, m.t), 1);
      const when = m.t > this.race.meta.duration ? "after the race" : `Lap ${lap} · ${formatTime(m.t)}`;
      const future = index >= past ? " future" : "";
      // Driver abbreviations in the text get the colour of their team.
      const text = esc(m.text).replace(/\(([A-Z]{3})\)/g, (all, abbr) =>
        this.colors[abbr] ? `(<b style="color:${esc(this.colors[abbr])}">${abbr}</b>)` : all);
      items.push(`<li data-index="${index}" class="${future}" style="border-left-color:${stripeColor(m)}">
        <div class="rcWhen">${when}</div><div class="rcText">${text}</div></li>`);
    });
    // Newest first when we only show the past: the latest message is at the top, like a ticker.
    if (this.onlyPast) items.reverse();
    this.listEl.innerHTML = items.join("") || "<li class='empty'>No messages yet.</li>";
  }
}
