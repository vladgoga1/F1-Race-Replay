"""Detects the timeline events (everything except overtakes).

Each event is a dict: {"t": seconds since lights-out, "type": ..., "label": text, ...}
Types: pit, sc (safety car), vsc (virtual safety car), yellow, red, dnf (retirement), fastest.
Spans (safety car, flags) also have an "end" time.
"""
from bisect import bisect_right

import numpy as np

# The car counts as "stopped" once it is closer than this to where it finally parked (1/10 m).
PARKED_DISTANCE = 300


def abbr_map(race):
    return dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))


def lap_at(starts, t):
    """Lap number (1-based) in progress at time t, given the lap start times of a driver."""
    return max(bisect_right(starts, t), 1)


def retirement_times(race, timing):
    """{driver_number: time the car came to rest} for drivers who did not finish.

    OpenF1 only says "dnf" for the whole race, not when. We find the last moment the car was
    still more than 30 m from the place where it finally stopped.
    """
    times = {}
    for _, row in race.results.iterrows():
        number = int(row["driver_number"])
        if not (row["dnf"] or row["dsq"]) or number not in race.location or number not in timing:
            continue
        loc = race.location[number]
        away = np.hypot(loc["x"] - loc["x"].iloc[-1], loc["y"] - loc["y"].iloc[-1]) > PARKED_DISTANCE
        if away.any():
            times[number] = float(loc["t"][away[away].index[-1]])
    return times


def format_lap_time(seconds):
    minutes, rest = divmod(seconds, 60)
    return f"{int(minutes)}:{rest:06.3f}"


def pit_events(race, timing):
    abbr = abbr_map(race)
    events = []
    for _, p in race.pits.iterrows():
        number = int(p["driver_number"])
        if number not in timing:
            continue
        stop = p.get("stop_duration")
        has_stop = stop is not None and not np.isnan(stop)
        events.append({
            "t": round(float(p["t"]), 1),
            "type": "pit",
            "driver": abbr[number],
            "lap": lap_at(timing[number]["starts"], p["t"]),
            "label": f"{abbr[number]} pit stop" + (f" ({stop:.1f} s)" if has_stop else ""),
        })
    return events


def fastest_lap_event(race, timing):
    laps = race.laps.dropna(subset=["lap_duration", "t_start"])
    laps = laps[~laps["is_pit_out_lap"].astype(bool)]
    laps = laps[laps["driver_number"].isin(timing.keys())]
    best = laps.loc[laps["lap_duration"].idxmin()]
    number = int(best["driver_number"])
    t = float(best["t_start"] + best["lap_duration"])   # the moment the lap is completed
    abbr = abbr_map(race)[number]
    return {
        "t": round(t, 1),
        "type": "fastest",
        "driver": abbr,
        "lap": lap_at(timing[number]["starts"], t - 1),
        "label": f"Fastest lap: {abbr} {format_lap_time(best['lap_duration'])}",
    }


def retirement_events(race, timing, retire_times):
    abbr = abbr_map(race)
    return [{
        "t": round(t, 1),
        "type": "dnf",
        "driver": abbr[number],
        "lap": lap_at(timing[number]["starts"], t),
        "label": f"{abbr[number]} retired",
    } for number, t in retire_times.items()]


def race_control_events(race, duration):
    """Safety car, virtual safety car, yellow and red flags from the race control messages.

    These are messages like "YELLOW IN TRACK SECTOR 7" ... "CLEAR IN TRACK SECTOR 7", so we
    remember when something starts and close it (give it an "end") when the matching
    message arrives.
    """
    events = []
    open_span = {}   # key ("sc", "vsc", "red", "yellow-7") -> the event still waiting for its end

    def start(key, t, lap, type_, label):
        if key in open_span:
            return
        event = {"t": round(float(t), 1), "type": type_, "lap": lap, "label": label, "end": None}
        open_span[key] = event
        events.append(event)

    def end(key, t):
        event = open_span.pop(key, None)
        if event:
            event["end"] = round(float(t), 1)

    for row in race.race_control.sort_values("t").itertuples():
        message = str(row.message).upper()
        flag = row.flag if isinstance(row.flag, str) else ""
        scope = row.scope if isinstance(row.scope, str) else ""
        lap = None if np.isnan(row.lap_number) else int(row.lap_number)

        if row.category == "SafetyCar" or "SAFETY CAR" in message:
            # "VSC DEPLOYED" / "VIRTUAL SAFETY CAR DEPLOYED" / "SAFETY CAR DEPLOYED" ...
            virtual = "VSC" in message or "VIRTUAL" in message
            key = "vsc" if virtual else "sc"
            if "DEPLOYED" in message:
                start(key, row.t, lap, key, "Virtual safety car" if virtual else "Safety car")
            elif "ENDING" in message or "IN THIS LAP" in message:
                end(key, row.t)
        elif flag == "RED":
            start("red", row.t, lap, "red", "Red flag")
        elif (row.category == "SessionStatus" and "STARTED" in message) or (flag == "GREEN" and scope == "Track"):
            end("red", row.t)           # the session restarts after a red flag
        elif flag in ("YELLOW", "DOUBLE YELLOW") and scope == "Sector":
            sector = int(row.sector)
            name = "Double yellow" if flag == "DOUBLE YELLOW" else "Yellow flag"
            start(f"yellow-{sector}", row.t, lap, "yellow", f"{name}, sector {sector}")
        elif flag == "CLEAR" and scope == "Sector":
            end(f"yellow-{int(row.sector)}", row.t)
        elif flag == "CLEAR" and scope == "Track":
            for key in [k for k in open_span if k.startswith("yellow")]:
                end(key, row.t)

    # Drop what happened before lights-out (warm-up laps) and cut spans at 0.
    kept = []
    for e in events:
        if e["end"] is not None and e["end"] <= 0:
            continue
        e["t"] = max(e["t"], 0.0)
        if e["t"] > duration:
            continue
        kept.append(e)
    return kept


def detect_events(race, timing, duration):
    """Returns (events, retire_times). retire_times is also needed by the overtake detector."""
    retire_times = retirement_times(race, timing)
    events = (pit_events(race, timing)
              + race_control_events(race, duration)
              + retirement_events(race, timing, retire_times)
              + [fastest_lap_event(race, timing)])
    return events, retire_times
