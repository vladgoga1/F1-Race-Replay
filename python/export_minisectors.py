"""Mini-sectors: the lap cut into equal pieces, with the time every driver needed for every piece.

The browser uses this to colour each piece of the track in the colour of the fastest driver of the
selected lap. Output (minisectors.json):
  count    - number of mini-sectors
  sectors  - for every mini-sector the points of the track outline that belong to it (already
             rotated like the rest of the map)
  times    - {driver: [lap 1 [t of sector 1, ..., t of sector N], lap 2 [...], ...]} in seconds,
             null where the driver did not complete that piece
"""
import numpy as np

import config
import lap_timing
from geometry import TrackPath, rotate

GRID_OFFSET = 4000   # 1/10 m = 400 m: see below


def build_minisectors(race, timing, rotation):
    count = config.MINI_SECTORS
    path = TrackPath(lap_timing.fastest_lap_path(race))
    length = path.length
    size = length / count

    # Where is the start/finish line on the outline? Sector 1 starts there.
    line = lap_timing.find_line(race)
    line_progress = float(path.progress(np.array([line[0]]), np.array([line[1]]))[0])

    sectors = []
    for j in range(count):
        points = rotate(path.stretch(line_progress + j * size, line_progress + (j + 1) * size), rotation)
        sectors.append([[int(x), int(y)] for x, y in points])

    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    times = {}
    errors = []        # |sum of the mini-sector times - OpenF1 lap time|, to check our measuring
    for number, info in timing.items():
        if number not in race.location:
            continue
        loc = race.location[number]
        loc = loc[loc["t"] >= 0]

        # Progress along the outline, moved so that the start line is at GRID_OFFSET (400 m) and
        # the grid, which is just behind the line, stays on the same side of the wrap-around.
        # np.unwrap then adds a whole lap every time the car crosses the line, giving the total
        # distance driven, which only grows (the same trick as in detect_overtakes.py).
        progress = path.progress(loc["x"].to_numpy(dtype=float), loc["y"].to_numpy(dtype=float))
        shifted = (progress - line_progress + GRID_OFFSET) % length
        distance = np.maximum.accumulate(np.unwrap(shifted, period=length))
        t = loc["t"].to_numpy()

        driver_laps = []
        for lap in range(len(info["starts"])):
            # Distance at which each mini-sector of this lap starts / ends (N + 1 boundaries).
            boundaries = GRID_OFFSET + lap * length + size * np.arange(count + 1)
            # The time the car reached every boundary: np.interp read backwards: "at which
            # time was the distance equal to this value?". Boundaries the car never reached
            # (a retirement) are marked invalid.
            reached = boundaries <= distance[-1]
            when = np.interp(boundaries, distance, t)
            lap_times = []
            for j in range(count):
                if reached[j] and reached[j + 1]:
                    lap_times.append(round(float(when[j + 1] - when[j]), 3))
                else:
                    lap_times.append(None)
            driver_laps.append(lap_times)

            # Compare with the lap time OpenF1 reports (only for complete laps).
            if all(v is not None for v in lap_times):
                official = race.laps[(race.laps["driver_number"] == number)
                                     & (race.laps["lap_number"] == lap + 1)]["lap_duration"]
                if len(official) and not np.isnan(official.iloc[0]):
                    errors.append(abs(sum(lap_times) - float(official.iloc[0])))
        times[abbr_of[number]] = driver_laps

    if errors:
        print(f"  Mini-sectors: {count} sectors; sum of sector times vs OpenF1 lap time: "
              f"median difference {np.median(errors):.2f} s over {len(errors)} laps")
    return {"count": count, "sectors": sectors, "times": times}
