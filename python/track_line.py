"""The racing line: a dense version of the track outline, and every car's distance along it.

WHY: OpenF1 does not send where a car really is on the tarmac. Its X/Y positions are SNAPPED to
one line: 95-98% of the samples on track are within 0.5 m of the fastest-lap path, and two
different cars at the same spot get the same point (within 0.1 m). Only the pit lane is off that
line. So the position of a car on track is fully described by ONE number: how far along the line
it is. (Side by side, inside or outside in a corner cannot be known from this data.)

The page used to interpolate X/Y between samples 1 s apart. At 300 km/h that is 83 m: the straight
line between two samples cuts the corners. Instead we export:
  - track.json  "line": the line itself, one point every ~2 m (the 305 points of the fastest lap
    are ~19 m apart, too coarse to draw a smooth curve), starting at the start/finish line;
  - positions.json "s": every car's distance along that line, which keeps growing lap after lap.
The browser interpolates `s` (a distance, so the car can only move ALONG the line) and looks up the
point of the line at that distance. Where a car is off the line (pit lane, garage, off track,
missing data) `s` is null and the browser falls back to X/Y.
"""
import numpy as np

import lap_timing
from geometry import TrackPath, rotate

BIN = 20           # 1/10 m: one point of the dense line every 2 m
FIRST_PASS = 100   # 10 m: points this close to the fastest-lap outline are used for the first try
ON_LINE = 30       # 3 m: a car closer than this to the dense line is "on the line"
MAX_GAP = 2.0      # seconds: two samples further apart than this = missing data, don't interpolate
FINE_STEP = 0.25   # seconds, and
SMOOTH_TAPS = 5    # samples: the smoothing of the distance (see TrackLine.driven)


