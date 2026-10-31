// Weather indicator under the lap counter: temperatures, humidity, wind and rain at the replay time.
// The data (weather.json) has one sample per minute; we show the last sample at or before "now".
import { countUpTo } from "./replay.js";
import { speedFromKmh, speedUnitLabel } from "./util.js";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export class WeatherBadge {
  constructor(el, data) {
    this.el = el;
    this.data = data;              // weather.json, or null when the race was exported without it
    this.key = null;               // what is written now (sample + unit): rewrite only when it changes
    el.hidden = !data;
  }

  update(time) {
    const d = this.data;
    if (!d) return;
    const i = Math.max(countUpTo(d.t, time) - 1, 0);
    const key = `${i}|${speedUnitLabel()}`;
    if (key === this.key) return;
    this.key = key;

    const show = (value, unit, digits = 0) => (value === null ? "-" : `${value.toFixed(digits)}${unit}`);
    // The wind direction is where the wind comes FROM; the arrow shows where it blows TO.
    const from = d.windDir[i];
    const wind = d.wind[i] === null ? "-" : `${Math.round(speedFromKmh(d.wind[i] * 3.6))} ${speedUnitLabel()}`;
    const arrow = from === null ? "" :
      ` <i class="windArrow" style="transform:rotate(${from + 180}deg)">&#8593;</i> ${COMPASS[Math.round(from / 45) % 8]}`;
    this.el.innerHTML = `
      <span title="Air temperature">AIR <b>${show(d.air[i], "°", 0)}</b></span>
      <span title="Track temperature">TRACK <b>${show(d.track[i], "°", 0)}</b></span><br>
      <span title="Humidity">HUM <b>${show(d.humidity[i], "%")}</b></span>
      <span title="Wind speed and the direction it blows to">WIND <b>${wind}</b>${arrow}</span>
      ${d.rain[i] ? '<div class="rainBadge">RAIN</div>' : ""}`;
  }
}
