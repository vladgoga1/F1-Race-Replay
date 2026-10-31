// Live leaderboard panel: position, driver, gap to the car ahead, tyre and pit stops.
import { countUpTo, stepValue } from "./replay.js";
import { esc, retirementTimes } from "./util.js";

// Tyre colours as on TV. Letters: S oft, M edium, H ard, I ntermediate, W et.
const TYRES = {
  SOFT: { letter: "S", color: "#ff3b3b" },
  MEDIUM: { letter: "M", color: "#ffd12e" },
  HARD: { letter: "H", color: "#f2f2f2" },
  INTERMEDIATE: { letter: "I", color: "#39b54a" },
  WET: { letter: "W", color: "#2f7bff" },
};
const UNKNOWN_TYRE = { letter: "?", color: "#666" };

export class Leaderboard {
  // onToggle(abbr) is called when a row is clicked (used to highlight a driver).
  constructor(container, race, onToggle) {
    this.container = container;
    this.race = race;
    this.lastHtml = "";

    // When did each retired driver stop? (from the "dnf" timeline events)
    this.retiredAt = retirementTimes(race.events);

    // One click handler for the whole table ("event delegation"): the rows are rebuilt all the
    // time, so instead of attaching a handler to every row we handle the click here and look
    // at which row it came from.
    container.onclick = (e) => {
      const row = e.target.closest("tr[data-abbr]");
      if (row) onToggle(row.dataset.abbr);
    };
  }

  // "+0.4" for a gap in seconds, "+1 LAP" text for lapped cars, "-" when unknown.
  formatGap(position, gap) {
    if (position === 1) return "Leader";
    if (gap === null || gap === undefined) return "-";
    if (typeof gap === "number") return `+${gap.toFixed(1)}`;
    return esc(gap);
  }

  // Tyre of one driver at the current time.
  tyreInfo(abbr, time) {
    const strategy = this.race.strategy.drivers[abbr];
    if (!strategy || strategy.stints.length === 0) return { tyre: UNKNOWN_TYRE, age: null, pits: 0 };

    // Current stint = the last one that started at or before now (stints are in time order).
    let stint = strategy.stints[0];
    for (const s of strategy.stints) {
      if (s.t <= time) stint = s;
    }

    // Current lap of this driver = number of lap starts that have already happened.
    const lap = Math.max(countUpTo(strategy.laps, time), 1);
    // Laps on this set: laps it already had + laps since it was fitted (the lap it was
    // fitted on counts as 1).
    const age = stint.age + lap - stint.startLap + 1;

    return {
      tyre: TYRES[stint.compound] || UNKNOWN_TYRE,
      age,
      pits: countUpTo(strategy.pits, time),
    };
  }

  // Called every frame. Rebuilding the HTML 60 times per second would be wasteful, and the
  // text only changes about once per second, so we build the string every frame (cheap) and
  // touch the page only when it differs from the previous one.
  update(replay, highlighted) {
    const time = replay.time;
    const rows = [];
    for (const d of this.race.meta.drivers) {
      const position = stepValue(this.race.standings.position[d.abbr], time);
      if (position === null) continue;   // driver not in the race data
      const gap = stepValue(this.race.standings.interval[d.abbr], time);
      rows.push({ d, position, gap, ...this.tyreInfo(d.abbr, time) });
    }
    rows.sort((a, b) => a.position - b.position);

    const html = rows.map((r) => {
      const color = /^#[0-9a-f]{6}$/i.test(r.d.color) ? r.d.color : "#888888";
      const didNotStart = r.d.status === "DNS";
      const retired = r.d.abbr in this.retiredAt && time >= this.retiredAt[r.d.abbr];
      const gapCell = didNotStart ? "DNS" : retired ? "OUT" : this.formatGap(r.position, r.gap);
      const tyreCell = didNotStart ? "" :
        `<span class="tyreIcon" style="border-color:${r.tyre.color};color:${r.tyre.color}">${r.tyre.letter}</span>${r.age === null ? "" : r.age}`;
      const classes = [didNotStart || retired ? "dns" : "", highlighted.has(r.d.abbr) ? "hl" : ""].join(" ");
      return `<tr class="${classes}" data-abbr="${esc(r.d.abbr)}">
        <td class="pos">${r.position}</td>
        <td class="drv"><span class="team" style="background:${color}"></span>${esc(r.d.abbr)}</td>
        <td class="gap">${gapCell}</td>
        <td class="tyre">${tyreCell}</td>
        <td class="pits">${didNotStart ? "" : r.pits}</td>
      </tr>`;
    }).join("");

    if (html !== this.lastHtml) {
      this.container.innerHTML =
        `<thead><tr><th>P</th><th>Driver</th><th>Gap</th><th>Tyre</th><th>Pits</th></tr></thead><tbody>${html}</tbody>`;
      this.lastHtml = html;
    }
  }
}
