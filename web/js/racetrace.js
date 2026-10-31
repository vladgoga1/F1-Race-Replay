// Race trace: a Chart.js line chart with the gap of every driver after every lap.
//
// One line per driver. By default the gap is measured to the race leader, so the leader is the
// flat line at 0 and a driver who is falling back goes down (the vertical axis is reversed, like
// on TV: ahead = up). "Gap to" can also be any driver: then a line that goes up means "faster
// than him" and a line that goes down "slower".
// The data is racetrace.json: for every driver the time at which he completed each lap.
import { countUpTo } from "./replay.js";
import { colors } from "./theme.js";

const SPAN_COLORS = { sc: "#ff8c1a", vsc: "#ffc34d", red: "#ff3b3b" };
const SPAN_NAMES = { sc: "SC", vsc: "VSC", red: "RED" };
const HIT_PIXELS = 14;    // a click closer than this to a point of a line counts as a click on that line

export class RaceTrace {
  // els: { panel, canvas, refSelect, rangeSelect } ; onSeek(time) and onToggle(abbr) are callbacks
  constructor(els, race, { onSeek, onToggle }) {
    this.els = els;
    this.race = race;
    this.onSeek = onSeek;
    this.onToggle = onToggle;
    this.ends = race.racetrace ? race.racetrace.drivers : null;   // abbr -> end time of each lap
    this.chart = null;
    this.highlighted = new Set();
    this.nowTime = 0;
    this.reference = "leader";

    this.drivers = race.meta.drivers.filter((d) => this.ends && this.ends[d.abbr]);
    // The two cars of a team have the same colour: the second one gets a dashed line.
    const seen = {};
    this.dashed = {};
    for (const d of this.drivers) {
      seen[d.team] = (seen[d.team] ?? -1) + 1;
      this.dashed[d.abbr] = seen[d.team] % 2 === 1;
    }

    // Laps in which each driver pitted: the pit time falls in lap n of that driver.
    this.pitLaps = {};
    for (const d of this.drivers) {
      const s = race.strategy.drivers[d.abbr];
      this.pitLaps[d.abbr] = new Set(s ? s.pits.map((t) => countUpTo(s.laps, t)) : []);
    }

    els.refSelect.replaceChildren(new Option("Race leader", "leader"));
    for (const d of this.drivers) els.refSelect.add(new Option(`${d.abbr} - ${d.name}`, d.abbr));
    els.refSelect.onchange = () => { this.reference = els.refSelect.value; this.rebuild(); };
    els.rangeSelect.onchange = () => this.rebuild();
  }

  get available() {
    return this.ends !== null;
  }

  // Time on the race clock -> position on the horizontal axis (0 = start, n = end of lap n).
  timeToLap(t) {
    const starts = this.race.meta.lapStarts;
    const i = Math.max(countUpTo(starts, t) - 1, 0);
    const end = i + 1 < starts.length ? starts[i + 1] : this.race.meta.duration;
    return Math.min(i + (t - starts[i]) / (end - starts[i]), this.race.meta.totalLaps);
  }

  // Reference time for every lap: the leader's (the fastest to complete that lap) or a driver's.
  referenceTimes() {
    const laps = this.race.meta.totalLaps;
    const ref = new Array(laps).fill(null);
    for (let i = 0; i < laps; i++) {
      if (this.reference === "leader") {
        for (const d of this.drivers) {
          const t = this.ends[d.abbr][i];
          if (t !== undefined && (ref[i] === null || t < ref[i])) ref[i] = t;
        }
      } else {
        const t = this.ends[this.reference][i];
        ref[i] = t === undefined ? null : t;
      }
    }
    return ref;
  }

