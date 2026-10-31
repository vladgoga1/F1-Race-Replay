"""Command line entry point.

Usage (from the project root, with the venv active):
    python python/export_race.py 2025 Monza
    python python/export_race.py 2026 1                  # round number also works
    python python/export_race.py 2025 Monza --delete-cache   # free the disk space afterwards

The page's "Races" panel starts this same script (through serve.py), reading the lines that
start with PROGRESS to show a progress bar.
"""
import argparse
import json
import sys
from pathlib import Path

# Make "import config" work no matter where the script is launched from.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
import export_json  # noqa: E402
import openf1  # noqa: E402


def progress(fraction, text):
    # flush=True: without it the text waits in a buffer and the page would see it too late
    print(f"PROGRESS {fraction:.3f} {text}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Export one F1 race to JSON files.")
    parser.add_argument("year", type=int)
    parser.add_argument("gp", help="round number (e.g. 16) or country/city (e.g. Monza)")
    parser.add_argument("--delete-cache", action="store_true",
                        help="delete the downloaded OpenF1 data of this race when the export is done")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")  # city names like "Montréal" break the Windows console otherwise

    gp = int(args.gp) if args.gp.isdigit() else args.gp
    openf1.start_recording()
    folder = export_json.export_race(args.year, gp, progress)
    files = openf1.stop_recording()

    if args.delete_cache:
        freed = 0
        for name in files:
            path = config.CACHE_DIR / name
            if path.is_file():
                freed += path.stat().st_size
                path.unlink()
        (config.CACHE_DIR / "manifests" / f"{folder.name}.json").unlink(missing_ok=True)
        print(f"Deleted the download cache of this race ({freed / 1e6:.0f} MB freed).")
    else:
        # Remember which cache files belong to this race, so they can be deleted later.
        manifest = config.CACHE_DIR / "manifests" / f"{folder.name}.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(files), encoding="utf-8")
    print(f"Done: {folder}")


if __name__ == "__main__":
    main()
