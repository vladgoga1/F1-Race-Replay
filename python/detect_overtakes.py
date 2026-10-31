"""Automatic overtake detection.

Step 1 - candidates. The official race order (OpenF1 `position`) only changes when two cars
swap places, so we look for pairs (A, B) where A was behind B and is now ahead of B.
That order is noisy right after the start and also changes for reasons that are not overtakes,
so every candidate must pass these checks:

  - pit stops: a car that stops "loses" places and the others "gain" them (window around the stop)
  - retirements: a stopped car is passed by everyone behind it
  - penalties: time penalties re-order the result after the cars have finished, so swaps after a
    driver's own chequered flag are ignored. Drive-through / stop-go penalties are served in the
    pit lane, so the pit stop window covers them.
  - red flags: the cars park in the pit lane and the order there means nothing
  - a real pass on the track: we measure how far along the lap each car is (its "progress")
    and require that A really was behind B a few seconds before and really is ahead a few
    seconds after. The moment the progress difference crosses zero is the moment of the pass.

(A version that used only the physical order, without the official one, found about twice as
many "overtakes", most of them cars running side by side, so the official order is kept as the
source of candidates.)

Step 2 - details of every surviving overtake: lap, nearest corner, speed difference at the
moment of the pass, DRS state (up to 2025) and the gap to the car ahead (for the 2026
Overtake Mode estimate).
"""
import numpy as np

import lap_timing
from detect_events import abbr_map, lap_at
from geometry import TrackPath, rotate

PIT_MARGIN = 40          # seconds before / after a pit stop in which swaps are ignored
DEFAULT_PIT_LANE = 25    # seconds, used when OpenF1 has no (or an absurd) pit lane duration
RETIRE_MARGIN = 30       # swaps within this many seconds before a retirement are ignored
STABLE_SECONDS = 3       # a new order must still hold this many seconds later (removes flicker)
SAME_PASS_SECONDS = 20   # the same pair passing again within this time counts as the same pass
PROGRESS_STEP = 0.5      # seconds between progress samples
BEFORE_WINDOW = (-16, -12)   # seconds relative to the registered swap: A must be behind here...
AFTER_WINDOW = (3, 6)        # ...and ahead here
SEARCH_WINDOW = (-14, 4)     # where we look for the moment the cars were level
DRS_OPEN = (10, 12, 14)  # values of the OpenF1 `drs` channel that mean "flap open"
DRS_AVAILABLE = 8        # detected inside a zone, within 1 s: allowed to open it


# --- candidates from the official order -------------------------------------------------------

def position_table(race, numbers, ticks):
    """Race position of every driver at every tick (rows = ticks, columns = drivers).

    A position stays valid until the next change, so for each tick we take the last value at or
    before it (np.searchsorted finds that index; it is a binary search, like bisect in Python).
    """
    table = np.full((len(ticks), len(numbers)), np.nan)
    for col, number in enumerate(numbers):
        rows = race.positions[race.positions["driver_number"] == number].sort_values("t")
        if rows.empty:
            continue
        last = np.searchsorted(rows["t"].to_numpy(), ticks, side="right") - 1
        last = np.maximum(last, 0)    # before the first row: use the first known position
        table[:, col] = rows["position"].to_numpy(dtype=float)[last]
    return table


def ahead_matrix(positions):
    """Matrix M where M[i, j] = +1 if driver i is ahead of driver j, -1 if behind, 0 if unknown/tied."""
    return np.nan_to_num(np.sign(positions[None, :] - positions[:, None]))


def position_swaps(table):
    """List of (tick, i, j): driver i moved ahead of driver j at that tick.

    Two things make the order noisy: positions of two cars are not always updated in the same
    instant (for a moment both show the same position), and right after the start the order
    flickers. So a pair only counts as "changed" when the new order is clear (no tie) and still
    the same STABLE_SECONDS later; we remember the last such order of every pair.
    """
    swaps = []
    last = ahead_matrix(table[0])
    for k in range(1, len(table)):
        now = ahead_matrix(table[k])
        later = ahead_matrix(table[min(k + STABLE_SECONDS, len(table) - 1)])
        stable = (now == later) & (now != 0)
        for i, j in zip(*np.where(stable & (now == 1) & (last == -1))):
            swaps.append((k, int(i), int(j)))
        last = np.where(stable, now, last)
    return swaps


def pit_windows(race):
    """{driver_number: [(from, to), ...]}: times in which that driver's position changes are
    caused by a pit stop."""
    windows = {}
    for _, p in race.pits.iterrows():
        lane = p["lane_duration"]
        lane = DEFAULT_PIT_LANE if np.isnan(lane) or lane > 60 else lane
        windows.setdefault(int(p["driver_number"]), []).append(
            (p["t"] - PIT_MARGIN, p["t"] + lane + PIT_MARGIN))
    return windows


