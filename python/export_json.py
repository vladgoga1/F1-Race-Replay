"""Turns the OpenF1 data into JSON files for the web page.

Files written per race, in data/<year>_<slug>/:
  meta.json       - race info, drivers (abbreviation, team colour), lap start times
  track.json      - track outline + numbered corners
  positions.json  - X/Y of every driver on a regular time grid
  standings.json  - race order and gap to the car ahead, as "step" series (see export_leaderboard)
  strategy.json   - lap start times, tyre stints and pit stops per driver
  events.json     - timeline events (overtakes, pit stops, flags, safety car, retirements, fastest lap)
  racecontrol.json - race director messages (flags, investigations, penalties...), for the Messages tab
  racetrace.json  - end time of every lap of every driver, for the race trace chart
  minisectors.json - the lap in 25 pieces: track geometry of each piece + every driver's time in it
  sectors.json    - the three official sectors: track geometry + every driver's sector times
  weather.json    - air/track temperature, humidity, wind and rain during the race
  teamradio.json  - team radio clips (time, driver, link to the sound file)
  battles.json    - pairs of cars that ran less than a second apart for several laps
  telemetry/<ABBR>.json - speed, throttle, brake and gear of one driver (loaded only when needed)
"""
import json

import numpy as np

import config
import data_loader
import detect_events
import detect_battles
import detect_overtakes
import export_leaderboard
import export_minisectors
import export_racecontrol
import export_racetrace
import export_sectors
import export_teamradio
import export_telemetry
import export_weather
import lap_timing
from geometry import rotate


def race_folder(race):
    return config.DATA_DIR / f"{race.session['year']}_{config.slugify(race.meeting_name)}"


def write_json(path, obj):
    # separators without spaces -> smaller files
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))


def get_circuit_info(race):
    """Corner positions/numbers + map rotation. OpenF1 does not have them, so we ask
    MultiViewer through FastF1's helper. Returns (corners_table, rotation); if the
    circuit is not available we still draw the map, just without corner numbers."""
    try:
        import fastf1
        import fastf1.mvapi
        config.CACHE_DIR.mkdir(exist_ok=True)
        fastf1.Cache.configure(cache_dir=str(config.CACHE_DIR))
        info = fastf1.mvapi.get_circuit_info(year=race.session["year"],
                                             circuit_key=race.session["circuit_key"])
        if info is not None:
            return info.corners, float(info.rotation)
    except Exception as err:  # network error, circuit missing, FastF1 not installed...
        print(f"  Warning: no circuit info ({err}); map will have no corner numbers.")
    return None, 0.0


def driver_status(result_row):
    """'DNS' (did not start), 'DSQ' (disqualified), 'DNF' (retired) or None (finished)."""
    if result_row is None:
        return None
    for flag in ("dns", "dsq", "dnf"):
        if result_row[flag]:
            return flag.upper()
    return None


def build_meta(race, lap_starts):
    results = race.results.set_index("driver_number")
    drivers = []
    for _, row in race.drivers.iterrows():
        number = int(row["driver_number"])
        drivers.append({
            "number": number,
            "abbr": row["name_acronym"],
            "name": row["full_name"],
            "team": row["team_name"],
            "color": "#" + row["team_colour"] if row["team_colour"] else "#888888",
            "status": driver_status(results.loc[number] if number in results.index else None),
        })

    # The replay ends when the last car completes its final lap
    # (lap start + lap duration, ignoring laps without a recorded duration).
    done = race.laps.dropna(subset=["lap_duration", "t_start"])
    duration = float((done["t_start"] + done["lap_duration"]).max())

    winner_starts = lap_starts[race.winner]
    if len(winner_starts) != race.race_laps:
        print(f"  Warning: found {len(winner_starts)} laps for the winner in a {race.race_laps}-lap race.")

    return {
        "year": int(race.session["year"]),
        "eventName": race.meeting_name,
        "location": race.session["location"],
        "totalLaps": race.race_laps,
        "duration": round(duration, 1),
        "lapStarts": winner_starts,   # the lap selector follows the leader
        "drivers": drivers,
    }


def build_track(race, corners, rotation):
    """Outline = path of the car during the fastest lap of the race."""
    xy = rotate(lap_timing.fastest_lap_path(race), rotation)

    track = {
        "x": [int(v) for v in xy[:, 0]],
        "y": [int(v) for v in xy[:, 1]],
        "corners": [],
    }
    if corners is not None:
        cxy = rotate(corners[["X", "Y"]].to_numpy(dtype=float), rotation)
        for (_, c), p in zip(corners.iterrows(), cxy):
            track["corners"].append(
                {"n": int(c["Number"]), "letter": c["Letter"], "x": int(p[0]), "y": int(p[1])})
    return track


