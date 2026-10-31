// Mini-sectors: the lap is cut into equal pieces and every piece of the track is coloured in
// the colour of the team of the driver who was fastest through it in the selected lap.
import { esc } from "./util.js";

// A piece time shorter than this fraction of the median of all drivers is a measuring glitch
// (a position sample that jumped), not a real record, so it is ignored.
const PLAUSIBLE_FRACTION = 0.6;

export class MiniSectors {
  constructor(data, race) {
    this.data = data;                    // { count, sectors, times } from minisectors.json
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.totalLaps = race.meta.totalLaps;
    this.cache = new Map();              // lap -> result, so we do the work once per lap
  }

  // Who was fastest in every mini-sector of `lap` (1 = first lap)?
  // Returns { winners: [abbr or null, ...], wins: { abbr: number of pieces won } }.
  analyse(lap) {
    if (this.cache.has(lap)) return this.cache.get(lap);

    const { count, times } = this.data;
    const winners = new Array(count).fill(null);
    const wins = {};

    for (let j = 0; j < count; j++) {
      const entries = [];
      for (const [abbr, laps] of Object.entries(times)) {
        const row = laps[lap - 1];
        if (row && row[j] !== null) entries.push({ abbr, time: row[j] });
      }
      if (entries.length === 0) continue;

      const sorted = entries.map((e) => e.time).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      let best = null;
      for (const e of entries) {
        if (e.time < median * PLAUSIBLE_FRACTION) continue;
        if (best === null || e.time < best.time) best = e;
      }
      if (best) {
        winners[j] = best.abbr;
        wins[best.abbr] = (wins[best.abbr] || 0) + 1;
      }
    }
    const result = { winners, wins };
    this.cache.set(lap, result);
    return result;
  }

  // The little table "who won how many pieces" shown on the map.
  summaryHtml(lap) {
    const { wins } = this.analyse(lap);
    const rows = Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([abbr, n]) =>
        `<div class="miniRow"><i style="background:${esc(this.colors[abbr])}"></i>${esc(abbr)}<span>${n} / ${this.data.count}</span></div>`)
      .join("");
    return `<h3>Mini-sectors - lap ${lap}</h3>
      <p>Each piece of the track has the colour of the fastest driver through it in this lap.</p>${rows || "<p>No data for this lap.</p>"}`;
  }
}
