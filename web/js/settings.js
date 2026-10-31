// User settings ("personalize your pitwall"): stored in the browser, applied to the page.
//
// The settings live in localStorage, a small key-value store that every browser keeps per site.
// Nothing leaves your computer. Reading and writing is wrapped in try/catch because
// localStorage can be blocked (private windows, strict privacy settings); the page then simply
// works with the defaults and forgets your choices when it is closed.
import { setSpeedUnit } from "./util.js";

const STORAGE_KEY = "pitwall.settings.v1";

export const DEFAULTS = {
  // Appearance
  theme: "dark",              // dark | light | midnight
  accent: "#e10600",          // colour of the active tab / button / scrubber
  sidebarSide: "right",       // right | left
  sidebarWidth: 360,          // pixels
  // Panels
  showLapCounter: true,
  showWeather: true,
  showTimeline: true,
  showFocusPanel: true,
  showTrailLegend: true,
  showTyreColumn: true,
  showPitsColumn: true,
  // Map
  showCorners: true,
  showLabels: true,           // driver abbreviations next to the dots
  carStyle: "pixel",          // pixel | dot
  dotSize: 6,                 // size of a car: radius of the dot, or 1/5 of the length of the pixel car
  showMiniLabels: true,       // driver abbreviations on the mini-sectors
  // Telemetry
  units: "kmh",               // kmh | mph
  // Start-up
  defaultTab: "leaderboard",  // leaderboard | overtakes | battles | telemetry | messages | radio
  defaultSpeed: 1,            // 1 | 2 | 5 | 10
  defaultZoom: 500,           // metres, for focus mode
  tabOrder: [],               // order of the side tabs after dragging them (empty = the default order)
  floating: {},               // side tabs dragged onto the map: { radio: {x, y, w, h, z, o} } (see floating.js)
  favorites: [],              // abbreviations that are highlighted automatically ("VER", "NOR"...)
};

// What the settings panel shows. `type` decides the kind of input.
export const FIELDS = [
  { section: "Appearance" },
  { key: "theme", label: "Theme", type: "select", options: [["dark", "Dark"], ["midnight", "Midnight blue"], ["light", "Light"]] },
  { key: "accent", label: "Accent colour", type: "color" },
  { key: "sidebarSide", label: "Side panel", type: "select", options: [["right", "Right"], ["left", "Left"]] },
  { key: "sidebarWidth", label: "Side panel width", type: "select", options: [[300, "Narrow"], [360, "Normal"], [440, "Wide"]] },

  { section: "Panels" },
  { key: "showLapCounter", label: "Lap counter", type: "checkbox" },
  { key: "showWeather", label: "Weather under the lap counter", type: "checkbox" },
  { key: "showTimeline", label: "Event timeline", type: "checkbox" },
  { key: "showFocusPanel", label: "Focus panel (gaps + telemetry)", type: "checkbox" },
  { key: "showTrailLegend", label: "Legend of the coloured trace", type: "checkbox" },
  { key: "showTyreColumn", label: "Leaderboard: tyre column", type: "checkbox" },
  { key: "showPitsColumn", label: "Leaderboard: pit stops column", type: "checkbox" },

  { section: "Map" },
  { key: "showCorners", label: "Corner numbers", type: "checkbox" },
  { key: "carStyle", label: "Cars", type: "select", options: [["pixel", "Pixel-art cars"], ["dot", "Dots"]] },
  { key: "showLabels", label: "Driver names next to the cars", type: "checkbox" },
  { key: "dotSize", label: "Car size", type: "range", min: 4, max: 9 },
  { key: "showMiniLabels", label: "Names on the mini-sectors", type: "checkbox" },

  { section: "Telemetry" },
  { key: "units", label: "Speed unit", type: "select", options: [["kmh", "km/h"], ["mph", "mph"]] },

  { section: "When the page opens" },
  { key: "defaultTab", label: "Side panel tab", type: "select", options: [["leaderboard", "Leaderboard"], ["overtakes", "Overtakes"], ["battles", "Battles"], ["telemetry", "Telemetry"], ["messages", "Messages"], ["radio", "Radio"]] },
  { key: "defaultSpeed", label: "Replay speed", type: "select", options: [[1, "1x"], [2, "2x"], [5, "5x"], [10, "10x"]] },
  { key: "defaultZoom", label: "Focus zoom", type: "select", options: [[250, "Close"], [500, "Medium"], [900, "Wide"]] },
  { key: "favorites", label: "Favourite drivers", type: "list",
    hint: "Abbreviations separated by commas, for example VER, NOR. They are highlighted automatically in every race they take part in." },
];

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...this.load() };
    this.listeners = [];
  }

  // Only keeps stored values that have the same kind as the default (an old or hand-edited
  // value of the wrong type is ignored instead of breaking the page).
  load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      const clean = {};
      for (const key of Object.keys(DEFAULTS)) {
        const fine = key in stored && typeof stored[key] === typeof DEFAULTS[key] &&
          Array.isArray(stored[key]) === Array.isArray(DEFAULTS[key]);
        if (fine) clean[key] = stored[key];
      }
      return clean;
    } catch (err) {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch (err) {
      // storage blocked: keep working with the values in memory
    }
  }

  set(key, value) {
    this.values[key] = value;
    this.save();
    this.listeners.forEach((fn) => fn(key));
  }

  reset() {
    this.values = { ...DEFAULTS };
    this.save();
    this.listeners.forEach((fn) => fn(null));
  }

  onChange(fn) {
    this.listeners.push(fn);
  }
}