def build_positions(race, duration, rotation):
    """Resample every driver's X/Y onto the same time grid (0, 1, 2, ... seconds).

    OpenF1 position samples are irregular (about 4 per second and different for
    each car). A common grid means that in the browser "time t" is simply
    index t of every array, and we only interpolate between neighbours.
    """
    grid = np.arange(0, duration, config.POSITION_STEP)
    out = {"step": config.POSITION_STEP, "drivers": {}}

    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    for number, loc in race.location.items():
        # np.interp(grid, known_times, known_values) draws straight lines between the known
        # samples and reads the value at each grid time.
        xy = np.column_stack([
            np.interp(grid, loc["t"], loc["x"]),
            np.interp(grid, loc["t"], loc["y"]),
        ])
        xy = rotate(xy, rotation)
        out["drivers"][abbr_of[number]] = {
            "x": [int(v) for v in xy[:, 0]],
            "y": [int(v) for v in xy[:, 1]],
        }
    return out


def update_index():
    """Rebuild data/races.json by scanning the exported race folders (used by the race selector)."""
    races = []
    for meta_file in sorted(config.DATA_DIR.glob("*/meta.json")):
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        races.append({
            "folder": meta_file.parent.name,
            "year": meta["year"],
            "name": meta["eventName"],
        })
    write_json(config.DATA_DIR / "races.json", races)


def export_race(year, gp, progress=lambda fraction, text: None):
    """Exports one race. `progress(fraction, text)` reports how far we are (0 to 1)."""
    race = data_loader.load_race(year, gp, progress)
    progress(0.75, "Reading circuit info")
    corners, rotation = get_circuit_info(race)
    progress(0.80, "Detecting events and overtakes")
    timing = lap_timing.lap_timing_by_driver(race)
    lap_starts = {number: t["starts"] for number, t in timing.items()}
    meta = build_meta(race, lap_starts)

    other_events, retire_times = detect_events.detect_events(race, timing, meta["duration"])
    red_flags = [(e["t"], e["end"] if e["end"] is not None else meta["duration"])
                 for e in other_events if e["type"] == "red"]
    overtakes = detect_overtakes.detect_overtakes(
        race, timing, retire_times, red_flags, meta["duration"], corners, rotation)
    events = sorted(other_events + overtakes, key=lambda e: e["t"])

    progress(0.88, "Writing the files")
    folder = race_folder(race)
    folder.mkdir(parents=True, exist_ok=True)
    write_json(folder / "meta.json", meta)
    write_json(folder / "track.json", build_track(race, corners, rotation))
    write_json(folder / "positions.json", build_positions(race, meta["duration"], rotation))
    write_json(folder / "standings.json", export_leaderboard.build_standings(race))
    write_json(folder / "strategy.json", export_leaderboard.build_strategy(race, lap_starts))
    write_json(folder / "events.json", {"events": events,
                                        "crossCheck": detect_overtakes.cross_check(race, overtakes)})

    write_json(folder / "racecontrol.json", export_racecontrol.build_racecontrol(race, meta["duration"]))
    write_json(folder / "racetrace.json", export_racetrace.build_racetrace(race, timing))
    write_json(folder / "minisectors.json", export_minisectors.build_minisectors(race, timing, rotation))
    write_json(folder / "sectors.json", export_sectors.build_sectors(race, timing, rotation))
    write_json(folder / "weather.json", export_weather.build_weather(race, meta["duration"]))
    write_json(folder / "teamradio.json", export_teamradio.build_teamradio(race, meta["duration"]))
    standings = export_leaderboard.build_standings(race)
    write_json(folder / "battles.json", detect_battles.detect_battles(
        race, standings, timing, retire_times, events, meta["duration"]))

    (folder / "telemetry").mkdir(exist_ok=True)
    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    for i, number in enumerate(race.car_data):
        progress(0.92 + 0.07 * i / len(race.car_data), "Writing telemetry")
        write_json(folder / "telemetry" / f"{abbr_of[number]}.json",
                   export_telemetry.build_telemetry(race, number, meta["duration"]))

    update_index()
    progress(1.0, "Done")
    return folder
