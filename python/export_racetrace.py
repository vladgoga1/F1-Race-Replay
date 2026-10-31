"""Data for the race trace chart: when every driver completed every lap.

racetrace.json = {"drivers": {"VER": [end of lap 1, end of lap 2, ...], ...}}  (seconds since
lights-out). The page turns this into "gap to the leader after each lap" (or to any driver).
The times come from lap_timing, the same line crossings as everything else.
"""


def build_racetrace(race, timing):
    abbr = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    drivers = {}
    for number, t in timing.items():
        # starts = [0, start of lap 2, ...]: the start of lap n+1 is the end of lap n.
        # A finisher's last lap ends at his finish time, which is not a "start".
        ends = t["starts"][1:] + ([t["finish"]] if t["finish"] is not None else [])
        drivers[abbr[number]] = ends
    return {"drivers": drivers}
