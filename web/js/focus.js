// Focus mode: the camera follows one driver and only he, the car ahead and the car behind
// are shown, with the gaps to them.
import { stepValue } from "./replay.js";
import { sampleAt, statsHtml } from "./telemetry.js";
import { esc } from "./util.js";

// Who is in front of and behind `abbr` at `time`, by the official race position.
// Cars that have retired or did not start are skipped. Gap to the car ahead = the driver's own
// "interval"; gap to the car behind = that car's interval (its distance to the driver).
export function neighbours(race, retiredAt, abbr, time) {
  const running = [];
  for (const d of race.meta.drivers) {
    if (d.status === "DNS") continue;
    if (d.abbr !== abbr && d.abbr in retiredAt && retiredAt[d.abbr] <= time) continue;
    const position = stepValue(race.standings.position[d.abbr], time);
    if (position !== null) running.push({ abbr: d.abbr, position });
  }
  running.sort((a, b) => a.position - b.position);

  const index = running.findIndex((r) => r.abbr === abbr);
  if (index === -1) return null;
  const ahead = running[index - 1];
  const behind = running[index + 1];
  return {
    abbr,
    position: running[index].position,
    ahead: ahead ? { abbr: ahead.abbr, position: ahead.position, gap: stepValue(race.standings.interval[abbr], time) } : null,
    behind: behind ? { abbr: behind.abbr, position: behind.position, gap: stepValue(race.standings.interval[behind.abbr], time) } : null,
  };
}

// "+1.2 s", "+1 LAP" (text from the data) or "-" when unknown.
export function gapText(gap) {
  if (gap === null || gap === undefined) return "-";
  if (typeof gap === "number") return `+${gap.toFixed(1)} s`;
  return esc(gap);
}

export class FocusPanel {
  constructor(container, race, store) {
    this.container = container;
    this.race = race;
    this.store = store;
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.lastHtml = "";
    this.lastRun = 0;
  }

  update(replay, info) {
    this.container.hidden = !info;
    if (!info) return;
    const now = performance.now();
    if (now - this.lastRun < 70) return;
    this.lastRun = now;

    const row = (cls, arrow, who, gap) => who
      ? `<div class="fRow ${cls}"><span class="arrow">${arrow}</span>
           <b style="color:${esc(this.colors[who.abbr])}">${esc(who.abbr)}</b>
           <span class="fPos">P${who.position}</span><span class="fGap">${gap}</span></div>`
      : `<div class="fRow ${cls} none"><span class="arrow">${arrow}</span>${cls === "ahead" ? "Leading the race" : "Last car"}</div>`;

    const tel = this.store.get(info.abbr);
    const html = `
      ${row("ahead", "&#9650;", info.ahead, info.ahead ? gapText(info.ahead.gap) : "")}
      <div class="fRow me"><span class="arrow">&#9679;</span>
        <b style="color:${esc(this.colors[info.abbr])}">${esc(info.abbr)}</b><span class="fPos">P${info.position}</span></div>
      ${row("behind", "&#9660;", info.behind, info.behind ? gapText(info.behind.gap) : "")}
      <div class="fTel">${tel ? statsHtml(sampleAt(tel, replay.time)) : "<p class='tnote'>Loading telemetry...</p>"}</div>`;
    if (html !== this.lastHtml) {
      this.container.innerHTML = html;
      this.lastHtml = html;
    }
  }
}
