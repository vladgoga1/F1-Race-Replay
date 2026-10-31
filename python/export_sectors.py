"""The three official timing sectors (S1, S2, S3) of the circuit and every driver's time in each.

OpenF1 gives the time of each sector of each lap (laps table: duration_sector_1/2/3) but not where
on the track the sectors start. We estimate it: S1 ends `duration_sector_1` seconds after the lap
starts, so we look where the car was at that moment and project that point onto the track outline.
One lap gives a rough answer (the car is not exactly at the line when the lap starts); the MEDIAN of
hundreds of laps of all drivers is accurate to a few metres.

Output (sectors.json):
  pieces - for each sector the points of the track outline that belong to it (rotated like the map)
  marks  - the two borders S1|S2 and S2|S3 as [x, y, dx, dy] (point + direction of the track there)
  times  - {driver: [lap 1 [s1, s2, s3], lap 2 [...], ...]} in seconds, null where OpenF1 has no value
           (laps are numbered like the rest of the page, see lap_timing.py)
  laps   - {driver: [[start, duration] or null, ...]}: the official start time (seconds since
           lights-out) and lap time of each lap. They are exact to the millisecond, unlike the lap
           starts of the rest of the page (found with a 0.5 s step); the driver comparison uses them.
  length - lengths of the three sectors in metres (estimated)
"""
import numpy as np

import lap_timing
from geometry import TrackPath, rotate

MATCH_SECONDS = 4        # an OpenF1 lap belongs to our lap if it starts within this many seconds


def estimate_borders(race, path, line_progress):
    """Distance along the outline, from the start line, where S1 ends and where S2 ends."""
    laps = race.laps.dropna(subset=["t_start", "duration_sector_1", "duration_sector_2"])
    laps = laps[(laps["lap_number"] >= 2) & ~laps["is_pit_out_lap"].astype(bool)]

    first, second = [], []
    for number, rows in laps.groupby("driver_number"):
        if number not in race.location:
            continue
        loc = race.location[number]
        t1 = rows["t_start"] + rows["duration_sector_1"]
        t2 = t1 + rows["duration_sector_2"]
        for times, out in ((t1, first), (t2, second)):
            x = np.interp(times, loc["t"], loc["x"])
            y = np.interp(times, loc["t"], loc["y"])
            # progress along the outline, counted from the start line (0 .. length)
            out.extend(((path.progress(x, y) - line_progress) % path.length).tolist())

    borders = []
    for values in (first, second):
        values = np.array(values)
        middle = np.median(values)
        # Bad rows (a lap with a wrong time) are far from the median: show how many were ignored.
        good = values[np.abs(values - middle) < 600]       # 60 m
        borders.append(float(np.median(good)))
        print(f"  Sector border: {borders[-1] / 10:.0f} m after the line; "
              f"{len(good)} of {len(values)} laps agree within 60 m (spread {np.std(good) / 10:.1f} m)")
    return borders


def build_sectors(race, timing, rotation):
    path = TrackPath(lap_timing.fastest_lap_path(race))
    line = lap_timing.find_line(race)
    line_progress = float(path.progress(np.array([line[0]]), np.array([line[1]]))[0])
    b1, b2 = estimate_borders(race, path, line_progress)
    edges = [0.0, b1, b2, path.length]

    pieces = []
    for k in range(3):
        points = rotate(path.stretch(line_progress + edges[k], line_progress + edges[k + 1]), rotation)
        pieces.append([[int(x), int(y)] for x, y in points])

    # The two borders: a point on the outline and the direction of the track there.
    marks = []
    for edge in (b1, b2):
        a, b = rotate(path.stretch(line_progress + edge - 20, line_progress + edge + 20), rotation)[[0, -1]]
        marks.append([int(a[0] / 2 + b[0] / 2), int(a[1] / 2 + b[1] / 2), int(b[0] - a[0]), int(b[1] - a[1])])

    # Times: for each lap of ours, the OpenF1 row of that driver that starts at the same moment.
    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    times = {}
    official = {}
    matched = total = 0
    for number, info in timing.items():
        rows = race.laps[race.laps["driver_number"] == number].dropna(subset=["t_start"])
        starts = rows["t_start"].to_numpy()
        driver_laps = []
        driver_official = []
        for start in info["starts"]:
            total += 1
            sectors = [None, None, None]
            lap = None
            if len(starts):
                i = int(np.argmin(np.abs(starts - start)))
                if abs(starts[i] - start) <= MATCH_SECONDS:
                    row = rows.iloc[i]
                    values = [row["duration_sector_1"], row["duration_sector_2"], row["duration_sector_3"]]
                    sectors = [None if np.isnan(v) else round(float(v), 3) for v in values]
                    if not np.isnan(row["lap_duration"]):
                        lap = [round(float(row["t_start"]), 3), round(float(row["lap_duration"]), 3)]
                    matched += 1
            driver_laps.append(sectors)
            driver_official.append(lap)
        times[abbr_of[number]] = driver_laps
        official[abbr_of[number]] = driver_official
    print(f"  Sectors: {matched} of {total} laps matched with an OpenF1 lap")

    return {
        "pieces": pieces,
        "marks": marks,
        "times": times,
        "laps": official,
        "length": [round((edges[k + 1] - edges[k]) / 10) for k in range(3)],
    }
