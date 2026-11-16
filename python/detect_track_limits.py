"""Track limits and "leaving the track" incidents, from the race control messages.

WHY ONLY RACE CONTROL: OpenF1 snaps every car position to one line (see track_line.py), so the
X/Y data cannot show a car going off the track. The race director's messages are the only source:

  "CAR 5 (BOR) TIME 1:28.993 DELETED - TRACK LIMITS AT TURN 1 LAP 15 14:24:36"
  "CAR 51 (CAM) LAP DELETED - TRACK LIMITS AT TURN 1 LAP 15 14:24:39 (PIT)"
  "TURN 5 INCIDENT INVOLVING CAR 44 (HAM) NOTED - LEAVING THE TRACK AND GAINING AN ADVANTAGE (14:04:04)"
  "FIA STEWARDS: TURN 5 INCIDENT INVOLVING CAR 44 (HAM) UNDER INVESTIGATION - LEAVING THE ... (14:04:04)"
  "FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 27 (HUL) - LEAVING THE TRACK AND GAINING ... (15:09:09)"

The messages of one incident (noted -> under investigation -> no further action / penalty) become
ONE event with the latest outcome.

WHEN: a message is published some time after the fact (a deleted lap time ~10-60 s later, a
stewards' decision many minutes later). The clock time written in the text (14:24:36, local time
at the track) is the moment it happened, so the event is placed there (see ClockConverter), or
more exactly at the moment the car went through that turn, if that was within 10 s of it.
Older messages (2023-2025 incidents) have no clock time: then the event is placed at the last time
the driver went through that turn before the first message (see passage_times).

WHERE: at the turn named in the message (the corner position of track.json), not the exact spot:
the data does not have the exact spot. A message without a turn uses the car's position.

Every event: {"t", "type": "limits", "driver", "drivers", "turn", "lap", "what", "label", "x", "y",
"published" (time of the first message), "timeFrom" ("clock" / "turn pass" / "message")}.
"""
import re

import numpy as np
import pandas as pd

import track_line
from detect_events import abbr_map, lap_at
from geometry import rotate

# "(BOR) TIME 1:28.993 DELETED - TRACK LIMITS AT TURN 1" or "(CAM) LAP DELETED - TRACK LIMITS AT TURN 1".
# (?:A|B) is a group that is not captured: either "TIME <lap time>" or the word "LAP".
DELETED = re.compile(r"\(([A-Z]{3})\) (?:TIME ([\d:.]+)|LAP) DELETED - TRACK LIMITS AT TURN (\d+)")
TURN = re.compile(r"\bTURN (\d+)\b")                   # "TURN 5 INCIDENT ..." -> 5
CLOCK = re.compile(r"\b(\d{1,2}):(\d{2}):(\d{2})\b")   # "14:24:36" (a lap time "1:28.993" has one colon only)
DRIVER = re.compile(r"\(([A-Z]{3})\)")                 # "CAR 44 (HAM)" -> HAM
PENALTY = re.compile(r"(\d+) SECOND TIME PENALTY")     # "10 SECOND TIME PENALTY" -> 10

# A clock time that gives a moment more than this after the message itself is not believed
# (a message cannot come before the fact); a few seconds of slack for rounding.
CLOCK_SLACK = 5
# Seconds: a pass of the car through the turn this close to the clock time is taken as the moment.
SNAP_TO_PASS = 10


def outcome_of(message):
    """What the stewards said, in a few words (None if the message does not say)."""
    penalty = PENALTY.search(message)
    if penalty:
        return f"{penalty.group(1)} s penalty"
    if "DRIVE THROUGH" in message:
        return "drive-through penalty"
    if "STOP AND GO" in message or "STOP-AND-GO" in message:
        return "stop-and-go penalty"
    if "REPRIMAND" in message:
        return "reprimand"
    if "NO FURTHER ACTION" in message:
        return "no further action"
    if "NO FURTHER INVESTIGATION" in message:
        return "not investigated"
    if "AFTER THE RACE" in message:
        return "investigated after the race"
    if "UNDER INVESTIGATION" in message:
        return "under investigation"
    if "NOTED" in message:
        return "noted"
    return None


class ClockConverter:
    """Turns a clock time of the text ("14:24:36", local time at the track) into race time.

    The race starts at race.start (UTC). OpenF1 gives the track's time zone as `gmt_offset` of the
    session (e.g. "-03:00:00" for São Paulo), so the local clock time of lights-out is
    start + gmt_offset. Race time of a clock time = its seconds since midnight minus those of
    lights-out (wrapped to +-12 h for a race that crosses midnight).
    """

    def __init__(self, race):
        offset = pd.to_timedelta(race.session.get("gmt_offset") or "00:00:00")
        local_start = race.start + offset
        self.start_of_day = local_start.hour * 3600 + local_start.minute * 60 + local_start.second \
            + local_start.microsecond / 1e6

    def race_time(self, text):
        found = CLOCK.findall(text)
        if not found:
            return None
        h, m, s = (int(v) for v in found[-1])     # the last one: the time of the fact
        seconds = h * 3600 + m * 60 + s - self.start_of_day
        return (seconds + 43200) % 86400 - 43200   # into -12 h .. +12 h


def passage_times(line, number, corner_distance):
    """Every moment (race time) the car went through the point at `corner_distance` along the
    line. From the raw samples on the line: where the distance relative to the corner changes
    from negative (before it) to positive (after it), interpolated between the two samples."""
    if number not in line.cars:
        return np.array([])
    t, distance, offset = line.cars[number]
    on = offset < track_line.ON_LINE
    t, distance = t[on], distance[on]
    length = line.path.length
    # Distance from the corner within the lap, in -length/2 .. +length/2 (negative = before it).
    rel = (distance - corner_distance + length / 2) % length - length / 2
    # A step from before to after, small (not the jump on the far side of the lap) and without a
    # hole in the data (pit lane, missing samples).
    cross = (rel[:-1] < 0) & (rel[1:] >= 0) & (rel[1:] - rel[:-1] < length / 4) \
        & (np.diff(t) <= track_line.MAX_GAP)
    i = np.nonzero(cross)[0]
    fraction = -rel[i] / (rel[i + 1] - rel[i])
    return t[i] + fraction * (t[i + 1] - t[i])


