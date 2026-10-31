"""Lap timing measured from the position data (not from OpenF1's lap table).

Why: in some sessions (e.g. Australia 2026) OpenF1's lap table has missing or wrongly
numbered laps. Counting passes over the start/finish line in the X/Y trace is reliable
for every season, so lap numbers, tyre age and the lap selector are all built on it.
"""
import numpy as np

MIN_LAP_SECONDS = 30   # two line crossings closer than this are the same crossing


def fastest_lap_path(race):
    """(N, 2) array with the X/Y path of the car during the fastest lap of the race.
    Used as the outline of the track (and as the reference line for measuring progress)."""
    laps = race.laps.dropna(subset=["lap_duration", "t_start"])
    laps = laps[~laps["is_pit_out_lap"].astype(bool)]
    laps = laps[laps["driver_number"].isin(race.location.keys())]
    best = laps.loc[laps["lap_duration"].idxmin()]
    loc = race.location[int(best["driver_number"])]
    one_lap = loc[(loc["t"] >= best["t_start"]) & (loc["t"] <= best["t_start"] + best["lap_duration"])]
    return one_lap[["x", "y"]].to_numpy(dtype=float)


def find_line(race):
    """(x, y) of the start/finish line, in the data's units (1/10 metre).

    Every lap start that OpenF1 lists for the winner is a real crossing of the line (even
    when its lap *number* is wrong), so the median of those positions is the line.
    The median ignores the odd bad row.
    """
    loc = race.location[race.winner]
    listed = race.laps[(race.laps["driver_number"] == race.winner) & (race.laps["lap_number"] >= 2)]
    listed = listed.dropna(subset=["t_start"])
    x = np.median(np.interp(listed["t_start"], loc["t"], loc["x"]))
    y = np.median(np.interp(listed["t_start"], loc["t"], loc["y"]))
    return x, y


def line_crossings(loc, line):
    """Times (seconds since lights-out) at which a car passes the start/finish line."""
    # Distance in metres from the car to the line, sampled every 0.5 s.
    # Start at 30 s: before that the cars are still on the grid next to the line.
    times = np.arange(30, loc["t"].max(), 0.5)
    dist = np.hypot(np.interp(times, loc["t"], loc["x"]) - line[0],
                    np.interp(times, loc["t"], loc["y"]) - line[1]) / 10

    # Each time the car comes within 60 m of the line is one "visit"; the crossing is the
    # closest sample of that visit. (A pit stop is also one visit, so it still counts once.)
    near = dist < 60
    crossings = []
    i = 0
    while i < len(times):
        if near[i]:
            j = i
            while j < len(times) and near[j]:
                j += 1
            crossings.append(float(times[i + np.argmin(dist[i:j])]))
            i = j
        else:
            i += 1

    # A car that stops in a pit box next to the line can leave the 60 m zone and come back, which
    # makes a second "visit" a few seconds after the first (seen in Australia 2026: 1.5 to 3 s).
    # No car completes a lap that fast, so the later one is dropped. Without this, every later
    # lap of that driver would be shifted by one.
    kept = []
    for t in crossings:
        if not kept or t - kept[-1] >= MIN_LAP_SECONDS:
            kept.append(t)
    return kept


def lap_timing_by_driver(race):
    """{driver_number: {"starts": [start of lap 1, lap 2, ...], "finish": time or None}}
    for every driver who started.

    The last crossing of a finisher is the chequered flag, so it does not start a lap but it
    is the driver's finish time. A driver who retired has no finish time and is in lap
    (laps completed + 1) when the race ends for them.
    """
    line = find_line(race)
    timing = {}
    for _, row in race.results.iterrows():
        number = int(row["driver_number"])
        if number not in race.location or row["dns"]:
            continue
        crossings = line_crossings(race.location[number], line)
        done = int(row["number_of_laps"] or 0)
        retired = bool(row["dnf"] or row["dsq"])
        # Cap the list: a car parked in its garage next to the line would otherwise
        # look like it keeps crossing the line.
        keep = done if retired else done - 1
        finish = None
        if not retired and 0 < done <= len(crossings):
            finish = round(crossings[done - 1], 1)
        timing[number] = {
            "starts": [0.0] + [round(t, 1) for t in crossings[:max(keep, 0)]],
            "finish": finish,
        }
    return timing
