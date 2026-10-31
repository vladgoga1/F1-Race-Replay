"""Shared paths and settings for the data scripts."""
import re
from pathlib import Path

# Project root = the folder that contains the "python" folder.
ROOT = Path(__file__).resolve().parent.parent

CACHE_DIR = ROOT / "cache"   # downloaded OpenF1 answers (huge speed-up on re-runs)
DATA_DIR = ROOT / "data"     # JSON output read by the web page

# Seconds between two exported position samples. The browser interpolates
# between samples, so 1 s is enough for smooth movement and keeps files small.
POSITION_STEP = 1.0

# Number of equal pieces the lap is cut into for the mini-sector view.
MINI_SECTORS = 25


def slugify(text):
    """'Italian Grand Prix' -> 'italian-grand-prix' (safe folder name)."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
