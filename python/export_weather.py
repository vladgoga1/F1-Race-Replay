"""Weather during the race, for the little indicator next to the lap counter (weather.json).

OpenF1 has one sample per minute. We store parallel lists (one value per sample), so the file stays
small, and the browser takes the last sample at or before the replay time.
  t        - seconds since lights-out (the first sample is moved to 0 if it is earlier)
  air      - air temperature, degrees C
  track    - track temperature, degrees C
  humidity - %
  wind     - wind speed, m/s
  windDir  - direction the wind comes FROM, degrees (0 = north)
  rain     - 1 while it rains, else 0
"""
import numpy as np
import pandas as pd

EXTRA_AFTER = 300   # seconds of samples kept after the end of the replay


def build_weather(race, duration):
    rows = race.weather.sort_values("t")
    rows = rows[rows["t"] <= duration + EXTRA_AFTER]
    if rows.empty:
        return None
    # Samples from before lights-out: keep only the last one, at t = 0 (the state at the start).
    before = rows[rows["t"] <= 0]
    rows = rows[rows["t"] > 0]
    if not before.empty:
        rows = pd.concat([before.iloc[[-1]].assign(t=0.0), rows])

    def column(name, digits):
        return [None if np.isnan(v) else round(float(v), digits) for v in rows[name]]

    return {
        "t": [round(float(v), 1) for v in rows["t"]],
        "air": column("air_temperature", 1),
        "track": column("track_temperature", 1),
        "humidity": column("humidity", 0),
        "wind": column("wind_speed", 1),
        "windDir": column("wind_direction", 0),
        "rain": [int(v) if not np.isnan(v) else 0 for v in rows["rainfall"]],
    }
