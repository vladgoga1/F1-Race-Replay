// "Radio" tab: the team radio clips of the race. The sound files are NOT in this project: OpenF1
// only gives links to the Formula 1 servers, so playing a clip needs an internet connection.
import { countUpTo } from "./replay.js";
import { formatTime, esc } from "./util.js";

export class RadioList {
  constructor(listEl, filtersEl, noteEl, race, onSeek) {
    this.listEl = listEl;
    this.race = race;
    this.clips = race.teamradio || [];
    this.times = this.clips.map((c) => c.t);
    this.colors = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.color]));
    this.names = Object.fromEntries(race.meta.drivers.map((d) => [d.abbr, d.name]));
    this.onlyPast = true;              // hide clips that have not happened yet (no spoilers)
    this.onlyHighlighted = false;
    this.highlighted = new Set();
    this.audio = null;                 // the clip that is playing: an Audio object
    this.playingIndex = -1;
    this.status = "";                  // "Loading...", or the reason a clip could not play
    this.key = null;

    if (!race.teamradio) noteEl.textContent = "This race was exported without team radio: export it again from the Races panel.";
    else if (this.clips.length === 0) noteEl.textContent = "OpenF1 has no team radio clips for this race.";
    else noteEl.textContent = "The clips are played from the Formula 1 servers: you need an internet connection. Click the row to jump to the moment, the button to listen.";

    filtersEl.replaceChildren();
    const make = (label, checked, onchange) => {
      const l = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = checked;
      input.onchange = () => { onchange(input.checked); this.key = null; };
      l.append(input, ` ${label}`);
      filtersEl.appendChild(l);
    };
    make("Only what has happened so far", this.onlyPast, (on) => { this.onlyPast = on; });
    make("Only highlighted drivers", this.onlyHighlighted, (on) => { this.onlyHighlighted = on; });

    listEl.onclick = (e) => {
      const item = e.target.closest("li[data-index]");
      if (!item) return;
      const index = Number(item.dataset.index);
      if (e.target.closest("button")) this.toggle(index);
      else onSeek(this.clips[index]);
    };
  }

  get count() {
    return this.clips.length;
  }

  // Plays a clip, or stops it when it is the one that is playing.
  toggle(index) {
    const wasPlaying = this.playingIndex;
    this.stop();
    if (wasPlaying === index) return;
    const audio = new Audio(this.clips[index].url);
    this.audio = audio;
    this.playingIndex = index;
    this.status = "Loading...";
    audio.onplaying = () => { this.status = ""; this.key = null; };
    audio.onended = () => { this.stop(); };
    audio.onerror = () => { this.stop(); this.status = "Could not load the recording (no internet connection?)"; };
    audio.play().catch((err) => {
      // A network problem is reported by onerror; this is for the browser refusing to play.
      if (this.audio !== audio) return;
      this.stop();
      this.status = `Could not play the recording (${err.name})`;
    });
    this.key = null;
  }

  stop() {
    if (this.audio) {
      this.audio.onended = this.audio.onerror = this.audio.onplaying = null;
      this.audio.pause();
    }
    this.audio = null;
    this.playingIndex = -1;
    this.status = "";
    this.key = null;
  }

  update(time, highlighted) {
    this.highlighted = highlighted;
    const past = countUpTo(this.times, time);
    const key = `${this.onlyPast ? past : "all"}|${[...highlighted]}|${this.playingIndex}|${this.status}`;
    if (key === this.key) return;
    this.key = key;

    const starts = this.race.meta.lapStarts;
    const items = [];
    this.clips.forEach((c, index) => {
      if (this.onlyPast && index >= past) return;
      if (this.onlyHighlighted && highlighted.size > 0 && !highlighted.has(c.driver)) return;
      const lap = Math.max(countUpTo(starts, c.t), 1);
      const playing = index === this.playingIndex;
      const future = index >= past ? " future" : "";
      items.push(`<li data-index="${index}" class="${playing ? "playing" : ""}${future}" style="border-left-color:${esc(this.colors[c.driver])}">
        <button title="${playing ? "Stop" : "Listen"}">${playing ? "&#9632;" : "&#9654;"}</button>
        <div><div class="rcWhen">Lap ${lap} &middot; ${formatTime(c.t)}</div>
          <div class="rcText"><b style="color:${esc(this.colors[c.driver])}">${esc(c.driver)}</b> ${esc(this.names[c.driver] || "")}
            ${playing && this.status ? `<em>${esc(this.status)}</em>` : ""}</div></div></li>`);
    });
    if (this.onlyPast) items.reverse();              // newest first, like the messages
    // A clip that failed to load is not "playing" any more: its message goes on top of the list.
    const error = this.status.startsWith("Could") ? `<li class='empty'>${esc(this.status)}</li>` : "";
    this.listEl.innerHTML = error + (items.join("") || "<li class='empty'>No clips yet.</li>");
  }
}