  createChart() {
    if (typeof Chart === "undefined") return null;            // Chart.js did not load
    Chart.getChart(this.els.canvas)?.destroy();               // a race that was open before left its chart here
    const self = this;
    return new Chart(this.els.canvas, {
      type: "line",
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        interaction: { mode: "nearest", intersect: false },
        scales: {
          x: { type: "linear", min: 0, max: this.race.meta.totalLaps, title: { display: true, text: "Lap" } },
          y: { reverse: true, title: { display: true, text: "Gap (s)" } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `Lap ${items[0].raw.x}`,
              label: (item) => {
                const gap = item.raw.y;
                if (gap === null) return item.dataset.label;
                return `${item.dataset.label}  ${gap > 0 ? "+" : ""}${gap.toFixed(1)} s`;
              },
            },
          },
        },
        // Click on (near) a line: highlight that driver. Click anywhere else: jump to that lap.
        onClick(event, elements, chart) {
          const hit = elements[0];
          if (hit && Math.hypot(hit.element.x - event.x, hit.element.y - event.y) < HIT_PIXELS) {
            self.onToggle(chart.data.datasets[hit.datasetIndex].abbr);
          } else {
            const lap = Math.round(chart.scales.x.getValueForPixel(event.x));
            const starts = self.race.meta.lapStarts;
            if (lap >= 0 && lap < starts.length) self.onSeek(starts[lap]);
          }
        },
      },
      plugins: [{
        id: "raceTraceExtras",
        // Coloured bands behind the lines: safety car, virtual safety car and red flag periods.
        beforeDatasetsDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          ctx.save();
          ctx.font = "bold 10px system-ui";
          ctx.textBaseline = "top";
          for (const e of self.race.events) {
            if (!(e.type in SPAN_COLORS)) continue;
            const x0 = scales.x.getPixelForValue(self.timeToLap(e.t));
            const x1 = scales.x.getPixelForValue(self.timeToLap(e.end ?? self.race.meta.duration));
            ctx.fillStyle = SPAN_COLORS[e.type] + "33";
            ctx.fillRect(x0, chartArea.top, Math.max(x1 - x0, 2), chartArea.bottom - chartArea.top);
            ctx.fillStyle = SPAN_COLORS[e.type];
            ctx.fillText(SPAN_NAMES[e.type], x0 + 3, chartArea.top + 3);
          }
          ctx.restore();
        },
        // The name of each driver at the end of his line, and the line of "now".
        afterDatasetsDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          ctx.save();
          ctx.font = "bold 10px system-ui";
          ctx.textBaseline = "middle";
          chart.data.datasets.forEach((set) => {
            const last = [...set.data].reverse().find((p) => p.y !== null);
            if (!last || !set.showLabel) return;
            ctx.fillStyle = set.baseColor;
            ctx.fillText(set.abbr, scales.x.getPixelForValue(last.x) + 4, scales.y.getPixelForValue(last.y));
          });
          const x = scales.x.getPixelForValue(self.timeToLap(self.nowTime));
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

  // Recomputes the data (after "gap to" or the range changed) and the look of the lines.
  rebuild() {
    if (!this.available) return;
    if (!this.chart) this.chart = this.createChart();
    if (!this.chart) return;

    const ref = this.referenceTimes();
    const any = this.highlighted.size > 0;
    this.chart.data.datasets = this.drivers.map((d) => {
      const on = this.highlighted.has(d.abbr);
      const pits = this.pitLaps[d.abbr];
      return {
        abbr: d.abbr,
        label: d.abbr,
        baseColor: d.color,
        showLabel: !any || on,
        data: this.ends[d.abbr].map((t, i) => ({ x: i + 1, y: ref[i] === null ? null : t - ref[i] })),
        borderColor: any && !on ? d.color + "44" : d.color,
        borderWidth: on ? 3.5 : any ? 1 : 2,
        borderDash: this.dashed[d.abbr] ? [6, 3] : [],
        tension: 0,
        // Round markers on the laps where the driver pitted.
        pointRadius: (c) => (pits.has(c.raw.x) ? 4 : 0),
        pointBackgroundColor: d.color,
        pointHoverRadius: 5,
      };
    });

    // Vertical range. "Auto" ignores extreme gaps (a car that spent ten minutes in the garage
    // would squash everybody else into a thin strip): it fits 95% of the values.
    const choice = this.els.rangeSelect.value;           // "auto", "all" or a number of seconds
    let range;                                           // undefined = let Chart.js fit everything
    if (choice === "auto") {
      const gaps = this.chart.data.datasets.flatMap((s) => s.data.map((p) => p.y))
        .filter((v) => v !== null).map(Math.abs).sort((a, b) => a - b);
      const p95 = gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0;
      range = Math.max(20, Math.ceil((p95 * 1.1) / 10) * 10);
    } else if (choice !== "all") {
      range = Number(choice);
    }
    const { x, y } = this.chart.options.scales;
    y.min = this.reference === "leader" ? 0 : (range ? -range : undefined);
    y.max = range;
    y.title.text = this.reference === "leader" ? "Gap to the leader (s)" : `Gap to ${this.reference} (s)`;
    for (const axis of [x, y]) {
      axis.ticks = { ...axis.ticks, color: colors.muted };
      axis.grid = { ...axis.grid, color: colors.lane };
      axis.title.color = colors.muted;
    }
    this.chart.update("none");
  }

  setHighlighted(highlighted) {
    this.highlighted = new Set(highlighted);
    if (!this.els.panel.hidden) this.rebuild();
  }

  open() {
    this.els.panel.hidden = false;
    this.rebuild();
    if (this.chart) this.chart.resize();
  }

  close() {
    this.els.panel.hidden = true;
  }

  // Called every frame while the panel is open: only moves the "now" line (no new data).
  update(time) {
    this.nowTime = time;
    if (this.chart && !this.els.panel.hidden) this.chart.draw();
  }
}
