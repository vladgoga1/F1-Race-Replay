"""Local web server for the dashboard: `python -m http.server` plus two extras.

1. It adds `Cache-Control: no-cache`. Plain `http.server` sends no cache headers, so a browser
   may keep using an OLD copy of a JavaScript file after we change it, and the page then behaves
   strangely (menus that do nothing). `no-cache` means "ask the server every time whether the
   file changed" (an unchanged file is still answered with a tiny "304 Not Modified").
2. A small API under /api/ that the "Races" panel of the page uses to pick races, export them in
   the background and manage the download cache (see python/race_manager.py).

Usage, from the project root:
    py serve.py            (Windows)
    python3 serve.py       (macOS / Linux)
    py serve.py 8001       (another port)
Then open http://localhost:8000/web/
"""
import http.server
import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "python"))
import race_manager  # noqa: E402  (standard library only, so plain `py` is enough)

jobs = race_manager.Jobs()
PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Only pages opened from this very computer may use the API. The Host check stops a web page
    # on another site from reaching us through a trick called DNS rebinding; the custom header on
    # POST requests stops other sites from sending them at all (browsers forbid it for them).
    def api_allowed(self, post):
        host = self.headers.get("Host", "")
        if host not in (f"localhost:{PORT}", f"127.0.0.1:{PORT}"):
            return False
        return not post or self.headers.get("X-Pitwall") == "1"

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        if not self.api_allowed(post=False):
            return self.send_json({"error": "Not allowed"}, 403)
        query = urllib.parse.parse_qs(url.query)
        try:
            if url.path == "/api/calendar":
                self.send_json(race_manager.calendar(int(query["year"][0])))
            elif url.path == "/api/state":
                self.send_json({"jobs": jobs.snapshot(), "races": race_manager.exported_races(),
                                "cacheTotal": race_manager.cache_total()})
            else:
                self.send_json({"error": "Unknown request"}, 404)
        except ValueError as err:
            self.send_json({"error": str(err)}, 400)
        except Exception as err:      # e.g. no internet when asking OpenF1 for the calendar
            self.send_json({"error": f"{type(err).__name__}: {err}"}, 502)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/") or not self.api_allowed(post=True):
            return self.send_json({"error": "Not allowed"}, 403)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")

            if url.path == "/api/export":
                # The page sends only the year and the round; the name comes from the calendar.
                year, number = int(body["year"]), int(body["round"])
                race = next(r for r in race_manager.calendar(year) if r["round"] == number)
                if not race["finished"]:
                    raise ValueError("This race has not been run yet")
                job = jobs.add(year, number, race["name"], race["folder"], bool(body.get("keepCache", True)))
                self.send_json(job)
            elif url.path == "/api/cancel":
                jobs.cancel(int(body["id"]))
                self.send_json({})
            elif url.path == "/api/clear-finished":
                jobs.clear_finished()
                self.send_json({})
            elif url.path == "/api/delete-cache":
                # While an export runs it is using the cache: deleting under its feet would break it.
                if body.get("all"):
                    if jobs.busy():
                        raise ValueError("Wait for the exports to finish first")
                    freed = race_manager.delete_all_cache()
                else:
                    folder = str(body["folder"])
                    if "/" in folder or "\\" in folder or ".." in folder:
                        raise ValueError("Bad folder name")
                    if jobs.is_busy_with(folder):
                        raise ValueError("This race is being exported right now")
                    freed = race_manager.delete_cache(folder)
                self.send_json({"freed": freed})
            else:
                self.send_json({"error": "Unknown request"}, 404)
        except (ValueError, KeyError, StopIteration) as err:
            self.send_json({"error": str(err) or "Bad request"}, 400)
        except Exception as err:
            self.send_json({"error": f"{type(err).__name__}: {err}"}, 502)


if __name__ == "__main__":
    PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving on http://localhost:{PORT}/web/  (Ctrl+C to stop)")
    # bind to 127.0.0.1: reachable only from this computer
    http.server.test(HandlerClass=Handler, port=PORT, bind="127.0.0.1")
