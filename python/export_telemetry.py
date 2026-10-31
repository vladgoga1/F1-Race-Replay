"""Car telemetry (speed, throttle, brake, gear) of one driver on a regular time grid.

One small file per driver (data/<race>/telemetry/<ABBR>.json), so the browser only downloads
the drivers the user highlights.
"""
import numpy as np

TELEMETRY_STEP = 0.25   # seconds between samples (the car sends about 4 samples per second)


def build_telemetry(race, number, duration):
    """{"step": s, "speed": [...], "throttle": [...], "brake": [...], "gear": [...]}; the
    value at index i belongs to time i * step (seconds since lights-out)."""
    car = race.car_data[number]
    grid = np.arange(0, duration, TELEMETRY_STEP)
    t = car["t"].to_numpy()

    # Speed and throttle change smoothly, so we draw straight lines between the samples
    # (np.interp). Gear and brake are on/off style values: interpolating "gear 3" and
    # "gear 4" would give 3.5, so for them we keep the last known value ("step hold").
    last = np.maximum(np.searchsorted(t, grid, side="right") - 1, 0)

    def hold(column):
        return car[column].to_numpy()[last]

    throttle = np.clip(np.interp(grid, t, car["throttle"]), 0, 100)   # the raw data goes up to 104
    return {
        "step": TELEMETRY_STEP,
        "speed": [int(round(v)) for v in np.interp(grid, t, car["speed"])],
        "throttle": [int(round(v)) for v in throttle],
        "brake": [1 if v > 0 else 0 for v in hold("brake")],     # the raw value is 0 or 100
        "gear": [int(v) for v in hold("n_gear")],
    }
