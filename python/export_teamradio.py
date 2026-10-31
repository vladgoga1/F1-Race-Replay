"""Team radio clips for the "Radio" tab (teamradio.json): when, who, and the address of the sound file.

The sound files are NOT downloaded: OpenF1 only gives links to the Formula 1 servers
(livetiming.formula1.com). The page plays them from there, so listening needs an internet connection.
"""

AFTER_RACE = 600   # seconds: clips recorded after the end of the replay are kept for a while


def build_teamradio(race, duration):
    abbr_of = dict(zip(race.drivers["driver_number"], race.drivers["name_acronym"]))
    clips = []
    for row in race.team_radio.sort_values("t").itertuples():
        if row.driver_number not in abbr_of or row.t > duration + AFTER_RACE:
            continue
        # Clips from before the start (formation lap) are shown at 0.
        clips.append({"t": round(max(float(row.t), 0.0), 1), "driver": abbr_of[row.driver_number],
                      "url": row.recording_url})
    return clips
