// Driver comparison (Telemetry tab): two drivers on the same lap, one over the other.
//   top chart:    speed against the distance in the lap, one line per driver
//   bottom chart: how far B is behind A (in seconds) at every point of the lap. Positive = B is
//                 behind (the line goes down, like in the race trace); the value at the right end
//                 is the difference of the two lap times.
//
// Telemetry has no distance, so (like the speed chart) we add up speed * time. That sum is a
// little off (about 1%), and differently for each driver, so each lap is stretched to the same
// length: the two cars then reach "the end of the lap" together and the lines can be compared.
import { countUpTo } from "./replay.js";
import { esc, speedFromKmh, speedUnitLabel } from "./util.js";
import { colors } from "./theme.js";
import { formatSeconds } from "./sectors.js";

const POINTS = 300;           // points of each line
const REFRESH_MS = 150;

export class Compare {
  // els: { box, on, a, b, lap, info, speedCanvas, deltaCanvas }
  constructor(els, race, store) {
    this.els = els;
    this.race = race;
    this.store = store;
    this.drivers = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d]));
    this.speedChart = null;
    this.deltaChart = null;
    this.key = null;
    this.result = null;           // the last computed comparison (see compute)
    this.lastRun = 0;
    this.nowFraction = null;      // where the replay is in the lap (0..1), for the white line

    const list = race.meta.drivers.filter((d) => d.status !== "DNS");
    for (const select of [els.a, els.b]) {
      select.replaceChildren();
      for (const d of list) select.add(new Option(`${d.abbr} - ${d.name}`, d.abbr));
    }
    els.lap.replaceChildren(new Option("Lap of A (follows the replay)", "follow"));
    for (let lap = 1; lap <= race.meta.totalLaps; lap++) els.lap.add(new Option(`Lap ${lap}`, lap));
    els.a.onchange = els.b.onchange = els.lap.onchange = () => { this.key = null; this.request(); };
  }

  get active() {
    return this.els.on.checked;
  }

  request() {
    this.store.request(this.els.a.value);
    this.store.request(this.els.b.value);
  }

  // Fills A and B from the highlighted drivers (first two) when switching the comparison on.
  suggest(highlighted) {
    const chosen = [...highlighted];
    const list = this.race.meta.drivers.filter((d) => d.status !== "DNS").map((d) => d.abbr);
    this.els.a.value = chosen[0] || list[0];
    this.els.b.value = chosen[1] || list.find((abbr) => abbr !== this.els.a.value);
    this.key = null;
    this.request();
  }

  // Start and duration of a lap. The official ones (sectors.json) are exact; the lap starts of the
  // page come from the position data and are only good to about half a second, which would show
  // up as a wrong difference between the drivers.
  lapWindow(abbr, lap) {
    const official = this.race.sectors?.laps?.[abbr]?.[lap - 1];
    if (official) return { start: official[0], duration: official[1] };
    const laps = this.race.strategy.drivers[abbr]?.laps;
    if (!laps || lap < 1 || lap > laps.length) return null;
    const end = lap < laps.length ? laps[lap] : this.race.meta.duration;
    return { start: laps[lap - 1], duration: end - laps[lap - 1] };
  }

  // Time (s since the start of the lap) and cumulative distance (m) at every telemetry sample of
  // one lap of one driver, plus the exact start and end of the lap.
  lapSamples(abbr, lap) {
    const tel = this.store.get(abbr);
    const window = this.lapWindow(abbr, lap);
    if (!tel || !window) return null;
    const { start, duration } = window;
    const first = Math.max(Math.ceil(start / tel.step), 0);
    const last = Math.min(Math.floor((start + duration) / tel.step), tel.speed.length - 1);
    if (last - first < 10) return null;

    // Points: the start of the lap, every sample inside the lap, the end of the lap. The speed of
    // a point is that of the nearest sample; the distance grows by speed * time between points.
    const time = [0], speed = [tel.speed[first]];
    for (let i = first; i <= last; i++) {
      time.push(i * tel.step - start);
      speed.push(tel.speed[i]);
    }
    time.push(duration);
    speed.push(tel.speed[last]);
    const distance = [0];
    for (let k = 1; k < time.length; k++) {
      distance.push(distance[k - 1] + (speed[k] / 3.6) * (time[k] - time[k - 1]));
    }
    return { time, distance, speed, total: distance[distance.length - 1], lapTime: duration };
  }

  // Value of `values` at each distance of `grid` (both rising): walks through both lists once.
  resample(distance, values, grid) {
    const out = [];
    let i = 0;
    for (const g of grid) {
      while (i < distance.length - 2 && distance[i + 1] < g) i++;
      const span = distance[i + 1] - distance[i] || 1;
      const f = Math.min(Math.max((g - distance[i]) / span, 0), 1);
      out.push(values[i] + (values[i + 1] - values[i]) * f);
    }
    return out;
  }

  compute(a, b, lap) {
    const sa = this.lapSamples(a, lap);
    const sb = this.lapSamples(b, lap);
    if (!sa || !sb) return null;
    // Fractions of the lap (0..1) mapped to each driver's own distance.
    const fractions = Array.from({ length: POINTS + 1 }, (_, j) => j / POINTS);
    const gridA = fractions.map((f) => f * sa.total);
    const gridB = fractions.map((f) => f * sb.total);
    const speedA = this.resample(sa.distance, sa.speed, gridA);
    const speedB = this.resample(sb.distance, sb.speed, gridB);
    const timeA = this.resample(sa.distance, sa.time, gridA);
    const timeB = this.resample(sb.distance, sb.time, gridB);
    const x = fractions.map((f) => Math.round(f * sa.total));       // metres, measured on A
    return { x, speedA, speedB, delta: timeB.map((t, j) => t - timeA[j]), lapA: sa.lapTime, lapB: sb.lapTime, total: sa.total };
  }

  makeChart(canvas, yTitle, reverse) {
    if (typeof Chart === "undefined") return null;
    Chart.getChart(canvas)?.destroy();                // a race that was open before left its chart here
    const self = this;
    return new Chart(canvas, {
      type: "line",
      data: { datasets: [] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, parsing: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: { type: "linear", min: 0, title: { display: true, text: "Distance in the lap (m)" } },
          y: { title: { display: true, text: yTitle }, reverse },
        },
        plugins: { legend: { labels: { boxWidth: 14 } } },
      },
      plugins: [{
        id: "now",
        afterDatasetsDraw(chart) {         // white line: where driver A is now (when the replay is in this lap)
          if (self.nowFraction === null || !self.result) return;
          const { ctx, chartArea, scales } = chart;
          const x = scales.x.getPixelForValue(self.nowFraction * self.result.total);
          ctx.save();
          ctx.strokeStyle = colors.playhead;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();
          ctx.restore();
        },
      }],
    });
  }

  styleAxes(chart) {
    const { x, y } = chart.options.scales;
    for (const axis of [x, y]) {
      axis.ticks = { ...axis.ticks, color: colors.muted };
      axis.grid = { ...axis.grid, color: colors.lane };
      axis.title.color = colors.muted;
    }
    chart.options.plugins.legend.labels.color = colors.text;
  }

  // Called every frame while the Telemetry tab is open.
  update(replay) {
    this.els.box.hidden = !this.active;
    if (!this.active) return;
    const now = performance.now();
    if (now - this.lastRun < REFRESH_MS) return;
    this.lastRun = now;

    const a = this.els.a.value;
    const b = this.els.b.value;
    const choice = this.els.lap.value;
    const followed = Math.max(countUpTo(this.race.strategy.drivers[a]?.laps || [0], replay.time), 1);   // lap of A now
    const lap = choice === "follow" ? followed : Number(choice);

    const key = `${a}|${b}|${lap}|${speedUnitLabel()}|${!!this.store.get(a)}|${!!this.store.get(b)}`;
    if (key !== this.key) {
      this.key = key;
      this.result = this.compute(a, b, lap);
      this.draw(a, b, lap);
    }
    // The white line: only when the replay is in the lap that is shown.
    const window = this.lapWindow(a, lap);
    this.nowFraction = null;
    if (this.result && window && followed === lap) {
      this.nowFraction = Math.min(Math.max((replay.time - window.start) / window.duration, 0), 1);
    }
    if (this.speedChart) this.speedChart.draw();
    if (this.deltaChart) this.deltaChart.draw();
  }

  draw(a, b, lap) {
    const r = this.result;
    const colorA = this.drivers[a].color;
    const colorB = this.drivers[b].color;
    const sameTeam = this.drivers[a].team === this.drivers[b].team;
    const dashB = sameTeam ? [8, 4] : [];
    this.speedChart ??= this.makeChart(this.els.speedCanvas, `Speed (${speedUnitLabel()})`, false);
    this.deltaChart ??= this.makeChart(this.els.deltaCanvas, `${b} behind ${a} (s)`, true);
    if (!this.speedChart || !this.deltaChart) return;

    if (!r) {
      const loading = this.store.isLoading(a) || this.store.isLoading(b);
      this.els.info.textContent = loading ? "Loading telemetry..." : `No telemetry for lap ${lap} of one of the drivers.`;
      this.speedChart.data.datasets = [];
      this.deltaChart.data.datasets = [];
    } else {
      const diff = r.lapB - r.lapA;
      this.els.info.innerHTML = `Lap ${lap}: <b style="color:${esc(colorA)}">${esc(a)}</b> ${formatSeconds(r.lapA)} &middot; ` +
        `<b style="color:${esc(colorB)}">${esc(b)}</b> ${formatSeconds(r.lapB)} ` +
        `(${diff >= 0 ? "+" : "-"}${Math.abs(diff).toFixed(3)} s for ${esc(b)})`;
      const line = (label, values, color, dash) => ({
        label, borderColor: color, borderWidth: 2, borderDash: dash, pointRadius: 0, tension: 0,
        data: values.map((v, j) => ({ x: r.x[j], y: v })),
      });
      this.speedChart.data.datasets = [
        line(a, r.speedA.map((v) => speedFromKmh(v)), colorA, []),
        line(b, r.speedB.map((v) => speedFromKmh(v)), colorB, dashB),
      ];
      this.deltaChart.data.datasets = [line(`${b} - ${a}`, r.delta, colorB, dashB)];
      this.deltaChart.options.scales.y.title.text = `${b} behind ${a} (s)`;
    }
    this.speedChart.options.scales.y.title.text = `Speed (${speedUnitLabel()})`;
    for (const chart of [this.speedChart, this.deltaChart]) {
      this.styleAxes(chart);
      chart.options.scales.x.max = r ? r.total : undefined;
      chart.update("none");
    }
  }
}
