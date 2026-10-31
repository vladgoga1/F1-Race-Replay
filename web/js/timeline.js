// Event timeline: a strip under the map with one coloured marker per event, in lanes by type.
// Click a marker to jump to that moment, hover to read it, use the chips to filter by type.
import { formatTime, esc } from "./util.js";
import { colors } from "./theme.js";

// One entry per event type. `lane` is the row of the strip, `shape` how it is drawn.
export const TYPES = [
  { id: "overtake", label: "Overtakes", color: "#3aa0ff", lane: 0, shape: "dot" },
  { id: "pit", label: "Pit stops", color: "#2dd4bf", lane: 1, shape: "square" },
  { id: "sc", label: "Safety car", color: "#ff8c1a", lane: 2, shape: "band" },
  { id: "vsc", label: "Virtual SC", color: "#ffc34d", lane: 2, shape: "band" },
  { id: "yellow", label: "Yellow flags", color: "#f5e642", lane: 3, shape: "band" },
  { id: "red", label: "Red flags", color: "#ff3b3b", lane: 3, shape: "band" },
  { id: "dnf", label: "Retirements", color: "#ff6fb0", lane: 4, shape: "diamond" },
  { id: "fastest", label: "Fastest lap", color: "#b266ff", lane: 4, shape: "diamond" },
];
const TYPE_BY_ID = Object.fromEntries(TYPES.map((t) => [t.id, t]));
const LANE_NAMES = ["Overtakes", "Pit stops", "SC / VSC", "Flags", "Retire / FL"];

const LEFT = 84;       // space for the lane names
const RIGHT = 12;
const TOP = 4;
const LANE_H = 12;
const LANE_GAP = 3;
const HIT_RADIUS = 5;  // pixels around a marker that count as a click on it

export const TIMELINE_HEIGHT = TOP * 2 + LANE_NAMES.length * (LANE_H + LANE_GAP);

// Which kind of track status is active at `time`: "red", "sc", "vsc", "yellow" or null.
export function trackStatus(events, time) {
  let found = null;
  const rank = { yellow: 1, vsc: 2, sc: 3, red: 4 };
  for (const e of events) {
    if (!(e.type in rank) || e.t > time) continue;
    if (e.end !== null && e.end < time) continue;
    if (found === null || rank[e.type] > rank[found]) found = e.type;
  }
  return found;
}

export class Timeline {
  constructor(canvas, filtersBox, tooltip, race, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.tooltip = tooltip;
    this.race = race;
    this.events = race.events;
    this.onSelect = onSelect;          // called with the event, or with {t} for a click on empty space
    this.hidden = new Set();           // event types switched off by the filters
    this.buildFilters(filtersBox);

    canvas.onclick = (e) => this.handleClick(e);
    canvas.onmousemove = (e) => this.handleHover(e);
    canvas.onmouseleave = () => { this.tooltip.hidden = true; };
  }

  buildFilters(box) {
    box.innerHTML = "";
    const counts = {};
    for (const e of this.events) counts[e.type] = (counts[e.type] || 0) + 1;
    for (const type of TYPES) {
      if (!counts[type.id]) continue;          // nothing of this type in this race
      const label = document.createElement("label");
      label.className = "chip";
      label.innerHTML =
        `<input type="checkbox" checked><span class="dot" style="background:${type.color}"></span>` +
        `${esc(type.label)} <small>${counts[type.id]}</small>`;
      label.querySelector("input").onchange = (e) => {
        if (e.target.checked) this.hidden.delete(type.id); else this.hidden.add(type.id);
      };
      box.appendChild(label);
    }
  }

  // Keep the pixel size of the canvas equal to its CSS size (sharp lines on high-DPI screens).
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.height = `${TIMELINE_HEIGHT}px`;
    this.width = this.canvas.clientWidth;
    this.canvas.width = this.width * dpr;
    this.canvas.height = TIMELINE_HEIGHT * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Race time (seconds) <-> horizontal pixel.
  x(time) {
    return LEFT + (time / this.race.meta.duration) * (this.width - LEFT - RIGHT);
  }
  timeAt(px) {
    return ((px - LEFT) / (this.width - LEFT - RIGHT)) * this.race.meta.duration;
  }
  laneY(lane) {
    return TOP + lane * (LANE_H + LANE_GAP);
  }

