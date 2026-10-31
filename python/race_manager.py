"""Behind the "Races" panel of the page: what races exist, exporting them in the background,
and the download cache. Used by serve.py.

Only the standard library is used here on purpose: serve.py is started with plain `py`, which
may not have pandas / requests. The real work (downloading and exporting) is done by
python/export_race.py in a separate process, started with the project's virtual environment.
"""
import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

import config

OPENF1 = "https://api.openf1.org/v1"
FIRST_YEAR = 2023            # OpenF1 has nothing before this
MANIFESTS = config.CACHE_DIR / "manifests"      # cache/manifests/<race folder>.json = list of cache files


def python_for_export():
    """The interpreter that has pandas & co: the .venv of the project if there is one."""
    for candidate in (config.ROOT / ".venv" / "Scripts" / "python.exe",     # Windows
                      config.ROOT / ".venv" / "bin" / "python"):            # macOS / Linux
        if candidate.exists():
            return str(candidate)
    return sys.executable


# ---------- the calendar of a season (from OpenF1, a small request) ----------

_calendar_cache = {}   # year -> (time of the request, list)


def _openf1_get(endpoint, **params):
    url = f"{OPENF1}/{endpoint}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"User-Agent": "f1-replay-dashboard"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        if err.code == 404:          # OpenF1 says 404 for "no rows"
            return []
        raise


def calendar(year):
    """The races of one season: round number, name, date, and whether they are already exported.
    Same numbering as export_race.py (round 1 = the first race that was not cancelled)."""
    if not FIRST_YEAR <= year <= date.today().year:
        raise ValueError(f"OpenF1 has data for {FIRST_YEAR} to {date.today().year}")

    cached = _calendar_cache.get(year)
    if cached is None or time.time() - cached[0] > 600:       # ask OpenF1 at most every 10 minutes
        sessions = _openf1_get("sessions", year=year, session_name="Race")
        meetings = {m["meeting_key"]: m for m in _openf1_get("meetings", year=year)}
        sessions = sorted((s for s in sessions if not s["is_cancelled"]), key=lambda s: s["date_start"])
        races = []
        for number, s in enumerate(sessions, start=1):
            meeting = meetings.get(s["meeting_key"], {})
            races.append({
                "round": number,
                "name": meeting.get("meeting_name", s["location"]),
                "country": s["country_name"],
                "date": s["date_start"][:10],
                # Data only exists once the race is over.
                "finished": datetime.fromisoformat(s["date_end"]) < datetime.now(timezone.utc),
            })
        _calendar_cache[year] = cached = (time.time(), races)

    exported = {r["folder"] for r in exported_races()}
    result = []
    for race in cached[1]:
        folder = f"{year}_{config.slugify(race['name'])}"
        result.append({**race, "folder": folder, "exported": folder in exported})
    return result


# ---------- exported races and the cache ----------

def folder_size(path):
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def manifest_files(folder):
    """Cache files of a race (list of paths relative to cache/), or None if we do not know them."""
    try:
        return json.loads((MANIFESTS / f"{folder}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def exported_races():
    races = []
    for meta_file in sorted(config.DATA_DIR.glob("*/meta.json")):
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        folder = meta_file.parent.name
        files = manifest_files(folder)
        cache_bytes = None if files is None else sum(
            (config.CACHE_DIR / f).stat().st_size for f in files if (config.CACHE_DIR / f).is_file())
        races.append({"folder": folder, "year": meta["year"], "name": meta["eventName"],
                      "dataBytes": folder_size(meta_file.parent), "cacheBytes": cache_bytes})
    return races


def cache_total():
    cache = config.CACHE_DIR / "openf1"
    return folder_size(cache) if cache.exists() else 0


def delete_cache(folder):
    """Deletes the downloaded data of one race. Returns the bytes freed."""
    files = manifest_files(folder)
    if files is None:
        raise ValueError("We do not know which cache files belong to this race")
    freed = 0
    for name in files:
        path = config.CACHE_DIR / name
        if path.is_file():
            freed += path.stat().st_size
            path.unlink()
    (MANIFESTS / f"{folder}.json").unlink(missing_ok=True)
    return freed


def delete_all_cache():
    freed = cache_total()
    shutil.rmtree(config.CACHE_DIR / "openf1", ignore_errors=True)
    shutil.rmtree(MANIFESTS, ignore_errors=True)
    return freed


# ---------- background export jobs ----------

class Jobs:
    """A queue of exports, run one at a time by a worker thread.

    A thread is a second "line of execution" inside the same program: the web server keeps
    answering the page while the worker waits for the export. Both use the lock when they touch
    the list of jobs, so they never change it at the same moment.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = []                    # newest last; each job is a dict (see add)
        self.next_id = 1
        self.process = None               # the running export_race.py, so it can be cancelled
        threading.Thread(target=self.worker, daemon=True).start()

    def add(self, year, round_number, name, folder, keep_cache):
        with self.lock:
            for job in self.jobs:
                if job["folder"] == folder and job["state"] in ("queued", "running"):
                    return job            # already waiting: do not export it twice
            job = {"id": self.next_id, "year": year, "round": round_number, "name": name,
                   "folder": folder, "keepCache": keep_cache, "state": "queued", "fraction": 0.0,
                   "message": "Waiting", "error": None, "started": None, "finished": None}
            self.next_id += 1
            self.jobs.append(job)
            return job

    def snapshot(self):
        with self.lock:
            return [dict(j) for j in self.jobs]

    def busy(self):
        with self.lock:
            return any(j["state"] in ("queued", "running") for j in self.jobs)

    def is_busy_with(self, folder):
        with self.lock:
            return any(j["folder"] == folder and j["state"] in ("queued", "running") for j in self.jobs)

    def cancel(self, job_id):
        with self.lock:
            for job in self.jobs:
                if job["id"] != job_id:
                    continue
                if job["state"] == "queued":
                    job["state"], job["message"] = "cancelled", "Cancelled"
                elif job["state"] == "running" and self.process is not None:
                    job["state"] = "cancelled"          # the worker sees this when the process ends
                    self.process.kill()

    def clear_finished(self):
        with self.lock:
            self.jobs = [j for j in self.jobs if j["state"] in ("queued", "running")]

    def worker(self):
        while True:
            job = None
            with self.lock:
                for j in self.jobs:
                    if j["state"] == "queued":
                        job = j
                        job["state"], job["started"] = "running", time.time()
                        break
            if job is None:
                time.sleep(0.5)
                continue
            try:
                self.run(job)
            except Exception as err:          # never let the worker thread die
                with self.lock:
                    job["state"], job["error"] = "error", str(err)
            job["finished"] = time.time()

    def run(self, job):
        command = [python_for_export(), "-u", str(config.ROOT / "python" / "export_race.py"),
                   str(job["year"]), str(job["round"])]
        if not job["keepCache"]:
            command.append("--delete-cache")
        process = subprocess.Popen(command, cwd=config.ROOT, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
        with self.lock:
            self.process = process
        tail = []                              # the last lines, shown if something goes wrong
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            tail = (tail + [line])[-8:]
            if line.startswith("PROGRESS "):
                _, fraction, text = (line.split(" ", 2) + [""])[:3]
                with self.lock:
                    job["fraction"], job["message"] = float(fraction), text
        process.wait()
        with self.lock:
            self.process = None
            if job["state"] == "cancelled":
                job["message"] = "Cancelled"
            elif process.returncode == 0:
                job["state"], job["fraction"], job["message"] = "done", 1.0, "Done"
            else:
                job["state"], job["error"] = "error", "\n".join(tail)
