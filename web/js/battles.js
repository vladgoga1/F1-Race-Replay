// "Battles" tab: pairs of cars that ran less than a second apart for several laps
// (python/detect_battles.py), and the lines on the map between the cars of a battle in progress.
import { stepValue } from "./replay.js";
import { formatTime, esc } from "./util.js";

export class BattleList {
  constructor(listEl, noteEl, race, onSelect) {
    this.listEl = listEl;
    this.race = race;
    this.battles = race.battles || [];
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.key = null;                 // what the list was drawn from: redraw only when it changes

    if (!race.battles) {
      noteEl.textContent = "This race was exported without battles: export it again from the Races panel.";
    } else {
      noteEl.textContent = (race.meta.year < 2026
        ? "Two cars less than 1 s apart for 3 laps or more: the car behind is inside the DRS window all the time. "
        : "Two cars less than 1 s apart for 3 laps or more. From 2026 there is no DRS: this is the range where Overtake Mode " +
          "can be used (an ESTIMATE, the data has no Overtake Mode channel). ") +
        "Safety car periods and pit stops are left out.";
    }
    listEl.onclick = (e) => {
      const item = e.target.closest("li[data-index]");
      if (item) onSelect(this.battles[Number(item.dataset.index)]);
    };
  }

  get count() {
    return this.battles.length;
  }

  isLive(battle, time) {
    return time >= battle.t && time <= battle.end;
  }

  // The battles to draw on the map at `time`: [{ a, b, gap, selected }]. gap = seconds between
  // the two cars now (the interval of the one who is behind), or null.
  linesAt(time, selected, all) {
    const lines = [];
    for (const battle of this.battles) {
      const chosen = battle === selected;
      if (!this.isLive(battle, time) || !(all || chosen)) continue;
      const a = battle.ahead;
      const b = battle.behind;
      const positionA = stepValue(this.race.standings.position[a], time);
      const positionB = stepValue(this.race.standings.position[b], time);
      const behind = positionA > positionB ? a : b;
      const gap = stepValue(this.race.standings.interval[behind], time);
      lines.push({ a, b, gap: typeof gap === "number" ? gap : null, selected: chosen });
    }
    return lines;
  }

  // Redraws the list when something it shows changed. Called every frame while the tab is open.
  update(time, selected, highlighted, onlyHighlighted) {
    const live = this.battles.map((b, i) => (this.isLive(b, time) ? i : -1)).filter((i) => i >= 0);
    const key = `${live}|${this.battles.indexOf(selected)}|${[...highlighted]}|${onlyHighlighted}`;
    if (key === this.key) return;
    this.key = key;

    const html = [];
    this.battles.forEach((b, index) => {
      const involved = highlighted.has(b.ahead) || highlighted.has(b.behind);
      if (onlyHighlighted && highlighted.size > 0 && !involved) return;
      const classes = [b === selected ? "selected" : "", involved ? "involved" : "", live.includes(index) ? "live" : ""].join(" ");
      const swaps = b.swaps === 0 ? "no overtake" : b.swaps === 1 ? "1 overtake" : `${b.swaps} overtakes`;
      html.push(`<li data-index="${index}" class="${classes}">
        <div class="otTop"><span>Lap ${b.lap}</span><span>P${b.position}-P${b.position + 1}</span><span>${formatTime(b.t)}</span>
          ${live.includes(index) ? '<span class="liveTag">LIVE</span>' : ""}</div>
        <div class="otMain"><b style="color:${esc(this.colors[b.ahead])}">${esc(b.ahead)}</b> vs
          <b style="color:${esc(this.colors[b.behind])}">${esc(b.behind)}</b> &middot; ${b.laps} laps</div>
        <div class="otInfo">average gap ${b.avgGap.toFixed(2)} s &middot; closest ${b.minGap.toFixed(2)} s &middot; ${swaps}</div>
      </li>`);
    });
    this.listEl.innerHTML = html.join("") || "<li class='empty'>No battles to show.</li>";
  }
}
