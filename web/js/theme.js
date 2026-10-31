// Colours for the canvas drawings (the map and the timeline).
// CSS rules can use var(--track), but code that draws on a canvas cannot, so we read the current
// value of the variables from the page and keep it here. refreshThemeColors() is called at start
// and every time the theme changes.
export const colors = {
  text: "#eeeeee",
  bg: "#15151e",
  track: "#3a3a4d",
  muted: "#8a8aa0",
  mapText: "#ffffff",
  lane: "#1d1d2a",
  playhead: "#ffffff",
};

export function refreshThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  colors.text = read("--text", colors.text);
  colors.bg = read("--bg", colors.bg);
  colors.track = read("--track", colors.track);
  colors.muted = read("--muted", colors.muted);
  colors.mapText = read("--map-text", colors.mapText);
  colors.lane = read("--lane", colors.lane);
  colors.playhead = read("--playhead", colors.playhead);
}