class Places:
    """Positions of the turns, and the cars' passages through them."""

    def __init__(self, race, line, corners, rotation):
        self.race = race
        self.line = line
        self.rotation = rotation
        self.corners = {}                          # turn number -> (x, y); "9A" and "9B": the first
        for c in corners:
            self.corners.setdefault(c["n"], (c["x"], c["y"]))
        self.distance = {}                         # turn number -> distance along the line
        for n, (x, y) in self.corners.items():
            self.distance[n] = float(line.path.project([x], [y])[0][0])

    def car_xy(self, number, t):
        """Position of the car at time t (rotated like the map), or None."""
        loc = self.race.location.get(number)
        if loc is None or loc.empty:
            return None
        xy = np.array([[np.interp(t, loc["t"], loc["x"]), np.interp(t, loc["t"], loc["y"])]])
        x, y = rotate(xy, self.rotation)[0]
        return int(x), int(y)

    def passages(self, number, turn):
        if turn not in self.distance:
            return np.array([])
        return passage_times(self.line, number, self.distance[turn])


def detect_track_limits(race, timing, line, corners, rotation, duration):
    """Returns (events, report). report = numbers for the check printed during the export."""
    numbers = {abbr: number for number, abbr in abbr_map(race).items()}
    clock = ClockConverter(race)
    places = Places(race, line, corners, rotation)
    events = []
    merged = 0

    for row in race.race_control.sort_values("t").itertuples():
        text = str(row.message).upper()
        published = float(row.t)
        deleted = DELETED.search(text)
        leaving = "LEAVING THE TRACK" in text and "PENALTY SERVED" not in text
        if not deleted and not leaving:
            continue

        drivers = [d for d in DRIVER.findall(text) if d in numbers]
        if not drivers:
            continue
        turn_match = TURN.search(text)
        turn = int(deleted.group(3)) if deleted else int(turn_match.group(1)) if turn_match else None
        when = clock.race_time(text)
        if when is not None and when > published + CLOCK_SLACK:
            when = None                            # impossible (after the message): don't believe it

        if deleted:
            what = "time deleted" if deleted.group(2) else "lap deleted"
            events.append({"published": published, "clock": when, "driver": drivers[0],
                           "drivers": drivers[:1], "turn": turn, "what": what,
                           "detail": f"lap time {deleted.group(2)}" if deleted.group(2) else ""})
            continue

        # Leaving the track: the same incident as an earlier message? Same clock time (or both
        # without one), at least one driver in common, and not a different turn.
        outcome = outcome_of(text)
        same = None
        for e in events:
            if (e["what"] == "leaving" and e["clock"] == when and set(e["drivers"]) & set(drivers)
                    and (e["turn"] is None or turn is None or e["turn"] == turn)):
                same = e
        if same:
            merged += 1
            if outcome:
                same["outcome"] = outcome
            if same["turn"] is None:
                same["turn"] = turn
            same["drivers"] += [d for d in drivers if d not in same["drivers"]]
        else:
            events.append({"published": published, "clock": when, "driver": drivers[0],
                           "drivers": drivers, "turn": turn, "what": "leaving",
                           "outcome": outcome or "noted", "detail": ""})

    # Time and place of every event, and the text.
    out = []
    checks = []                                    # seconds between the clock time and the turn pass
    for e in events:
        number = numbers[e["driver"]]
        passes = places.passages(number, e["turn"]) if e["turn"] is not None else np.array([])
        if e["clock"] is not None:
            t, source = e["clock"], "clock"
            if len(passes):
                # The clock time has 1 s steps and the car is usually at the turn 1-3 s before it
                # (São Paulo 2026). When it went through the turn close to the clock time, use
                # that exact moment: the car is then at the marker when the event is shown.
                nearest = float(passes[np.argmin(np.abs(passes - t))])
                checks.append(nearest - t)
                if abs(nearest - t) <= SNAP_TO_PASS:
                    t = nearest
        else:
            earlier = passes[passes <= e["published"]]
            if len(earlier):
                t, source = float(earlier[-1]), "turn pass"
            else:
                t, source = e["published"], "message"
        if t < 0 or t > duration:
            continue

        if e["turn"] in places.corners:
            x, y = places.corners[e["turn"]]
        else:
            xy = places.car_xy(number, t)
            if xy is None:
                continue
            x, y = xy

        who = "/".join(e["drivers"])
        where = f" T{e['turn']}" if e["turn"] is not None else ""
        if e["what"] == "leaving":
            what = f"left the track and gained an advantage: {e['outcome']}"
            short = f"off track, advantage: {e['outcome']}"
        else:
            what = e["what"] + (f" ({e['detail']})" if e["detail"] else "")
            short = e["what"]
        out.append({
            "t": round(t, 1),
            "type": "limits",
            "driver": e["driver"],
            "drivers": e["drivers"],
            "turn": e["turn"],
            "lap": lap_at(timing[number]["starts"], t) if number in timing else None,
            "what": what,
            "label": f"{who}{where} · {short}",
            "x": int(x),
            "y": int(y),
            "published": round(e["published"], 1),
            "timeFrom": source,
        })

    report = {"events": len(out), "merged": merged, "checks": checks,
              "fromClock": sum(e["timeFrom"] == "clock" for e in out)}
    return out, report
