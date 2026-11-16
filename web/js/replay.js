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

/*
 * THE RACING LINE
 * OpenF1 snaps every car on track to one line (see python/track_line.py). track.json "line" is that
 * line, one point every ~2 m, starting at the start/finish line and closed (the last point joins
 * the first). We add up the segment lengths once: cum[i] = distance from the start to point i,
 * cum[n] = the length of a lap. Races exported before this existed have no line (returns null).
 */
function prepareLine(line) {
  if (!line) return null;
  const n = line.x.length;
  const cum = new Float64Array(n + 1);     // a plain array of numbers, a bit faster than [...]
  for (let i = 1; i <= n; i++) {
    const j = i % n;                       // i = n: the closing segment back to point 0
    cum[i] = cum[i - 1] + Math.hypot(line.x[j] - line.x[i - 1], line.y[j] - line.y[i - 1]);
  }
  return { x: line.x, y: line.y, cum, length: cum[n] };
}

export class Replay {
  constructor(race) {
    this.race = race;
    this.line = prepareLine(race.track.line);
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
   *
   * ALONG THE LINE. A straight line between two X/Y samples cuts every corner (at 300 km/h the
   * samples are 83 m apart). So when the car is on the racing line at both samples we interpolate
   * its DISTANCE along the line (`s`, which grows lap after lap) instead, the same way, and then
   * take the point of the line at that distance: the car can only move along the curve.
   * Where `s` is null (pit lane, garage, missing data) or the race has no line: X/Y as above.
   * At the pit entry / exit only one of the two samples is on the line: we go in a straight line
   * from the point of the line to the X/Y sample (or back), so the car never jumps.
   */
  positionOf(abbr, time = this.time) {
    const { step, drivers } = this.race.positions;
    const d = drivers[abbr];
    const exact = Math.max(time, 0) / step;               // fractional index
    const i0 = Math.min(Math.floor(exact), d.x.length - 1);
    const i1 = Math.min(i0 + 1, d.x.length - 1);          // clamp at the end of the array
    const f = exact - i0;                                 // fraction between the two samples
    const s = this.distanceAt(d, i0, i1, f);
    if (s !== null) return this.pointOnLine(s);
    const a = this.sampleAt(d, i0);
    const b = this.sampleAt(d, i1);
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
    };
  }

  // Sample i of a driver: its point of the line when it has a distance there, else its X/Y.
  sampleAt(d, i) {
    if (this.line && d.s && d.s[i] !== null) return this.pointOnLine(d.s[i]);
    return { x: d.x[i], y: d.y[i] };
  }

  // Interpolated distance along the line between samples i0 and i1, or null when the car is not
  // on the line at one of them (or the race was exported without the line).
  distanceAt(d, i0, i1, f) {
    if (!this.line || !d.s) return null;
    const s0 = d.s[i0];
    const s1 = d.s[i1];
    if (s0 === null || s1 === null) return null;
    return s0 + (s1 - s0) * f;
  }

  // Same as distanceAt, for a driver and a time.
  distanceOf(abbr, time = this.time) {
    const { step, drivers } = this.race.positions;
    const d = drivers[abbr];
    const exact = Math.max(time, 0) / step;
    const i0 = Math.min(Math.floor(exact), d.x.length - 1);
    const i1 = Math.min(i0 + 1, d.x.length - 1);
    return this.distanceAt(d, i0, i1, exact - i0);
  }

  // The point of the line at total distance s. s keeps growing lap after lap, so we first take
  // the remainder of one lap ("% length"), then find the segment with a binary search on the
  // cumulative distances (countUpTo above) and interpolate inside that segment.
  pointOnLine(s) {
    const { x, y, cum, length } = this.line;
    const n = x.length;
    const d = ((s % length) + length) % length;            // 0..length, also for a negative s
    const k = Math.min(Math.max(countUpTo(cum, d) - 1, 0), n - 1);   // segment k goes from point k to k+1
    const next = (k + 1) % n;
    const f = (d - cum[k]) / Math.max(cum[k + 1] - cum[k], 1e-9);
    return {
      x: x[k] + (x[next] - x[k]) * f,
      y: y[k] + (y[next] - y[k]) * f,
    };
  }

  // Direction of the line where the car is (from 4 m behind it to 4 m ahead, which smooths the
  // small zig-zag of the 2 m segments), as a vector { dx, dy } in data units, or null when the
  // car is not on the line. Used for the heading of the car sprites (map.js headingOf).
  lineDirectionOf(abbr, time = this.time) {
    const s = this.distanceOf(abbr, time);
    if (s === null) return null;
    const behind = this.pointOnLine(s - 40);               // 40 data units = 4 m
    const ahead = this.pointOnLine(s + 40);
    return { dx: ahead.x - behind.x, dy: ahead.y - behind.y };
  }

  // Pairs of cars side by side now (see overlappingPairs). Only racing cars on the line: not in the
  // pit lane, not retired (`retiredAt`: abbr -> time), not standing still (the grid is staggered).
  sideBySide(retiredAt) {
    if (!this.line) return [];
    const cars = [];
    for (const d of this.race.meta.drivers) {
      if (d.status === "DNS" || !this.race.positions.drivers[d.abbr]) continue;
      if (retiredAt[d.abbr] !== undefined && this.time > retiredAt[d.abbr]) continue;
      const s = this.distanceOf(d.abbr);
      const before = this.distanceOf(d.abbr, this.time - 0.5);
      const after = this.distanceOf(d.abbr, this.time + 0.5);
      if (s === null || before === null || after === null) continue;
      if (after - before < 50) continue;       // under 5 m/s: standing still, like packView in map.js
      cars.push({ abbr: d.abbr, s });
    }
    return overlappingPairs(cars, this.line.length);
  }
}

/*
 * SIDE BY SIDE (an estimate). All cars are snapped to one line, so we never know who is on the
 * inside. But two cars closer than about one car length along the line overlap, so they must be
 * next to each other. `cars` = [{ abbr, s }] (distance along the line); s grows lap after lap, so
 * we compare the remainders of one lap: a car can be side by side with one it is lapping.
 * Returns the pairs [abbrA, abbrB].
 */
// 4 m, not the 5.6 m car length: position noise (1-2 m) made cars following nose to tail look side by side.
export const CAR_LENGTH = 40;                // data units (1/10 m)

export function overlappingPairs(cars, lapLength) {
  const pairs = [];
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const d = Math.abs(cars[i].s - cars[j].s) % lapLength;
      if (Math.min(d, lapLength - d) < CAR_LENGTH) pairs.push([cars[i].abbr, cars[j].abbr]);
    }
  }
  return pairs;
}
