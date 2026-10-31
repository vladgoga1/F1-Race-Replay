// Loads the JSON files produced by the Python scripts.

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}

// The page is at /web/, the data at /data/ (the server runs from the project root).
export async function loadRaceList() {
  return getJson("../data/races.json");
}

export async function loadRace(folder) {
  const base = `../data/${folder}`;
  // Races exported before a feature existed (mini-sectors, messages, race trace, sectors, weather, radio, battles) lack its file:
  // that feature is then off and says "export again".
  const optional = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  const [meta, track, positions, standings, strategy, eventData, minisectors, racecontrol, racetrace, sectors, weather, teamradio, battles] = await Promise.all([
    getJson(`${base}/meta.json`),
    getJson(`${base}/track.json`),
    getJson(`${base}/positions.json`),
    getJson(`${base}/standings.json`),
    getJson(`${base}/strategy.json`),
    getJson(`${base}/events.json`),
    optional(`${base}/minisectors.json`),
    optional(`${base}/racecontrol.json`),
    optional(`${base}/racetrace.json`),
    optional(`${base}/sectors.json`),
    optional(`${base}/weather.json`),
    optional(`${base}/teamradio.json`),
    optional(`${base}/battles.json`),
  ]);
  return { meta, track, positions, standings, strategy, events: eventData.events, minisectors, racecontrol, racetrace,
    sectors, weather, teamradio, battles };
}
