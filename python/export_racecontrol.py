"""Race control messages for the "Messages" tab: every message of the race director, with a
type (so the page can filter them) and the drivers named in the text.

Written to racecontrol.json as a list: {"t", "kind", "flag", "sector", "text", "drivers"}.
"""
import re

import numpy as np

# Messages shown after the end of the replay (penalties are often announced after the flag).
AFTER_RACE = 3600   # seconds

DRIVER_IN_TEXT = re.compile(r"\(([A-Z]{3})\)")   # "CAR 16 (LEC)" -> LEC


def classify(category, flag, message):
    """One word that says what a message is about (the page filters on it)."""
    if category == "SafetyCar":
        return "safety"
    if category == "Flag":
        return "flag"
    if category == "SessionStatus":
        return "session"
    if "TIME" in message and "DELETED" in message:
        return "limits"            # "CAR 16 (LEC) TIME 1:24.525 DELETED - TRACK LIMITS ..."
    if "PENALTY" in message or "REPRIMAND" in message or "DRIVE THROUGH" in message:
        return "penalty"
    if "NOTED" in message or "INVESTIGAT" in message or "REVIEWED" in message or "STEWARDS" in message:
        return "incident"
    if category == "Drs" or "DRS" in message or "OVERTAKE" in message:
        return "drs"
    return "info"


def build_racecontrol(race, duration):
    known = set(race.drivers["name_acronym"])
    messages = []
    for row in race.race_control.sort_values("t").itertuples():
        # Before lights-out there are only warm-up lap messages. -2 keeps "SESSION STARTED".
        if row.t < -2 or row.t > duration + AFTER_RACE:
            continue
        text = str(row.message).replace("�", "-")     # OpenF1 turns a dash into a broken character
        category = row.category if isinstance(row.category, str) else ""
        flag = row.flag if isinstance(row.flag, str) else ""
        messages.append({
            "t": round(max(float(row.t), 0.0), 1),
            "kind": classify(category, flag, text.upper()),
            "flag": flag,
            "sector": None if np.isnan(row.sector) else int(row.sector),
            "text": text,
            "drivers": [d for d in DRIVER_IN_TEXT.findall(text) if d in known],
        })
    return messages
