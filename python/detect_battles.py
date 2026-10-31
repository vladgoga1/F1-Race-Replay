"""Battles: two cars that run one behind the other, less than a second apart, for several laps.

A battle is not an overtake: it is the build-up. The list says who followed whom, from when to
when, and how many times they swapped places in the meantime. In the seasons with DRS the car
behind is inside the DRS window all that time; in 2026 it would be in Overtake Mode range (an
estimate: the real data has no channel for it).

Everything is read from the same step series as the live leaderboard (standings.json):
the official race position of every driver and his interval to the car ahead.
"""
import numpy as np

CLOSE_SECONDS = 1.0     # "close" = the interval to the car ahead is at most this
MIN_LAPS = 3            # a battle lasts at least this many laps (of the median lap time)
MERGE_GAP = 20          # seconds: a pair that loses contact for less than this is still the same battle
CLOSE_SHARE = 0.6       # ... and it must be close during at least this share of its duration
PIT_BEFORE, PIT_AFTER = 20, 30   # seconds around a pit stop ignored (the intervals are meaningless there)


def sample_step(series, grid, numbers_only):
    """Value of a { t: [...], v: [...] } step series at every time of `grid` (NaN where unknown).
    numbers_only: text values such as "+1 LAP" also become NaN."""
    out = np.full(len(grid), np.nan)
    if not series:
        return out
    t = np.array(series["t"])
    values = np.array([v if isinstance(v, (int, float)) else np.nan for v in series["v"]], dtype=float)
    index = np.searchsorted(t, grid, side="right") - 1      # last change at or before each time
    known = index >= 0
    out[known] = values[index[known]]
    return out


def detect_battles(race, standings, timing, retire_times, events, duration):
    """Returns a list of { ahead, behind, t, end, lap, laps, position, avgGap, minGap, swaps }.
    ahead / behind = who was in front at the start of the battle."""
    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    drivers = [a for a in abbr_of.values() if a in standings["position"]]
    grid = np.arange(0, int(duration), 1.0)

    position = np.array([sample_step(standings["position"][a], grid, True) for a in drivers])
    gap = np.array([sample_step(standings["interval"].get(a), grid, True) for a in drivers])

    # Moments when a driver's gap cannot be trusted: pit stop, retired, finished, safety car.
    unusable = np.zeros((len(drivers), len(grid)), dtype=bool)
    for i, abbr in enumerate(drivers):
        number = next(n for n, a in abbr_of.items() if a == abbr)
        for t in race.pits[race.pits["driver_number"] == number]["t"]:
            unusable[i, max(int(t - PIT_BEFORE), 0):max(int(t + PIT_AFTER), 0)] = True
        end = retire_times.get(number)
        if end is None and number in timing and timing[number]["finish"] is not None:
            end = timing[number]["finish"] - 1
        if end is not None:
            unusable[i, max(int(end), 0):] = True
    for e in events:
        if e["type"] in ("sc", "vsc", "red"):
            stop = e["end"] if e.get("end") is not None else duration
            # the restart takes a while to settle: add 10 s after the end
            unusable[:, max(int(e["t"]), 0):int(stop) + 10] = True

    # The first lap is skipped: after the start everybody is close to everybody.
    lap_starts = timing[race.winner]["starts"]
    first = int(lap_starts[1]) if len(lap_starts) > 1 else 60
    median_lap = float(np.median(np.diff(lap_starts))) if len(lap_starts) > 2 else 90.0

    # For every second, which pairs (car ahead, car behind) are close.
    close = {}                  # (ahead index, behind index) -> seconds, with the order of that moment
    for s in range(first, len(grid)):
        order = np.argsort(np.where(np.isnan(position[:, s]), 99, position[:, s]))
        for k in range(len(order) - 1):
            front, back = order[k], order[k + 1]
            if np.isnan(position[back, s]) or position[back, s] - position[front, s] != 1:
                continue
            if unusable[back, s] or unusable[front, s]:
                continue
            if gap[back, s] <= CLOSE_SECONDS:                # NaN <= 1 is False, so lapped cars are out
                close.setdefault(frozenset((front, back)), []).append((s, int(front), float(gap[back, s])))

    overtakes = [e for e in events if e["type"] == "overtake"]
    battles = []
    for pair, rows in close.items():
        rows.sort()
        # Split into runs: a break longer than MERGE_GAP starts a new battle.
        runs, run = [], [rows[0]]
        for row in rows[1:]:
            if row[0] - run[-1][0] > MERGE_GAP:
                runs.append(run)
                run = []
            run.append(row)
        runs.append(run)

        for run in runs:
            start, end = run[0][0], run[-1][0]
            span = end - start
            if span < MIN_LAPS * median_lap or len(run) < CLOSE_SHARE * span:
                continue
            front = run[0][1]
            other = next(iter(pair - {front}))
            names = {drivers[front], drivers[other]}
            swaps = sum(1 for o in overtakes
                        if start - 5 <= o["t"] <= end + 5 and {o["attacker"], o["defender"]} == names)
            gaps = [r[2] for r in run]
            battles.append({
                "ahead": drivers[front],
                "behind": drivers[other],
                "t": start,
                "end": end,
                "lap": int(np.searchsorted(lap_starts, start, side="right")),
                "laps": round(span / median_lap, 1),
                "position": int(position[front, start]),
                "avgGap": round(float(np.mean(gaps)), 2),
                "minGap": round(float(np.min(gaps)), 2),
                "swaps": swaps,
            })
    battles.sort(key=lambda b: b["t"])
    print(f"  Battles: {len(battles)} (a pair less than {CLOSE_SECONDS:g} s apart for {MIN_LAPS}+ laps)")
    return battles