def median_line(x, y, progress, length):
    """Cut the lap in pieces of BIN units by `progress` and return the median point of every piece.

    All cars are snapped to the same line, so the points of thousands of laps that fall in the same
    2 m piece lie on the same 2 m of line; their median is a very precise point of it (and ignores
    the odd stray point). A piece without any point (none on the line there) is filled in between
    its neighbours.
    """
    count = int(np.ceil(length / BIN))
    piece = np.minimum((progress // BIN).astype(int), count - 1)
    mx = np.full(count, np.nan)
    my = np.full(count, np.nan)
    for k in range(count):
        here = piece == k
        if here.any():
            mx[k] = np.median(x[here])
            my[k] = np.median(y[here])
    known = ~np.isnan(mx)
    index = np.arange(count)
    # period=count: the lap is a loop, so a gap at the end is filled using the start too
    mx = np.interp(index, index[known], mx[known], period=count)
    my = np.interp(index, index[known], my[known], period=count)
    return np.column_stack([mx, my])


class TrackLine:
    """Builds the dense line (rotated like the map) and measures every car on it.

    After construction:
      points - (N, 2) int array, the line (closed: the last point connects to the first),
               starting at the start/finish line
      path   - TrackPath of those exact points (the browser rebuilds the same distances)
      cars   - {driver_number: (t, distance, offset)}: for every raw sample, the distance along
               the line within the lap (0..path.length) and how far the car is from the line
    """

    def __init__(self, race, rotation):
        # Raw samples of all cars, rotated like the map. Everything here is in rotated coordinates.
        # The hour before the race (laps to the grid) is not needed: from one minute before.
        samples = {}
        for number, loc in race.location.items():
            loc = loc[loc["t"] >= -60]
            xy = rotate(loc[["x", "y"]].to_numpy(dtype=float), rotation)
            samples[number] = (loc["t"].to_numpy(dtype=float), xy[:, 0], xy[:, 1])
        t_all = np.concatenate([s[0] for s in samples.values()])
        x_all = np.concatenate([s[1] for s in samples.values()])
        y_all = np.concatenate([s[2] for s in samples.values()])
        racing = t_all >= 0     # build the line from the race only (not the grid)

        # Pass 1: measure every sample on the fastest-lap outline (~305 points). Its straight
        # segments can be a few metres away from the real curve (where OpenF1 skipped samples
        # we saw 80 m segments, 5 m off), hence the loose 10 m limit.
        coarse = TrackPath(rotate(lap_timing.fastest_lap_path(race), rotation))
        progress, offset = coarse.project(x_all, y_all)
        use = racing & (offset < FIRST_PASS)
        first = median_line(x_all[use], y_all[use], progress[use], coarse.length)

        # Pass 2: the same on the first dense line, now keeping only samples really on it (3 m),
        # so pit lane points near the pit entry/exit cannot pull the line sideways. Point k of
        # `first` is the median of the samples at coarse progress k*BIN..(k+1)*BIN, so the coarse
        # progress tells which segment to search near (much faster than trying all of them).
        path1 = TrackPath(first)
        progress, offset = path1.project(x_all, y_all, near=(progress // BIN).astype(int))
        use = racing & (offset < ON_LINE)
        second = median_line(x_all[use], y_all[use], progress[use], path1.length)

        # Light smoothing: every point becomes (previous + 2 * itself + next) / 4. It removes the
        # few centimetres of zig-zag between neighbouring medians (it makes the car headings
        # steadier) and moves the line inside a corner by much less than 10 cm.
        second = (np.roll(second, 1, axis=0) + 2 * second + np.roll(second, -1, axis=0)) / 4

        # Start the line at the start/finish line: move the point nearest to it to the front.
        finish = rotate(np.array([lap_timing.find_line(race)]), rotation)[0]
        shift = int(np.argmin(np.hypot(second[:, 0] - finish[0], second[:, 1] - finish[1])))
        self.points = np.round(np.roll(second, -shift, axis=0)).astype(int)
        self.path = TrackPath(self.points.astype(float))

        # Pass 3: every sample of every car (also before the start) on the final line. Point j
        # of the final line is point j + shift of `second`, i.e. the piece of path1 progress
        # around (j + shift) * BIN, so we search near index (path1 progress // BIN - shift).
        near_all = ((progress // BIN).astype(int) - shift) % len(self.points)
        distance, offset = self.path.project(x_all, y_all, near=near_all)
        self.cars = {}
        first_index = 0
        for number, (t, _, _) in samples.items():
            rows = slice(first_index, first_index + len(t))
            self.cars[number] = (t, distance[rows], offset[rows])
            first_index += len(t)

        # Check printed during the export: how close the samples on the line are to it.
        on = offset[use] / 10
        print(f"  Racing line: {len(self.points)} points, {self.path.length / 10:.0f} m per lap; "
              f"samples on it are {np.median(on):.2f} m (median) / {np.percentile(on, 99):.2f} m (99%) away")

    def driven(self, number, grid):
        """Total distance driven along the line by one car at the times of `grid` (a regular time
        grid), in 1/10 m as ints, or None where the car is not on the line (see the module comment).
        """
        t, distance, offset = self.cars[number]
        # Only from shortly before the grid starts: the laps to the grid before the race go
        # through the pit lane and would only add chances for mistakes.
        recent = t >= grid[0] - 30
        t, distance, offset = t[recent], distance[recent], offset[recent]
        on = offset < ON_LINE
        if on.sum() < 2:
            return [None] * len(grid)

        # Total distance: np.unwrap adds a whole lap (path.length) every time the distance within
        # the lap falls from ~length back to ~0, i.e. every time the car crosses the line. We do
        # it on the samples on the line only, so a pit stop in between still counts its lap.
        # np.maximum.accumulate (running maximum) then removes the backward steps that the
        # measuring noise makes: the total distance of a car never decreases.
        t_on = t[on]
        total = np.maximum.accumulate(np.unwrap(distance[on], period=self.path.length))

        # SMOOTHING. The time stamps of OpenF1 positions are not exact: samples come 0.06 to 0.5 s
        # apart and a car at a steady 320 km/h seems to move 6 m in one sample and 35 m in the
        # next (sometimes a sample even goes 40 m back). That is +-4 m of noise. We resample on a
        # fine 0.25 s grid and replace every value by the average of 5 neighbours (1.25 s window,
        # a "moving average"; np.pad repeats the first/last value so the ends are not pulled to 0).
        # Measured on Monza 2025 against the speed sensor: the speed shown on the map is wrong by
        # 6 km/h (median) instead of 8.5 km/h, and the worst 10% by 16 instead of 28 km/h.
        # Why the export grid stays at 1 s: a 0.5 s grid doubles the file and, even smoothed, it
        # was not more accurate (7 km/h median) because the noise is larger than what it adds.
        fine = np.arange(grid[0] - 1, grid[-1] + 1, FINE_STEP)
        values = np.interp(fine, t_on, total)
        half = SMOOTH_TAPS // 2
        values = np.convolve(np.pad(values, half, mode="edge"), np.ones(SMOOTH_TAPS) / SMOOTH_TAPS, mode="valid")
        values = np.interp(grid, fine, values)

        # Valid only where the two samples around the grid time are both on the line and not too
        # far apart in time. np.searchsorted gives, for every grid time, the index of the first
        # sample after it.
        after = np.searchsorted(t, grid, side="right")
        before = after - 1
        inside = (before >= 0) & (after < len(t))
        b = np.clip(before, 0, len(t) - 1)
        a = np.clip(after, 0, len(t) - 1)
        valid = inside & on[b] & on[a] & (t[a] - t[b] <= MAX_GAP)
        return [int(round(v)) if ok else None for v, ok in zip(values, valid)]