def in_window(windows, t):
    return any(a <= t <= b for a, b in windows)


# --- physical check: progress along the lap ---------------------------------------------------

def progress_table(race, numbers, path, duration):
    """{driver_number: progress along the lap, sampled every PROGRESS_STEP seconds}."""
    grid = np.arange(0, duration, PROGRESS_STEP)
    table = {}
    for number in numbers:
        loc = race.location[number]
        table[number] = path.progress(np.interp(grid, loc["t"], loc["x"]),
                                      np.interp(grid, loc["t"], loc["y"]))
    return grid, table


def physical_pass(grid, progress_a, progress_b, lap_length, t):
    """Did A really pass B around time t? Returns the time they were level, or None.

    d = how far A is ahead of B along the track (negative = behind). The difference is
    wrapped into [-L/2, L/2] so that a car just before the line and one just after it are
    "close", not a whole lap apart.
    """
    d = (progress_a - progress_b + lap_length / 2) % lap_length - lap_length / 2

    def window(a, b):                                      # samples between t+a and t+b
        first = max(int((t + a) / PROGRESS_STEP), 0)
        last = max(int((t + b) / PROGRESS_STEP), 0) + 1
        return d[first:last]

    before, after = window(*BEFORE_WINDOW), window(*AFTER_WINDOW)
    if len(before) == 0 or len(after) == 0 or np.median(before) >= 0 or np.median(after) <= 0:
        return None

    first = max(int((t + SEARCH_WINDOW[0]) / PROGRESS_STEP), 0)
    segment = d[first:int((t + SEARCH_WINDOW[1]) / PROGRESS_STEP) + 1]
    crossings = np.where((segment[:-1] < 0) & (segment[1:] >= 0))[0]
    if len(crossings):
        k = first + crossings[-1]                          # last time A went from behind to ahead
        # Linear interpolation (see replay.js in the web page) to find where d reaches 0.
        return float(grid[k] + PROGRESS_STEP * (-d[k]) / (d[k + 1] - d[k]))
    return float(grid[first + int(np.argmin(np.abs(segment)))])   # no clean crossing: closest moment


# --- details of an overtake -------------------------------------------------------------------

def drs_state(car_data, t):
    """'open', 'available' or 'closed', from the DRS channel in the 6 s before t.
    None if there is no telemetry. (From 2026 the channel is empty: DRS no longer exists.)"""
    if car_data is None or car_data["drs"].isna().all():
        return None
    window = car_data[(car_data["t"] >= t - 6) & (car_data["t"] <= t)]["drs"]
    if window.isin(DRS_OPEN).any():
        return "open"
    if (window == DRS_AVAILABLE).any():
        return "available"
    return "closed"


def mode_switches(race):
    """[(time, enabled)] from the race control messages "DRS ENABLED" / "DRS DISABLED" (up to 2025)
    and "OVERTAKE ENABLED" / "OVERTAKE DISABLED" (2026). Messages about one DRS zone only are skipped.
    Both systems are off for the first laps and during safety car periods."""
    switches = []
    for row in race.race_control.sort_values("t").itertuples():
        message = str(row.message).upper()
        if "ZONE" in message or not ("DRS" in message or "OVERTAKE" in message):
            continue
        if "DISABLED" in message:
            switches.append((row.t, False))
        elif "ENABLED" in message:
            switches.append((row.t, True))
    return switches


def mode_enabled(switches, t):
    """True / False if DRS (or Overtake Mode) was switched on / off at time t, None if unknown."""
    state = None
    for time, enabled in switches:
        if time <= t:
            state = enabled
    return state


def interval_before(race, number, t):
    """Gap in seconds to the car ahead, 2 s before t. None if unknown or lapped (text)."""
    rows = race.intervals[(race.intervals["driver_number"] == number) & (race.intervals["t"] <= t - 2)]
    if rows.empty:
        return None
    value = rows.sort_values("t")["interval"].iloc[-1]
    return round(float(value), 3) if isinstance(value, (int, float)) and not np.isnan(value) else None


def nearest_corner(corners, x, y):
    """Label like 'T4' (or 'T4A') of the corner closest to (x, y), in the raw data frame."""
    if corners is None:
        return None
    distance = np.hypot(corners["X"] - x, corners["Y"] - y)
    c = corners.loc[distance.idxmin()]
    return f"T{int(c['Number'])}{c['Letter']}"


