// Small helpers used by several files.

// 4000 seconds -> "1:06:40"
export function formatTime(seconds) {
  const s = Math.floor(seconds);
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// Speed unit chosen in the settings: telemetry is stored in km/h and converted for display.
let speedUnit = "kmh";
export function setSpeedUnit(unit) {
  speedUnit = unit === "mph" ? "mph" : "kmh";
}
export function speedFromKmh(kmh) {
  return speedUnit === "mph" ? kmh * 0.621371 : kmh;
}
export function speedUnitLabel() {
  return speedUnit === "mph" ? "mph" : "km/h";
}

// { abbreviation: time the driver retired } from the timeline events.
export function retirementTimes(events) {
  const times = {};
  for (const e of events) {
    if (e.type === "dnf") times[e.driver] = e.t;
  }
  return times;
}

// Escape text before putting it in HTML (the data comes from an API, so do not trust it blindly).
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
