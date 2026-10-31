"""Data fetching: finds a race on OpenF1 and loads everything the exporter needs."""
from dataclasses import dataclass

import pandas as pd

import openf1


@dataclass
class Race:
    """Everything we know about one race, in pandas tables."""
    session: dict        # OpenF1 session row (session_key, circuit_key, year...)
    meeting_name: str    # e.g. "Italian Grand Prix"
    start: pd.Timestamp  # moment of lights-out (UTC)
    drivers: pd.DataFrame
    laps: pd.DataFrame
    results: pd.DataFrame    # final classification (position, number_of_laps, dnf...)
    winner: int          # driver number of the race winner
    race_laps: int       # official number of laps of the race
    positions: pd.DataFrame  # race order changes: t, driver_number, position
    intervals: pd.DataFrame  # gap samples: t, driver_number, interval, gap_to_leader
    stints: pd.DataFrame     # tyre stints: driver_number, stint_number, compound, tyre_age_at_start
    pits: pd.DataFrame       # pit stops: t, driver_number, lane_duration
    race_control: pd.DataFrame  # flags, safety car, messages: t, category, flag, scope, sector, message
    openf1_overtakes: pd.DataFrame  # OpenF1's own overtake list (only used as a cross-check)
    location: dict       # driver_number -> DataFrame with columns t, x, y
    car_data: dict       # driver_number -> DataFrame with columns t, speed, throttle, brake, n_gear, drs
    weather: pd.DataFrame    # one sample per minute: t, air_temperature, track_temperature, rainfall...
    team_radio: pd.DataFrame  # radio clips: t, driver_number, recording_url (may be empty)


def find_race_session(year, gp):
    """Return the OpenF1 'Race' session of a Grand Prix.

    `gp` is either a round number (1 = first race of the year) or a word that
    appears in the country / city / circuit name ("Monza", "Australia", "Spa").
    """
    sessions = openf1.get("sessions", cache=False, year=year, session_name="Race")
    sessions = [s for s in sessions if not s["is_cancelled"]]
    sessions.sort(key=lambda s: s["date_start"])

    if isinstance(gp, int):
        if not 1 <= gp <= len(sessions):
            raise ValueError(f"{year} has {len(sessions)} races, round {gp} does not exist")
        return sessions[gp - 1]

    def label(s):
        return f"{s['country_name']} / {s['location']} / {s['circuit_short_name']}"

    matches = [s for s in sessions if gp.lower() in label(s).lower()]
    if len(matches) != 1:
        options = "\n  ".join(f"{i + 1}: {label(s)}" for i, s in enumerate(sessions))
        raise ValueError(f"'{gp}' matches {len(matches)} races in {year}. Available:\n  {options}")
    return matches[0]


PIT_DUPLICATE_WINDOW = 60  # seconds: pit entries of one driver closer than this are the same stop


def clean_pits(pits):
    """Remove duplicated pit rows.

    Some sessions (e.g. Australia 2026) list the same stop twice a few seconds apart,
    the second copy with a wrong lap number. We keep the first row of each group.
    """
    keep = []
    last = {}   # driver_number -> time of the last kept stop
    for index, row in pits.sort_values("t").iterrows():
        d = row["driver_number"]
        if d not in last or row["t"] - last[d] > PIT_DUPLICATE_WINDOW:
            keep.append(index)
            last[d] = row["t"]
    return pits.loc[keep].reset_index(drop=True)


def to_seconds_column(df, start):
    """Add a column `t` = seconds since lights-out, computed from the ISO 'date' strings."""
    dates = pd.to_datetime(df["date"], utc=True, format="ISO8601")
    df["t"] = (dates - start).dt.total_seconds()
    return df


def load_race(year, gp, progress=lambda fraction, text: None):
    """`progress(fraction, text)` is called now and then so the caller can show how far we are."""
    progress(0.01, "Finding the race")
    session = find_race_session(year, gp)
    key = session["session_key"]
    print(f"Loading {year} {session['location']} (session {key}) from OpenF1...")

    progress(0.03, "Loading drivers and laps")
    meeting = openf1.get("meetings", meeting_key=session["meeting_key"])[0]
    drivers = pd.DataFrame(openf1.get("drivers", session_key=key))
    laps = pd.DataFrame(openf1.get("laps", session_key=key))
    result = pd.DataFrame(openf1.get("session_result", session_key=key))
    winner = int(result.loc[result["position"] == 1, "driver_number"].iloc[0])
    race_laps = int(result["number_of_laps"].max())

    # Lights-out = the moment lap 1 starts for the first car.
    laps["date_start"] = pd.to_datetime(laps["date_start"], utc=True, format="ISO8601")
    start = laps.loc[laps["lap_number"] == 1, "date_start"].min()
    laps["t_start"] = (laps["date_start"] - start).dt.total_seconds()

    # Big tables, one request per driver: X/Y positions and car telemetry (about 4 samples
    # per second per car).
    location = {}
    car_data = {}
    for i, number in enumerate(drivers["driver_number"]):
        number = int(number)
        print(f"  positions and telemetry of car {number}")
        progress(0.05 + 0.65 * i / len(drivers), f"Downloading positions and telemetry ({i + 1}/{len(drivers)} cars)")
        df = pd.DataFrame(openf1.get("location", session_key=key, driver_number=number))
        if not df.empty:
            df = to_seconds_column(df, start)
            # Before the cars send real data OpenF1 reports x=0, y=0, z=0. Those are not
            # real positions (the car would "teleport" from the map origin), so drop them.
            df = df[~((df["x"] == 0) & (df["y"] == 0))]
            location[number] = df.sort_values("t")[["t", "x", "y"]].reset_index(drop=True)

        df = pd.DataFrame(openf1.get("car_data", session_key=key, driver_number=number))
        if not df.empty:
            df = to_seconds_column(df, start)
            car_data[number] = df.sort_values("t")[
                ["t", "speed", "throttle", "brake", "n_gear", "drs"]].reset_index(drop=True)

    progress(0.72, "Downloading flags, pit stops and tyres")
    # Smaller tables: each is one request. All get a `t` column (seconds since lights-out).
    def table(endpoint):
        df = pd.DataFrame(openf1.get(endpoint, session_key=key))
        if df.empty:                       # e.g. no team radio for this session: keep the `t` column
            df["t"] = pd.Series(dtype=float)
            return df
        return to_seconds_column(df, start)

    positions = table("position")
    intervals = table("intervals")
    pits = clean_pits(table("pit"))
    race_control = table("race_control")
    openf1_overtakes = table("overtakes")
    weather = table("weather")
    team_radio = table("team_radio")
    stints = pd.DataFrame(openf1.get("stints", session_key=key))

    return Race(session, meeting["meeting_name"], start, drivers, laps, result, winner, race_laps,
                positions, intervals, stints, pits, race_control, openf1_overtakes,
                location, car_data, weather, team_radio)