def detect_overtakes(race, timing, retire_times, red_flags, duration, corners, rotation):
    """red_flags: list of (start, end) times in which the race was stopped."""
    abbr = abbr_map(race)
    numbers = [n for n in timing if n in race.location]        # drivers who started
    ticks = np.arange(0, duration, 1.0)

    swaps = position_swaps(position_table(race, numbers, ticks))
    pits = pit_windows(race)
    switches = mode_switches(race)

    path = TrackPath(lap_timing.fastest_lap_path(race))
    grid, progress = progress_table(race, numbers, path, duration)

    rejected = {"pit stop": 0, "retirement": 0, "after finish": 0, "red flag": 0,
                "no pass on track": 0, "repeat": 0}
    overtakes = []
    last_pass = {}      # (a, b) -> time of the previous accepted pass of that pair
    for tick, i, j in swaps:
        t = float(ticks[tick])
        a, b = numbers[i], numbers[j]          # a moved ahead of b

        if in_window(pits.get(a, []), t) or in_window(pits.get(b, []), t):
            rejected["pit stop"] += 1
            continue
        if any(n in retire_times and retire_times[n] <= t + RETIRE_MARGIN for n in (a, b)):
            rejected["retirement"] += 1
            continue
        if any(timing[n]["finish"] is not None and t > timing[n]["finish"] for n in (a, b)):
            rejected["after finish"] += 1
            continue
        if in_window(red_flags, t):
            rejected["red flag"] += 1
            continue

        t_pass = physical_pass(grid, progress[a], progress[b], path.length, t)
        if t_pass is None:
            rejected["no pass on track"] += 1
            continue
        if (a, b) in last_pass and t_pass - last_pass[(a, b)] < SAME_PASS_SECONDS:
            rejected["repeat"] += 1
            continue
        last_pass[(a, b)] = t_pass

        # Positions of both cars at the moment they were level; the overtake is marked in between.
        loc_a, loc_b = race.location[a], race.location[b]
        mid_x = (np.interp(t_pass, loc_a["t"], loc_a["x"]) + np.interp(t_pass, loc_b["t"], loc_b["x"])) / 2
        mid_y = (np.interp(t_pass, loc_a["t"], loc_a["y"]) + np.interp(t_pass, loc_b["t"], loc_b["y"])) / 2

        telemetry = {n: race.car_data.get(n) for n in (a, b)}
        speed_diff = None
        if telemetry[a] is not None and telemetry[b] is not None:
            speed_a = np.interp(t_pass, telemetry[a]["t"], telemetry[a]["speed"])
            speed_b = np.interp(t_pass, telemetry[b]["t"], telemetry[b]["speed"])
            speed_diff = int(round(speed_a - speed_b))

        x, y = rotate(np.array([[mid_x, mid_y]]), rotation)[0]
        overtakes.append({
            "t": round(t_pass, 1),
            "type": "overtake",
            "lap": lap_at(timing[a]["starts"], t_pass),
            "attacker": abbr[a],
            "defender": abbr[b],
            "corner": nearest_corner(corners, mid_x, mid_y),
            "speedDiff": speed_diff,                      # km/h, attacker minus defender
            "drs": drs_state(telemetry[a], t_pass),       # None from 2026 (no DRS)
            "modeEnabled": mode_enabled(switches, t_pass),  # was DRS / Overtake Mode switched on?
            "gap": interval_before(race, a, t_pass),      # seconds behind the defender just before
            "x": int(x),
            "y": int(y),
            "label": f"{abbr[a]} passes {abbr[b]}",
        })

    overtakes.sort(key=lambda o: o["t"])
    print(f"  Overtakes: {len(overtakes)} kept of {len(swaps)} position swaps; rejected: "
          + ", ".join(f"{n} {reason}" for reason, n in rejected.items()))
    return overtakes


def cross_check(race, overtakes, tolerance=20):
    """Compare our list with OpenF1's own `overtakes` data (same pair within `tolerance` seconds).

    The two lists are made in different ways, so we do not expect them to be identical; the
    numbers tell us roughly how far apart they are.
    """
    abbr = abbr_map(race)
    theirs = [(abbr.get(int(r.overtaking_driver_number)), abbr.get(int(r.overtaken_driver_number)), r.t)
              for r in race.openf1_overtakes.itertuples()]

    def close(pair_a, t_a, pair_b, t_b):
        return pair_a == pair_b and abs(t_a - t_b) <= tolerance

    ours = [((o["attacker"], o["defender"]), o["t"]) for o in overtakes]
    matched = sum(any(close(p, t, (x, y), s) for x, y, s in theirs) for p, t in ours)
    their_matched = sum(any(close(p, t, (x, y), s) for p, t in ours) for x, y, s in theirs)
    stats = {"ours": len(ours), "openf1": len(theirs),
             "oursFoundInOpenf1": matched, "openf1FoundInOurs": their_matched}
    print(f"  Cross-check with OpenF1: {stats}")
    return stats
