// Overtakes panel: a clickable list of every detected overtake.
import { formatTime, esc, speedFromKmh, speedUnitLabel } from "./util.js";

const OVERTAKE_MODE_GAP = 1.0;   // 2026 rule: the attacker must be within 1 s of the car ahead

// The "DRS / Overtake Mode" part of a list entry, depending on the season.
function modeText(e, year) {
  // Race control switches DRS / Overtake Mode on after the first laps and off under a safety car.
  if (e.modeEnabled === false) return year < 2026 ? "DRS not enabled" : "Overtake Mode not enabled";
  if (year < 2026) {
    // Up to 2025: the car telemetry has a DRS channel, so this is measured, not estimated.
    const drs = { open: "DRS open", available: "DRS available, not open", closed: "no DRS" }[e.drs];
    return drs || "DRS unknown";
  }
  // From 2026 there is no DRS and the data has no Overtake Mode channel. All we can say is
  // whether the attacker was within 1 s of the car ahead (eligible). This is an estimate.
  if (e.gap === null) return "Overtake Mode: gap unknown (estimate)";
  const eligible = e.gap <= OVERTAKE_MODE_GAP;
  return `Overtake Mode: ${eligible ? "eligible" : "not eligible"} at ${e.gap.toFixed(1)} s (estimate)`;
}

export class OvertakeList {
  constructor(listEl, noteEl, race, onSelect) {
    this.listEl = listEl;
    this.race = race;
    this.onSelect = onSelect;
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.overtakes = race.events.filter((e) => e.type === "overtake");

    noteEl.textContent = race.meta.year < 2026
      ? "Speed difference = attacker minus defender at the moment of the pass. DRS comes from the car telemetry."
      : "From 2026 there is no DRS. Overtake Mode information is an ESTIMATE: the data has no Overtake Mode channel, " +
        "so we only check whether the attacker was within 1 s of the car ahead.";

    listEl.onclick = (e) => {
      const item = e.target.closest("li[data-index]");
      if (item) this.onSelect(this.overtakes[Number(item.dataset.index)]);
    };
  }

  get count() {
    return this.overtakes.length;
  }

  // Rebuilds the list. Called when the selection, the highlighted drivers or the filter change.
  render(selected, highlighted, onlyHighlighted) {
    const html = [];
    this.overtakes.forEach((e, index) => {
      const involved = highlighted.has(e.attacker) || highlighted.has(e.defender);
      if (onlyHighlighted && highlighted.size > 0 && !involved) return;

      const diff = e.speedDiff === null ? null : Math.round(speedFromKmh(e.speedDiff));
      const speed = diff === null ? "" : ` · ${diff >= 0 ? "+" : ""}${diff} ${speedUnitLabel()}`;
      const classes = [e === selected ? "selected" : "", involved ? "involved" : ""].join(" ");
      html.push(`<li data-index="${index}" class="${classes}">
        <div class="otTop"><span>Lap ${e.lap}</span><span>${e.corner ? esc(e.corner) : ""}</span><span>${formatTime(e.t)}</span></div>
        <div class="otMain"><b style="color:${esc(this.colors[e.attacker])}">${esc(e.attacker)}</b> passed
          <b style="color:${esc(this.colors[e.defender])}">${esc(e.defender)}</b></div>
        <div class="otInfo">${esc(modeText(e, this.race.meta.year))}${speed}</div>
      </li>`);
    });
    this.listEl.innerHTML = html.join("") || "<li class='empty'>No overtakes to show.</li>";
  }
}
