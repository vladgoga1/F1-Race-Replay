// The three official timing sectors (S1, S2, S3), coloured like on the TV timing screens:
//   purple = the best time anybody has set in that sector so far in the race
//   green  = the driver's own best so far
//   yellow = slower than his own best
// "So far" means at the moment the driver finished the sector, so a sector that was purple
// at the time stays purple even if somebody went faster later.
// The other mode, "Fastest in lap", colours each sector in the team colour of whoever was fastest
// in it during the chosen lap (like the mini-sectors, only with 3 pieces).
import { esc } from "./util.js";

export const SECTOR_COLORS = { purple: "#b44cf0", green: "#2ecc40", yellow: "#ffdc00" };
const PLAUSIBLE_FRACTION = 0.6;   // a time under 60% of the median is a measuring glitch, not a record

export function formatSeconds(s) {
  if (s === null || s === undefined) return "-";
  const minutes = Math.floor(s / 60);
  return minutes > 0 ? `${minutes}:${(s - minutes * 60).toFixed(3).padStart(6, "0")}` : s.toFixed(3);
}

export class Sectors {
  constructor(data, race) {
    this.data = data;                // { pieces, marks, times, length } from sectors.json
    this.race = race;
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.names = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.name]));
    this.classes = new Map();        // "VER:11:0" (driver, lap index, sector) -> "purple" | "green" | "yellow"
    this.fastestCache = new Map();   // lap index -> the fastest driver of each sector
    this.classify();
  }

  // Goes through every sector time in the order in which they were set and decides its colour.
  classify() {
    const entries = [];
    for (const [abbr, laps] of Object.entries(this.data.times)) {
      const starts = this.race.strategy.drivers[abbr]?.laps;
      if (!starts) continue;
      laps.forEach((sectors, lapIndex) => {
        if (lapIndex === 0) return;                 // lap 1 is a standing start: not comparable
        let clock = starts[lapIndex];               // moment the driver finishes the sector
        sectors.forEach((time, k) => {
          if (time === null) return;
          clock += time;
          entries.push({ abbr, lapIndex, k, time, clock });
        });
      });
    }
    // Median of each sector, to throw away glitches.
    const median = [0, 1, 2].map((k) => {
      const times = entries.filter((e) => e.k === k).map((e) => e.time).sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)] || 0;
    });

    const overall = [Infinity, Infinity, Infinity];
    const personal = {};
    for (const e of entries.sort((a, b) => a.clock - b.clock)) {
      if (e.time < median[e.k] * PLAUSIBLE_FRACTION) continue;
      const own = (personal[e.abbr] ??= [Infinity, Infinity, Infinity]);
      let kind = "yellow";
      if (e.time < overall[e.k]) kind = "purple";
      else if (e.time < own[e.k]) kind = "green";
      overall[e.k] = Math.min(overall[e.k], e.time);
      own[e.k] = Math.min(own[e.k], e.time);
      this.classes.set(`${e.abbr}:${e.lapIndex}:${e.k}`, kind);
    }
  }

  // Colour names and times of one driver in one lap (lap = 1 for the first lap).
  driverLap(abbr, lap) {
    const times = this.data.times[abbr]?.[lap - 1] || [null, null, null];
    return times.map((time, k) => ({ time, kind: this.classes.get(`${abbr}:${lap - 1}:${k}`) || null }));
  }

  // The fastest driver of each sector in a lap: [{ abbr, time } or null, x3].
  fastest(lap) {
    if (this.fastestCache.has(lap)) return this.fastestCache.get(lap);
    const result = [0, 1, 2].map((k) => {
      let best = null;
      for (const [abbr, laps] of Object.entries(this.data.times)) {
        const time = laps[lap - 1]?.[k];
        if (time === null || time === undefined) continue;
        if (best === null || time < best.time) best = { abbr, time };
      }
      return best;
    });
    this.fastestCache.set(lap, result);
    return result;
  }

  // The little table on the map. driver = abbreviation, or "" for "Fastest in lap".
  summaryHtml(lap, driver) {
    const best = this.fastest(lap);
    const rows = [0, 1, 2].map((k) => {
      if (driver) {
        const { time, kind } = this.driverLap(driver, lap)[k];
        const delta = time !== null && best[k] ? `+${(time - best[k].time).toFixed(3)}` : "";
        const chip = kind ? SECTOR_COLORS[kind] : "var(--control)";
        return `<div class="secRow"><i style="background:${chip}"></i>S${k + 1}<b>${formatSeconds(time)}</b><span>${delta}</span></div>`;
      }
      const winner = best[k];
      return winner
        ? `<div class="secRow"><i style="background:${esc(this.colors[winner.abbr])}"></i>S${k + 1} ${esc(winner.abbr)}<b>${formatSeconds(winner.time)}</b></div>`
        : `<div class="secRow"><i></i>S${k + 1}<b>-</b></div>`;
    });
    let total = "";
    if (driver) {
      const times = this.driverLap(driver, lap).map((s) => s.time);
      if (times.every((t) => t !== null)) total = `<div class="secRow total">Lap<b>${formatSeconds(times.reduce((a, b) => a + b, 0))}</b></div>`;
    }
    const title = driver
      ? `Sectors - lap ${lap} - <span style="color:${esc(this.colors[driver])}">${esc(driver)}</span>`
      : `Sectors - lap ${lap} - fastest`;
    const legend = driver
      ? `<div class="secLegend"><i style="background:${SECTOR_COLORS.purple}"></i>best so far
         <i style="background:${SECTOR_COLORS.green}"></i>his best <i style="background:${SECTOR_COLORS.yellow}"></i>slower</div>`
      : `<div class="secLegend">Team colour = fastest driver in that sector.</div>`;
    return `<h3>${title}</h3>${rows.join("")}${total}${legend}`;
  }
}
