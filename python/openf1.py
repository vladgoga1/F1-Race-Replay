"""Tiny client for the OpenF1 REST API (https://openf1.org).

OpenF1 returns plain JSON from simple URLs, e.g.
    https://api.openf1.org/v1/laps?session_key=9912&driver_number=1
so we only need the `requests` library. No account is needed for historical data.
"""
import hashlib
import json
import time

import requests

import config

BASE_URL = "https://api.openf1.org/v1"

# The free tier allows a few requests per second (and a limited number per minute).
# We wait a little between calls and retry politely when the server says "slow down" (HTTP 429).
MIN_SECONDS_BETWEEN_CALLS = 0.4
_last_call = 0.0

# While recording, every cache file that get() reads or writes is remembered. The exporter uses
# this to know which files in cache/ belong to ONE race, so they can be deleted later without
# touching the other races (the file names are hashes, so the name alone says nothing).
_recorded = None


def start_recording():
    global _recorded
    _recorded = set()


def stop_recording():
    """Stops recording and returns the cache files used, as paths relative to the cache folder."""
    global _recorded
    files = sorted(_recorded or [])
    _recorded = None
    return files


def get(endpoint, cache=True, **params):
    """Call one OpenF1 endpoint and return the parsed JSON (a list of dicts).

    Results of finished races never change, so by default they are saved in
    cache/openf1/ and the next run does not touch the network.
    Pass cache=False for data that can change (e.g. the list of sessions of the current year).
    """
    global _last_call

    cache_file = None
    if cache:
        # One file per distinct request: the name is a hash of the endpoint + parameters.
        key = endpoint + json.dumps(params, sort_keys=True)
        name = hashlib.md5(key.encode()).hexdigest()
        cache_file = config.CACHE_DIR / "openf1" / f"{endpoint}_{name}.json"
        if _recorded is not None:
            _recorded.add(cache_file.relative_to(config.CACHE_DIR).as_posix())
        if cache_file.exists():
            return json.loads(cache_file.read_text(encoding="utf-8"))

    for attempt in range(8):
        wait = MIN_SECONDS_BETWEEN_CALLS - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()

        response = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=120)

        if response.status_code == 429 or response.status_code >= 500:
            delay = 2 * (attempt + 1)  # wait longer after every failed attempt
            print(f"  OpenF1 answered {response.status_code}, retrying in {delay}s...")
            time.sleep(delay)
            continue
        if response.status_code == 404:
            data = []  # OpenF1 uses 404 for "no rows match" (e.g. no data for that session)
            break
        response.raise_for_status()
        data = response.json()
        break
    else:
        raise RuntimeError(f"OpenF1 request failed repeatedly: {endpoint} {params}")

    if cache_file is not None:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(data), encoding="utf-8")
    return data