  draw(time, selected) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, TIMELINE_HEIGHT);

    ctx.font = "10px system-ui";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    LANE_NAMES.forEach((name, lane) => {
      const y = this.laneY(lane);
      ctx.fillStyle = colors.lane;
      ctx.fillRect(LEFT, y, this.width - LEFT - RIGHT, LANE_H);
      ctx.fillStyle = colors.muted;
      ctx.fillText(name, 6, y + LANE_H / 2);
    });

    for (const e of this.events) {
      const type = TYPE_BY_ID[e.type];
      if (!type || this.hidden.has(e.type)) continue;
      this.drawMarker(e, type, e === selected);
    }

    // Playhead: where the replay is now.
    const px = this.x(time);
    ctx.fillStyle = colors.playhead;
    ctx.fillRect(px - 0.5, 0, 1.5, TIMELINE_HEIGHT);
  }

  drawMarker(e, type, isSelected) {
    const ctx = this.ctx;
    const x = this.x(e.t);
    const y = this.laneY(type.lane);
    const cy = y + LANE_H / 2;
    ctx.fillStyle = type.color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;

    if (type.shape === "band") {
      // A span (safety car, flag): a coloured bar from start to end, brighter at the start.
      const end = e.end !== null ? this.x(e.end) : x;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x, y, Math.max(end - x, 2), LANE_H);
      ctx.globalAlpha = 1;
      ctx.fillRect(x, y, 2, LANE_H);
      if (isSelected) ctx.strokeRect(x, y, Math.max(end - x, 2), LANE_H);
    } else if (type.shape === "dot") {
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(x, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (isSelected) { ctx.beginPath(); ctx.arc(x, cy, 5, 0, Math.PI * 2); ctx.stroke(); }
    } else if (type.shape === "square") {
      ctx.fillRect(x - 2.5, cy - 2.5, 5, 5);
      if (isSelected) ctx.strokeRect(x - 4, cy - 4, 8, 8);
    } else {                                   // diamond
      ctx.beginPath();
      ctx.moveTo(x, cy - 5); ctx.lineTo(x + 5, cy); ctx.lineTo(x, cy + 5); ctx.lineTo(x - 5, cy);
      ctx.closePath();
      ctx.fill();
      if (isSelected) ctx.stroke();
    }
  }

  // The event under the mouse (or null). Only events in the lane being pointed at count.
  hitTest(px, py) {
    const lane = Math.floor((py - TOP) / (LANE_H + LANE_GAP));
    if (lane < 0 || lane >= LANE_NAMES.length) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const e of this.events) {
      const type = TYPE_BY_ID[e.type];
      if (!type || type.lane !== lane || this.hidden.has(e.type)) continue;
      const x = this.x(e.t);
      let distance = Math.abs(px - x);
      if (type.shape === "band" && e.end !== null && px >= x && px <= this.x(e.end)) distance = 0;
      if (distance <= HIT_RADIUS && distance < bestDistance) {
        best = e;
        bestDistance = distance;
      }
    }
    return best;
  }

  mouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  handleClick(e) {
    const [px, py] = this.mouse(e);
    const hit = this.hitTest(px, py);
    if (hit) this.onSelect(hit);
    else if (px >= LEFT) this.onSelect({ t: this.timeAt(px), type: "seek" });   // empty space: just seek
  }

  handleHover(e) {
    const [px, py] = this.mouse(e);
    const hit = this.hitTest(px, py);
    this.canvas.style.cursor = hit ? "pointer" : "default";
    if (!hit) { this.tooltip.hidden = true; return; }
    const where = hit.corner ? ` at ${hit.corner}` : "";
    this.tooltip.textContent =
      `${formatTime(hit.t)}${hit.lap ? ` · lap ${hit.lap}` : ""} · ${hit.label}${where}`;
    this.tooltip.hidden = false;
    // Place it above the strip, kept inside the window.
    const x = Math.min(e.clientX + 12, window.innerWidth - this.tooltip.offsetWidth - 8);
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${rectTop(this.canvas) - this.tooltip.offsetHeight - 6}px`;
  }
}

function rectTop(element) {
  return element.getBoundingClientRect().top;
}
