"""JSON for the live leaderboard: race order, gaps, tyre stints and pit stops.

Most of this data is "step" data: a value that stays the same until the next change
(your position is P3 until you are overtaken). We store only the changes as two parallel
lists, `t` (when) and `v` (the new value), and the browser looks up "the last change
at or before the current time".
"""
from bisect import bisect_right

import numpy as np


def plain(value):
    """Convert numpy/pandas values to plain Python ones. NaN becomes None,
    because NaN is not valid JSON."""
    if value is None:
        return None
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and np.isnan(value):
        return None
    return value


def step_series(table, column, abbr_of):
    """{abbr: {"t": [...], "v": [...]}} with only the moments where `column` changed."""
    out = {}
    for number, rows in table.sort_values("t").groupby("driver_number"):
        if number not in abbr_of:
            continue
        times, values = [], []
        for t, value in zip(rows["t"], rows[column]):
            value = plain(value)
            # Everything before lights-out collapses into the state at t = 0
            # (the starting grid), so the replay opens with a valid leaderboard.
            t = round(max(float(t), 0.0), 1)
            if times and times[-1] == t:
                values[-1] = value          # same moment: keep the newest value
            elif not values or values[-1] != value:
                times.append(t)
                values.append(value)
        out[abbr_of[number]] = {"t": times, "v": values}
    return out


def build_standings(race):
    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    return {
        # Official race position of each driver (1 = leader).
        "position": step_series(race.positions, "position", abbr_of),
        # Gap to the car ahead in seconds. For lapped cars OpenF1 gives text such as "+1 LAP";
        # the leader has 0 and a missing value is null.
        "interval": step_series(race.intervals, "interval", abbr_of),
    }


def merge_split_stints(stints, pit_count, abbr):
    """Make sure there are at most pit_count + 1 stints (a list of dicts, in order).

    OpenF1 sometimes cuts one real stint into two (same compound, no pit stop in between).
    We merge neighbours with the same compound; if that is not enough we drop the last
    stint and warn, because we cannot tell when that tyre change really happened.
    """
    stints = list(stints)
    while len(stints) > pit_count + 1:
        for i in range(1, len(stints)):
            if plain(stints[i]["compound"]) == plain(stints[i - 1]["compound"]):
                del stints[i]
                break
        else:
            print(f"  Warning: {abbr} has more tyre stints than pit stops; dropping the last stint.")
            stints.pop()
    return stints


def build_strategy(race, lap_starts):
    """Per driver: lap start times, tyre stints and pit stop times.

    Everything is based on times, not on OpenF1's lap numbers (which can be shifted).
    The browser derives "current lap" and "laps on this set of tyres" from these.
    """
    out = {"drivers": {}}
    for _, d in race.drivers.iterrows():
        number = int(d["driver_number"])
        starts = lap_starts.get(number, [0.0])
        # race.pits is already free of duplicates (see data_loader.clean_pits)
        pit_times = sorted(float(t) for t in race.pits[race.pits["driver_number"] == number]["t"])
        stints = race.stints[race.stints["driver_number"] == number].sort_values("stint_number")
        stints = merge_split_stints(stints.to_dict("records"), len(pit_times), d["name_acronym"])

        stint_list = []
        for i, s in enumerate(stints):
            # Stint i begins at pit stop i-1 (every pit stop changes the tyres).
            t = 0.0 if i == 0 else pit_times[i - 1]
            # First lap on this set: the lap in progress 10 s after the pit time. The pit time is
            # logged while the car is in the pit lane; 10 s later the line has been crossed
            # and the new lap (the out lap) has started.
            start_lap = max(bisect_right(starts, t + 10), 1) if i > 0 else 1
            stint_list.append({
                "compound": plain(s["compound"]),   # null when OpenF1 does not know it
                "t": round(t, 1),
                "startLap": start_lap,
                "age": int(plain(s["tyre_age_at_start"]) or 0),  # laps already on this set
            })

        if len(pit_times) != max(len(stint_list) - 1, 0):
            print(f"  Note: {d['name_acronym']} has {len(pit_times)} pit stops and {len(stint_list)} stints "
                  "(probably a drive-through or a stop without a tyre change).")

        out["drivers"][d["name_acronym"]] = {
            "laps": starts,
            "stints": stint_list,
            "pits": [round(t, 1) for t in pit_times],
        }
    return out
