// Live telemetry of the highlighted drivers: loading, sampling, the cards and the speed graph.
import { countUpTo } from "./replay.js";
import { esc, speedFromKmh, speedUnitLabel } from "./util.js";
import { colors } from "./theme.js";

const THROTTLE_ON = 20;   // % throttle from which we say the driver is "accelerating"

// Colours of the trace drawn on the map, and of the legend.
export const STATE_COLORS = { throttle: "#2ecc40", brake: "#ff3b3b", coast: "#ffdc00" };

// What the driver is doing at sample i: braking, accelerating or coasting (neither pedal).
export function driveState(tel, i) {
  if (tel.brake[i]) return "brake";
  return tel.throttle[i] >= THROTTLE_ON ? "throttle" : "coast";
}

// Downloads the telemetry file of a driver the first time it is needed (about 190 KB each),
// so the page does not have to load 20 drivers when you only look at one.
export class TelemetryStore {
  constructor(folder) {
    this.base = `../data/${folder}/telemetry`;
    this.data = new Map();      // abbr -> telemetry, or null when the file does not exist
    this.requested = new Set();
  }

  request(abbr) {
    if (this.requested.has(abbr)) return;
    this.requested.add(abbr);
    fetch(`${this.base}/${abbr}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => this.data.set(abbr, json));
  }

  get(abbr) {
    return this.data.get(abbr) || null;
  }

  isLoading(abbr) {
    return this.requested.has(abbr) && !this.data.has(abbr);
  }
}

/*
 * Telemetry values at an exact time. Speed and throttle are interpolated between the two
 * neighbouring samples (same idea as the car positions, see replay.js); gear and brake are
 * not smooth quantities, so they keep the value of the last sample.
 */
export function sampleAt(tel, time) {
  const last = tel.speed.length - 1;
  const exact = Math.max(time, 0) / tel.step;
  const i0 = Math.min(Math.floor(exact), last);
  const i1 = Math.min(i0 + 1, last);
  const f = exact - i0;
  return {
    speed: tel.speed[i0] + (tel.speed[i1] - tel.speed[i0]) * f,
    throttle: tel.throttle[i0] + (tel.throttle[i1] - tel.throttle[i0]) * f,
    brake: tel.brake[i0] === 1,
    gear: tel.gear[i0],
  };
}

// The numbers and bars of one driver (used by the telemetry tab and by the focus panel).
export function statsHtml(sample) {
  const throttle = Math.round(sample.throttle);
  return `
    <div class="tmain">
      <div class="tspeed"><b>${Math.round(speedFromKmh(sample.speed))}</b><small>${speedUnitLabel()}</small></div>
      <div class="tgear"><small>GEAR</small><b>${sample.gear > 0 ? sample.gear : "N"}</b></div>
    </div>
    <div class="tbar"><span>THR</span><div class="bar"><i class="thr" style="width:${throttle}%"></i></div><em>${throttle}%</em></div>
    <div class="tbar"><span>BRK</span><div class="bar"><i class="brk" style="width:${sample.brake ? 100 : 0}%"></i></div><em>${sample.brake ? "ON" : "-"}</em></div>`;
}

const UPDATE_EVERY_MS = 70;      // the numbers do not need 60 updates per second
const CHART_EVERY_MS = 120;
const DASHES = [[], [8, 4], [2, 3], [10, 3, 2, 3]];   // line styles, so teammates (same colour) can be told apart

export class TelemetryPanel {
  constructor(cardsEl, canvas, race, store) {
    this.cardsEl = cardsEl;
    this.canvas = canvas;
    this.race = race;
    this.store = store;
    this.drivers = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d]));
    this.chart = null;
    this.layout = "";           // which (driver, lap) pairs the chart currently shows
    this.laps = new Map();      // cache: "VER:12" -> the points of that lap
    this.lastCards = 0;
    this.lastChart = 0;
    this.lastHtml = "";
  }

  // Speed against distance for one lap of one driver. Distance is not in the data, so we
  // add up speed * time: a car at 180 km/h (= 50 m/s) covers 12.5 m in a 0.25 s sample.
  lapPoints(abbr, lap) {
    const key = `${abbr}:${lap}:${speedUnitLabel()}`;     // the unit is part of the key: mph or km/h values
    if (this.laps.has(key)) return this.laps.get(key);

    const tel = this.store.get(abbr);
    const laps = this.race.strategy.drivers[abbr].laps;
    const start = laps[lap - 1];
    const end = lap < laps.length ? laps[lap] : this.race.meta.duration;
    const first = Math.max(Math.ceil(start / tel.step), 0);
    const last = Math.min(Math.floor(end / tel.step), tel.speed.length - 1);

    const points = [];
    let distance = 0;
    for (let i = first; i <= last; i++) {
      if (i > first) distance += (tel.speed[i] / 3.6) * tel.step;
      points.push({ x: Math.round(distance), y: Math.round(speedFromKmh(tel.speed[i])) });
    }
    const lapData = { first, points };
    this.laps.set(key, lapData);
    return lapData;
  }

  currentLap(abbr, time) {
    return Math.max(countUpTo(this.race.strategy.drivers[abbr].laps, time), 1);
  }

  createChart() {
    if (typeof Chart === "undefined") return null;       // Chart.js did not load
    Chart.getChart(this.canvas)?.destroy();              // a race that was open before left its chart here
    return new Chart(this.canvas, {
      type: "line",
      data: { datasets: [] },
      options: {
        animation: false,                  // we redraw several times per second: no animation
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,                    // our data is already in {x, y} form
        scales: {
          x: { type: "linear", min: 0, title: { display: true, text: "Distance in the lap (m)" } },
          y: { min: 0, max: 360, title: { display: true, text: "Speed (km/h)" } },
        },
        plugins: {
          // The faint "whole lap" lines are only context: keep them out of the legend.
          legend: { labels: { filter: (item) => !item.text.endsWith("(lap)") } },
        },
      },
    });
  }

  // drivers: abbreviations of the highlighted drivers; visible: is the telemetry tab shown?
  update(replay, drivers, visible) {
    if (!visible) return;
    const now = performance.now();
    if (now - this.lastCards >= UPDATE_EVERY_MS) {
      this.lastCards = now;
      this.updateCards(replay.time, drivers);
    }
    if (now - this.lastChart >= CHART_EVERY_MS) {
      this.lastChart = now;
      this.updateChart(replay.time, drivers);
    }
  }

  updateCards(time, drivers) {
    const html = drivers.map((abbr) => {
      const d = this.drivers[abbr];
      const tel = this.store.get(abbr);
      let body = "<p class='tnote'>Loading telemetry...</p>";
      if (!this.store.isLoading(abbr) && !tel) body = "<p class='tnote'>No telemetry for this driver.</p>";
      if (tel) body = statsHtml(sampleAt(tel, time));
      return `<div class="tcard" style="border-color:${esc(d.color)}">
        <div class="thead"><b>${esc(abbr)}</b><span>${esc(d.name)} - lap ${this.currentLap(abbr, time)}</span></div>${body}</div>`;
    }).join("") || "<p class='tnote'>Click a driver in the leaderboard or on the map to see his telemetry here.</p>";
    if (html !== this.lastHtml) {
      this.cardsEl.innerHTML = html;
      this.lastHtml = html;
    }
  }

  updateChart(time, drivers) {
    if (!this.chart) this.chart = this.createChart();
    if (!this.chart) return;

    const loaded = drivers.filter((abbr) => this.store.get(abbr));
    const layout = speedUnitLabel() + "|" + loaded.map((abbr) => `${abbr}:${this.currentLap(abbr, time)}`).join(",");
    const datasets = this.chart.data.datasets;
    // The vertical axis follows the chosen unit, the colours follow the theme.
    const { x, y } = this.chart.options.scales;
    y.max = Math.round(speedFromKmh(360));
    y.title.text = `Speed (${speedUnitLabel()})`;
    for (const axis of [x, y]) {
      axis.ticks = { ...axis.ticks, color: colors.muted };
      axis.grid = { ...axis.grid, color: colors.lane };
      axis.title.color = colors.muted;
    }
    this.chart.options.plugins.legend.labels.color = colors.text;

    if (layout !== this.layout) {        // another driver or another lap: rebuild the lines
      this.layout = layout;
      datasets.length = 0;
      loaded.forEach((abbr, k) => {
        const color = this.drivers[abbr].color;
        const lap = this.currentLap(abbr, time);
        const dash = DASHES[k % DASHES.length];
        const base = { pointRadius: 0, tension: 0, borderDash: dash };
        const { points } = this.lapPoints(abbr, lap);
        // Faint line: the whole lap, for context. Bright line: what has happened so far.
        datasets.push({ ...base, label: `${abbr} (lap)`, data: points, borderColor: color + "55", borderWidth: 1 });
        datasets.push({ ...base, label: `${abbr} lap ${lap}`, data: [], borderColor: color, borderWidth: 2.5 });
      });
    }

    loaded.forEach((abbr, k) => {
      const tel = this.store.get(abbr);
      const { first, points } = this.lapPoints(abbr, this.currentLap(abbr, time));
      const reached = Math.floor(time / tel.step) - first + 1;
      datasets[2 * k + 1].data = points.slice(0, Math.max(0, Math.min(reached, points.length)));
    });
    this.chart.update("none");
  }
}
