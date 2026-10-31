// Replay clock + position interpolation. No drawing here.

/*
 * BINARY SEARCH LOOKUPS
 * Many values (race position, gap, tyre) only change now and then, and are stored as two
 * sorted lists: `t` (when it changed) and `v` (the new value). To find "the value now" we need
 * the last change at or before the current time. Scanning the whole list 60 times per second
 * for 22 drivers would be wasteful, so we use binary search: look at the middle element, discard
 * the half that cannot contain the answer, repeat. That takes about log2(n) steps (12 steps
 * for 4000 entries) instead of n. Python's bisect.bisect_right does the same thing.
 */

// How many entries of the sorted list `times` are <= time (0 if none).
export function countUpTo(times, time) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;           // >> 1 is integer division by 2
    if (times[mid] <= time) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Value of a { t: [...], v: [...] } step series at `time`, or null before its first entry.
export function stepValue(series, time) {
  if (!series) return null;
  const n = countUpTo(series.t, time);
  return n === 0 ? null : series.v[n - 1];
}

export class Replay {
  constructor(race) {
    this.race = race;
    this.time = 0;       // current replay time in seconds since lights-out
    this.speed = 1;      // 1 = real time
    this.playing = false;
    this.duration = race.meta.duration;
  }

  // Called every animation frame with the real seconds elapsed since the previous frame.
  tick(realSeconds) {
    if (!this.playing) return;
    this.time += realSeconds * this.speed;   // 10x speed = replay time advances 10x faster
    if (this.time >= this.duration) {
      this.time = this.duration;
      this.playing = false;
    }
  }

  seek(seconds) {
    this.time = Math.min(Math.max(seconds, 0), this.duration);
  }

  // Start time of lap n (1-based), from the exported lapStarts list.
  lapStart(lap) {
    return this.race.meta.lapStarts[lap - 1];
  }

  // Current lap = last lap whose start time is <= current time.
  currentLap() {
    const starts = this.race.meta.lapStarts;
    let lap = 1;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= this.time) lap = i + 1;
    }
    return lap;
  }

  /*
   * INTERPOLATION
   * We only have one position per second (index i = time i * step). The screen
   * redraws ~60 times per second, so most frames fall BETWEEN two samples.
   * Showing the nearest sample would make cars jump once per second.
   * Linear interpolation instead computes the point on the straight line
   * between the two neighbours:
   *
   *     pos = p0 + (p1 - p0) * f      where f = 0..1 is how far we are between them
   *
   * Example: samples at t=10 s (x=100) and t=11 s (x=200); at t=10.25 s, f = 0.25,
   * so x = 100 + (200 - 100) * 0.25 = 125. Same idea as "lerp" in game dev.
   */
  positionOf(abbr, time = this.time) {
    const { step, drivers } = this.race.positions;
    const d = drivers[abbr];
    const exact = Math.max(time, 0) / step;               // fractional index
    const i0 = Math.min(Math.floor(exact), d.x.length - 1);
    const i1 = Math.min(i0 + 1, d.x.length - 1);          // clamp at the end of the array
    const f = exact - i0;                                 // fraction between the two samples
    return {
      x: d.x[i0] + (d.x[i1] - d.x[i0]) * f,
      y: d.y[i0] + (d.y[i1] - d.y[i0]) * f,
    };
  }
}
