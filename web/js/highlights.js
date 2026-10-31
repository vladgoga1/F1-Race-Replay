// Highlights mode: plays only the interesting moments of the race, one after another.
//
// A "clip" is a short stretch of the race around one event (or a few events close together).
// While the mode is on and the replay plays, the replay time jumps over everything between two
// clips. The events come from the timeline, and so do the filters: an event type switched off
// there is not played here. Yellow flags are never played (there are too many and they are
// rarely worth watching), the safety car, virtual safety car and red flag are.
import { countUpTo } from "./replay.js";

// Seconds of the race shown around the event: [before, after]. The event time is when it
// happens (the pass, the entry to the pit lane, the moment the car stops, the end of the lap).
const WINDOW = {
  overtake: [-4, 5],
  pit: [-3, 9],
  sc: [-3, 10],
  vsc: [-3, 10],
  red: [-3, 10],
  dnf: [-6, 4],
  fastest: [-6, 4],
};
const MERGE_GAP = 1;    // clips closer than this many seconds become one

// Drivers an event is about (empty for race-wide events such as the safety car).
function involved(e) {
  if (e.type === "overtake") return [e.attacker, e.defender];
  return e.driver ? [e.driver] : [];
}

export class Highlights {
  constructor(race) {
    this.race = race;
    this.clips = [];       // [{ start, end, events }] sorted by time
    this.index = -1;       // clip the replay is in (or the last one before it), -1 = none yet
    this.key = null;       // what the clips were built from: used to rebuild only when it changes
    this.done = false;     // the last clip has been played
  }

  // Builds the list of clips. hidden: event types switched off in the timeline; highlighted: the
  // drivers the user follows; onlyHighlighted: keep only events of those drivers (race-wide
  // events like the safety car stay).
  build(hidden, highlighted, onlyHighlighted) {
    const key = [...hidden].sort().join(",") + "|" + [...highlighted].sort().join(",") + "|" + onlyHighlighted;
    if (key === this.key) return false;
    this.key = key;

    const wanted = this.race.events.filter((e) => {
      if (!(e.type in WINDOW) || hidden.has(e.type)) return false;
      if (onlyHighlighted && highlighted.size > 0) {
        const who = involved(e);
        if (who.length > 0 && !who.some((abbr) => highlighted.has(abbr))) return false;
      }
      return true;
    });

    this.clips = [];
    for (const e of wanted.sort((a, b) => a.t - b.t)) {
      const [before, after] = WINDOW[e.type];
      const start = Math.max(e.t + before, 0);
      const end = Math.min(e.t + after, this.race.meta.duration);
      const last = this.clips[this.clips.length - 1];
      if (last && start <= last.end + MERGE_GAP) {
        last.end = Math.max(last.end, end);          // close to the previous clip: extend it
        last.events.push(e);
      } else {
        this.clips.push({ start, end, events: [e] });
      }
    }
    this.done = false;
    return true;
  }

  // Index of the clip that contains `time`, or -1 when time is between two clips.
  clipAt(time) {
    for (let i = 0; i < this.clips.length; i++) {
      if (time >= this.clips[i].start && time <= this.clips[i].end) return i;
    }
    return -1;
  }

  // Called every frame while the mode is on. When the replay plays and has left a clip, it
  // jumps to the start of the next one (or stops after the last).
  update(replay) {
    const t = replay.time;
    const inside = this.clipAt(t);
    if (inside !== -1) {
      this.index = inside;
      return;
    }
    // Between clips: remember the last clip we passed (for the counter).
    const passed = countUpTo(this.clips.map((c) => c.start), t) - 1;
    this.index = passed;
    if (!replay.playing) return;

    const next = this.clips[passed + 1];
    if (next) {
      replay.seek(next.start);
      this.index = passed + 1;
    } else {
      replay.playing = false;                        // the last clip is over
      this.done = true;
    }
  }

  // What the camera should look at at `time`: { abbrs, event } = the drivers of the event of the
  // clip that is playing, or null for events of the whole race (safety car...) and between clips.
  // In a clip made of several events it is the first one that is not over yet.
  actionAt(time) {
    const clip = this.clips[this.clipAt(time)];
    if (!clip) return null;
    const event = clip.events.find((e) => time <= e.t + WINDOW[e.type][1]) || clip.events[clip.events.length - 1];
    const abbrs = involved(event).filter((abbr) => abbr in this.race.positions.drivers);
    return abbrs.length > 0 ? { abbrs, event } : null;
  }

  // Jump to the previous (-1) or next (+1) clip.
  jump(replay, step) {
    if (this.clips.length === 0) return;
    const target = Math.min(Math.max(this.index + step, 0), this.clips.length - 1);
    replay.seek(this.clips[target].start);
    this.index = target;
    this.done = false;
  }

  // The mode was just switched on: if the replay is not inside a clip, go to the next one.
  enter(replay) {
    this.done = false;
    if (this.clipAt(replay.time) !== -1 || this.clips.length === 0) return;
    const next = this.clips.find((c) => c.start > replay.time) || this.clips[0];
    replay.seek(next.start);
  }

  // The Play button after the last clip: start again from the first one.
  restartIfDone(replay) {
    if (this.done && this.clips.length > 0) {
      replay.seek(this.clips[0].start);
      this.index = 0;
      this.done = false;
    }
  }

  // Text for the bar on the map: "4 / 41" and what happens in that clip.
  describe() {
    if (this.clips.length === 0) return { counter: "0 / 0", text: "No moments with these filters" };
    const clip = this.clips[Math.max(this.index, 0)];
    const first = clip.events[0];
    const more = clip.events.length > 1 ? ` (+${clip.events.length - 1} more)` : "";
    return { counter: `${Math.max(this.index, 0) + 1} / ${this.clips.length}`, text: `Lap ${first.lap}: ${first.label}${more}` };
  }
}