// Puts the settings on the page: theme, colours, which panels are visible.
export function applyToPage(values) {
  const root = document.documentElement;
  root.dataset.theme = values.theme;
  root.style.setProperty("--accent", values.accent);
  root.style.setProperty("--sidebar-w", `${values.sidebarWidth}px`);
  setSpeedUnit(values.units);

  const flags = {
    "hide-lapcounter": !values.showLapCounter,
    "hide-weather": !values.showWeather,
    "hide-timeline": !values.showTimeline,
    "hide-focuspanel": !values.showFocusPanel,
    "hide-legend": !values.showTrailLegend,
    "hide-col-tyre": !values.showTyreColumn,
    "hide-col-pits": !values.showPitsColumn,
    "sidebar-left": values.sidebarSide === "left",
  };
  for (const [name, on] of Object.entries(flags)) document.body.classList.toggle(name, on);
}

// Builds the form of the settings panel inside `container`.
export function buildSettingsForm(container, settings) {
  container.innerHTML = "";
  for (const field of FIELDS) {
    if (field.section) {
      const heading = document.createElement("h3");
      heading.textContent = field.section;
      container.appendChild(heading);
      continue;
    }

    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.textContent = field.label;
    row.appendChild(label);

    const value = settings.values[field.key];
    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const [optionValue, text] of field.options) input.add(new Option(text, optionValue));
      input.value = String(value);
      // The select gives text back; convert it to the kind of the default (number or string).
      input.onchange = () => settings.set(field.key, typeof DEFAULTS[field.key] === "number" ? Number(input.value) : input.value);
    } else if (field.type === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = value;
      input.onchange = () => settings.set(field.key, input.checked);
    } else if (field.type === "range") {
      input = document.createElement("input");
      input.type = "range";
      input.min = field.min;
      input.max = field.max;
      input.value = value;
      input.oninput = () => settings.set(field.key, Number(input.value));
    } else if (field.type === "color") {
      input = document.createElement("input");
      input.type = "color";
      input.value = value;
      input.oninput = () => settings.set(field.key, input.value);
    } else {                                    // "list": comma separated abbreviations
      input = document.createElement("input");
      input.type = "text";
      input.value = value.join(", ");
      input.placeholder = "VER, NOR";
      input.onchange = () => {
        const abbreviations = input.value.split(/[ ,;]+/).map((a) => a.trim().toUpperCase()).filter(Boolean);
        settings.set(field.key, [...new Set(abbreviations)]);
      };
    }
    label.htmlFor = input.id = `set-${field.key}`;
    row.appendChild(input);
    container.appendChild(row);

    if (field.hint) {
      const hint = document.createElement("p");
      hint.className = "hintText";
      hint.textContent = field.hint;
      container.appendChild(hint);
    }
  }
}
