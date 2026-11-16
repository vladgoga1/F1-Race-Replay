// Canvas 2D drawing of the track, corner numbers, the cars, and the camera that can follow a driver.
import { countUpTo, stepValue } from "./replay.js";
import { STATE_COLORS, driveState } from "./telemetry.js";
import { gapText } from "./focus.js";
import { colors } from "./theme.js";
import { carSprite, SPRITE_WIDTH, SPRITE_HEIGHT } from "./carsprite.js";
import { SECTOR_COLORS, formatSeconds } from "./sectors.js";
import { LIMITS_COLOR } from "./timeline.js";

// Track limits marks (drawTrackLimits): shown from LIMITS_BEFORE s before the event until
// LIMITS_AFTER s after it, fading out during the last LIMITS_FADE s.
const LIMITS_BEFORE = 1, LIMITS_AFTER = 5, LIMITS_FADE = 1.5;

export class TrackMap {
  constructor(canvas, track) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.track = track;
    this.camera = null;      // { cx, cy, scale }: see updateCamera
    this.manual = null;      // the view chosen with the mouse (wheel / drag), or null
    this.zoomBoost = 1;      // the mouse wheel in focus / highlights mode: >1 = see more around the car
    this.following = false;  // is the camera following cars (focus, highlights, follow)? set by draw()
    this.carSpots = [];
    this.variants = null;    // abbr -> 0 or 1: which of the two cars of a team (see carVariants)
    this.computeBounds();
  }

  // Smallest rectangle containing the whole track (data units, 1 unit = 1/10 metre).
  computeBounds() {
    const { x, y } = this.track;
    this.minX = Math.min(...x);
    this.maxX = Math.max(...x);
    this.minY = Math.min(...y);
    this.maxY = Math.max(...y);
  }

  // Keep the canvas pixel size equal to its CSS size, otherwise the drawing is blurry.
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // draw in CSS pixels, canvas handles the rest
    this.width = w;
    this.height = h;

    // The view that shows the whole track with a margin. Same scale on both axes keeps the shape.
    const margin = 50;
    const sx = (w - 2 * margin) / (this.maxX - this.minX);
    const sy = (h - 2 * margin) / (this.maxY - this.minY);
    this.fit = {
      cx: (this.minX + this.maxX) / 2,
      cy: (this.minY + this.maxY) / 2,
      scale: Math.min(sx, sy),
    };
    this.camera = this.manual ? { ...this.manual } : { ...this.fit };
  }

  /*
   * CAMERA
   * The camera is the centre (cx, cy) in data units and a zoom `scale` (pixels per data unit).
   * Overview: the camera shows the whole track. Focus mode: the camera centres on the driver
   * and zooms in until `radius` metres fit between his position and the nearest edge.
   * We do not jump to the target: every frame we move a fraction k of the remaining distance
   * ("exponential smoothing"). k depends on the frame time, so it looks the same at any frame
   * rate. The zoom is smoothed through its ratio, because zooming feels linear in the ratio.
   * `freeTarget` = where the camera goes when it follows nobody: the view chosen with the mouse,
   * the automatic view of the pack (packView), or null for the whole track.
   */
  updateCamera(dt, focusPoint, radiusMetres, freeTarget = null) {
    const c = this.camera;
    let target = freeTarget || this.fit;
    if (focusPoint) {
      const unitsToEdge = radiusMetres * this.zoomBoost * 10;   // 1 data unit = 1/10 metre
      target = { cx: focusPoint.x, cy: focusPoint.y, scale: Math.min(this.width, this.height) / 2 / unitsToEdge };
    }
    const k = 1 - Math.exp(-dt * (focusPoint ? 10 : 5));
    c.cx += (target.cx - c.cx) * k;
    c.cy += (target.cy - c.cy) * k;
    c.scale *= Math.pow(target.scale / c.scale, k);
  }

  // Data coordinates -> canvas pixels. Y is flipped because canvas Y grows downwards.
  toScreen(x, y) {
    const c = this.camera;
    return [
      this.width / 2 + (x - c.cx) * c.scale,
      this.height / 2 - (y - c.cy) * c.scale,
    ];
  }

  /*
   * `view` = what the user chose to look at:
   *   highlighted: Set of abbreviations      selected: overtake event or null
   *   focus: { abbr, ahead, behind } or null  telemetry: TelemetryStore
   *   mini: { data: MiniSectors, lap } or null   options: map settings (corners, labels, dot size)
   *   sectors: { data: Sectors, lap, driver } or null
   *   action: { abbrs, event } or null (Highlights mode: the camera goes to these drivers)
   *   battleLinks: [{ a, b, gap, selected }] lines between the cars of a battle
   *   hiddenTypes: Set of the event types switched off in the timeline
   */
  draw(replay, view, dt) {
    const ctx = this.ctx;
    let focusPoint = null;
    let radius = view.zoomMetres;
    if (view.focus) {
      focusPoint = replay.positionOf(view.focus.abbr);
    } else if (view.action) {
      ({ point: focusPoint, radius } = this.actionView(replay, view));
    } else if (view.follow) {
      const abbrs = [...view.highlighted].filter((abbr) => abbr in replay.race.positions.drivers);
      if (abbrs.length > 0) ({ point: focusPoint, radius } = this.groupView(replay, abbrs, view.zoomMetres));
    }
    this.following = !!focusPoint;
    const free = focusPoint ? null : this.manual || (view.options.autoCamera ? this.packView(replay, view) : null);
    this.updateCamera(dt, focusPoint, radius, free);

    ctx.clearRect(0, 0, this.width, this.height);
    this.drawTrack();
    if (view.mini) this.drawMiniSectors(view.mini.data, view.mini.lap, view.options);
    if (view.sectors) this.drawSectors(view.sectors);
    if (view.options.showCorners) this.drawCorners();
    this.drawSelectedEvent(view.selected || (view.action && view.action.event), replay.time);
    this.gapLabels = [];
    if (!view.focus) this.drawBattleLinks(replay, view.battleLinks);
    this.drawSideBySide(replay, view);
    this.drawTrackLimits(replay, view);
    if (!view.sectors) this.drawTrails(replay, view.highlighted, view.telemetry);   // it would hide the sector colours
    this.drawCars(replay, view);
  }

  // Highlights mode: the camera centres on the drivers of the event and zooms so that they fit.
  // Returns { point, radius } for updateCamera (radius in metres, from the centre to the edge).
  actionView(replay, view) {
    return this.groupView(replay, view.action.abbrs, view.zoomMetres * 0.6);
  }

  // The camera on a group of drivers: centred on them (the average of their positions), zoomed
  // so that all of them fit, but never closer than `minRadius` metres. One driver = he is in the
  // middle of the screen. Used by Highlights and by "Follow" (the highlighted drivers).
  groupView(replay, abbrs, minRadius) {
    const points = abbrs.map((abbr) => replay.positionOf(abbr));
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    let spread = 0;                                     // metres from the centre to the farthest car
    for (const p of points) spread = Math.max(spread, Math.hypot(p.x - cx, p.y - cy) / 10);
    return { point: { x: cx, y: cy }, radius: Math.max(minRadius, spread * 1.4 + 100) };
  }

  /*
   * AUTOMATIC CAMERA ON THE PACK. At the start or behind the safety car the 20 cars are a few
   * hundred metres long: seen with the whole track they are a blob. So we take the rectangle around
   * the cars, add a margin and zoom until it fills the map. When the cars spread out the rectangle
   * grows, and once it is as big as the track the view is simply the whole track again.
   * A car that stands still while the others race (stalled, in the pit box) is left out,
   * otherwise it alone would keep the view zoomed out.
   * Returns a camera { cx, cy, scale }, or null for the whole track.
   */
  packView(replay, view) {
    const cars = [];
    for (const d of replay.race.meta.drivers) {
      if (d.status === "DNS" || !replay.race.positions.drivers[d.abbr]) continue;
      const out = view.retiredAt && view.retiredAt[d.abbr];
      if (out !== undefined && replay.time > out) continue;          // retired: no longer racing
      const before = replay.positionOf(d.abbr, replay.time - 0.5);
      const after = replay.positionOf(d.abbr, replay.time + 0.5);
      const speed = Math.hypot(after.x - before.x, after.y - before.y) / 10;   // metres per second
      cars.push({ ...replay.positionOf(d.abbr), speed });
    }
    if (cars.length < 2) return null;
    // While most cars are moving, a car that stands still (stalled, in the pit box) does not count.
    // Before the start everybody stands still on the grid: then all of them count.
    const moving = cars.filter((c) => c.speed > 5);
    const kept = moving.length >= cars.length / 2 ? moving : cars;
    if (kept.length < 2) return null;

    const pad = 700;                                     // 70 m around the cars, room for the names
    const minX = Math.min(...kept.map((p) => p.x)) - pad;
    const maxX = Math.max(...kept.map((p) => p.x)) + pad;
    const minY = Math.min(...kept.map((p) => p.y)) - pad;
    const maxY = Math.max(...kept.map((p) => p.y)) + pad;
    const closest = Math.min(this.width, this.height) / 2 / 1500;   // never closer than 150 m to the edge
    const scale = Math.min(this.width / (maxX - minX), this.height / (maxY - minY), closest);
    if (scale <= this.fit.scale) return null;
    // Just above the overview, the centre slides between the track centre and the pack centre,
    // so the view does not jump when the pack becomes as big as the track.
    const blend = Math.min((scale / this.fit.scale - 1) / 0.5, 1);
    return {
      cx: this.fit.cx + ((minX + maxX) / 2 - this.fit.cx) * blend,
      cy: this.fit.cy + ((minY + maxY) / 2 - this.fit.cy) * blend,
      scale,
    };
  }

  /*
   * MOUSE. The wheel zooms around the mouse pointer: the point of the track under the pointer
   * stays under it. Dragging moves the map. Both make a "manual" view that stays until fitView().
   * While the camera follows a car (focus, highlights) the wheel only changes how much you see
   * around it (zoomBoost), and dragging does nothing.
   */
  zoomBy(factor, mx = this.width / 2, my = this.height / 2) {
    if (this.following) {
      this.zoomBoost = Math.min(Math.max(this.zoomBoost / factor, 0.25), 4);
      return;
    }
    const c = this.manual || this.camera;
    const dataX = c.cx + (mx - this.width / 2) / c.scale;         // the point under the mouse...
    const dataY = c.cy - (my - this.height / 2) / c.scale;
    const scale = Math.min(Math.max(c.scale * factor, this.fit.scale * 0.5), this.fit.scale * 60);
    this.manual = {                                                // ...is still under it after the zoom
      cx: dataX - (mx - this.width / 2) / scale,
      cy: dataY + (my - this.height / 2) / scale,
      scale,
    };
    this.camera = { ...this.manual };
  }

  panBy(dxPixels, dyPixels) {
    if (this.following) return;
    const c = this.manual || this.camera;
    this.manual = { cx: c.cx - dxPixels / c.scale, cy: c.cy + dyPixels / c.scale, scale: c.scale };
    this.camera = { ...this.manual };
  }

  // Back to the automatic view (whole track, or the pack when "auto zoom" is on).
  fitView() {
    this.manual = null;
    this.zoomBoost = 1;
  }

  // How big the cars are drawn: smaller when the whole track is on the screen (there they would be
  // longer than the gaps between them), bigger when zoomed in. 0.6 at the overview, 1.5 at most.
  sizeFactor() {
    const ratio = Math.max(this.camera.scale / this.fit.scale, 1);
    return Math.min(0.6 + 0.37 * Math.log2(ratio), 1.5);
  }

  // A line between the two cars of every battle in progress, with the gap in seconds.
  drawBattleLinks(replay, links) {
    this.gapLabels = [];                 // rectangles of the gap texts: the driver names avoid them
    if (!links || links.length === 0) return;
    const ctx = this.ctx;
    ctx.lineCap = "round";
    ctx.font = "bold 11px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const link of links) {
      if (!replay.race.positions.drivers[link.a] || !replay.race.positions.drivers[link.b]) continue;
      const pa = replay.positionOf(link.a);
      const pb = replay.positionOf(link.b);
      const [ax, ay] = this.toScreen(pa.x, pa.y);
      const [bx, by] = this.toScreen(pb.x, pb.y);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = link.selected ? 3 : 2;
      ctx.strokeStyle = link.selected ? colors.mapText : "#ff8c1a";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      if (link.gap !== null) {
        const text = `${link.gap.toFixed(1)} s`;
        const w = ctx.measureText(text).width;
        this.gapLabels.push({ x: (ax + bx) / 2 - w / 2, y: (ay + by) / 2 - 17, w, h: 14 });
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000000bb";
        ctx.strokeText(text, (ax + bx) / 2, (ay + by) / 2 - 10);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(text, (ax + bx) / 2, (ay + by) / 2 - 10);
      }
    }
  }

  /*
   * The three official sectors. Like the mini-sectors, every sector is a piece of the track
   * outline (sectors.json), painted with one colour: in "driver" mode the TV colour of the time
   * of that driver (purple / green / yellow), in "fastest" mode the colour of the team of the
   * fastest driver in that sector. A thin line marks the start of every sector; the first one is
   * the start/finish line and is white.
   */
  drawSectors({ data, lap, driver }) {
    const ctx = this.ctx;
    const { pieces } = data.data;
    const width = Math.max(10, 130 * this.camera.scale);
    const times = driver ? data.driverLap(driver, lap) : null;
    const fastest = driver ? null : data.fastest(lap);

    ctx.lineWidth = width;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    pieces.forEach((points, k) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        const [px, py] = this.toScreen(x, y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      let color = colors.track;
      if (times && times[k].kind) color = SECTOR_COLORS[times[k].kind];
      if (fastest && fastest[k]) color = data.colors[fastest[k].abbr];
      ctx.strokeStyle = color;
      ctx.stroke();
    });

    pieces.forEach((points, k) => {
      const [x0, y0] = this.toScreen(points[0][0], points[0][1]);
      const [x1, y1] = this.toScreen(points[1][0], points[1][1]);
      const length = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / length * width / 2;          // perpendicular to the track
      const ny = (x1 - x0) / length * width / 2;
      ctx.strokeStyle = k === 0 ? "#ffffff" : colors.bg;
      ctx.lineWidth = k === 0 ? 4 : 3;
      ctx.beginPath();
      ctx.moveTo(x0 - nx, y0 - ny);
      ctx.lineTo(x0 + nx, y0 + ny);
      ctx.stroke();
    });

    // Labels in the middle of every sector, with a dark outline so they read on any colour.
    ctx.font = "bold 12px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    pieces.forEach((points, k) => {
      const [x, y] = points[Math.floor(points.length / 2)];
      const [px, py] = this.toScreen(x, y);
      let text = `S${k + 1}`;
      if (times) text += `  ${formatSeconds(times[k].time)}`;
      else if (fastest && fastest[k]) text += `  ${fastest[k].abbr}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#000000cc";
      ctx.strokeText(text, px, py);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, px, py);
    });
  }

  // Marks the place of the selected overtake with a pulsing ring and its label. The mark only
  // belongs to the moment of the event: it shows from a few seconds before until a few seconds
  // after (fading out), not for ever, because the cars are long gone from that place by then.
  drawSelectedEvent(event, time) {
    if (!event || event.x === undefined) return;
    const FROM = 4, UNTIL = 7, FADE = 2;                       // seconds around event.t
    const left = event.t + UNTIL - time;                       // seconds until the mark disappears
    if (time < event.t - FROM || left <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, left / FADE);
    try {
      this.drawEventRing(event);
    } finally {
      ctx.restore();
    }
  }

  drawEventRing(event) {
    const ctx = this.ctx;
    const [px, py] = this.toScreen(event.x, event.y);
    const pulse = (performance.now() % 1200) / 1200;           // 0..1, repeats every 1.2 s
    const base = ctx.globalAlpha;                                // the fade-out set by drawSelectedEvent
    ctx.globalAlpha = base * (1 - pulse);
    ctx.strokeStyle = colors.mapText;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, 10 + pulse * 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = base;
    ctx.fillStyle = colors.mapText;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "bold 12px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${event.label}${event.corner ? ` (${event.corner})` : ""}`, px + 14, py - 12);
  }

  /*
   * SIDE BY SIDE (an estimate, see Replay.sideBySide). Both cars are on the same line, so they are
   * drawn on top of each other: a short white bar across the track marks the pair (no text: it crowded the map at the start).
   * We do not know who is on the inside, so the cars are not moved sideways.
   * In focus mode only the pairs with the focused driver or one of his two neighbours.
   */
  drawSideBySide(replay, view) {
    let pairs = replay.sideBySide(view.retiredAt || {});
    if (view.focus) {
      const shown = [view.focus.abbr, view.focus.ahead && view.focus.ahead.abbr, view.focus.behind && view.focus.behind.abbr];
      pairs = pairs.filter(([a, b]) => shown.includes(a) || shown.includes(b));
    }
    if (pairs.length === 0) return;
    const ctx = this.ctx;
    const half = this.carRadius(view.options, this.sizeFactor()) * 1.3;   // a bit wider than a car
    ctx.save();
    ctx.lineCap = "round";
    for (const [a, b] of pairs) {
      const pa = replay.positionOf(a);
      const pb = replay.positionOf(b);
      const [mx, my] = this.toScreen((pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
      const dir = replay.lineDirectionOf(a);
      const len = Math.hypot(dir.dx, dir.dy) || 1;
      const nx = dir.dy / len, ny = dir.dx / len;     // across the track on the screen (screen Y is flipped)
      ctx.beginPath();
      ctx.moveTo(mx - nx * half, my - ny * half);
      ctx.lineTo(mx + nx * half, my + ny * half);
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#000000bb";
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    ctx.restore();
  }

  /*
   * TRACK LIMITS. While the replay passes a track limits event (a deleted lap time, a car that left
   * the track; see detect_track_limits.py) a small warning sign is drawn at the turn with the
   * driver and what happened, for a few seconds only. Not drawn when the type is switched off in
   * the timeline; with highlighted drivers (or in focus mode) only theirs. The selected event has
   * its own ring (drawSelectedEvent). The texts go into this.gapLabels so the driver names keep
   * away from them (see drawLabels).
   */
  drawTrackLimits(replay, view) {
    if (view.hiddenTypes && view.hiddenTypes.has("limits")) return;
    const time = replay.time;
    const shown = replay.race.events.filter((e) => e.type === "limits" && e !== view.selected
      && time >= e.t - LIMITS_BEFORE && time <= e.t + LIMITS_AFTER && this.limitsWanted(e, view));
    if (shown.length === 0) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.font = "bold 11px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const used = {};                               // turn -> marks already drawn there (stacked texts)
    for (const e of shown) {
      const [px, py] = this.toScreen(e.x, e.y);
      const row = used[e.turn] = (used[e.turn] || 0) + 1;
      ctx.globalAlpha = Math.min(1, (e.t + LIMITS_AFTER - time) / LIMITS_FADE);
      if (row === 1) {                             // the sign once per turn
        ctx.fillStyle = LIMITS_COLOR;
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, py - 7); ctx.lineTo(px + 7, py + 5); ctx.lineTo(px - 7, py + 5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const x = px + 10;
      const y = py - 12 - (row - 1) * 14;         // more than one at the same turn: one above the other
      const w = ctx.measureText(e.label).width;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#000000cc";
      ctx.strokeText(e.label, x, y);
      ctx.fillStyle = LIMITS_COLOR;
      ctx.fillText(e.label, x, y);
      this.gapLabels.push({ x, y: y - 7, w, h: 14 });
    }
    ctx.restore();
  }

  // Track limits marks with highlighted drivers or in focus mode: only those about them.
  limitsWanted(e, view) {
    const drivers = e.drivers || [e.driver];
    if (view.focus) return drivers.includes(view.focus.abbr);
    if (view.highlighted.size > 0) return drivers.some((abbr) => view.highlighted.has(abbr));
    return true;
  }

  drawTrack() {
    const ctx = this.ctx;
    // The dense racing line (a point every ~2 m) when the race has it: smooth curves when zoomed
    // in, and exactly where the cars drive. Older exports: the outline of the fastest lap.
    const { x, y } = this.track.line || this.track;
    ctx.beginPath();
    for (let i = 0; i < x.length; i++) {
      const [px, py] = this.toScreen(x[i], y[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.lineWidth = Math.max(10, 130 * this.camera.scale);   // about 13 m wide when zoomed in
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors.track;
    ctx.stroke();
  }

  /*
   * Every mini-sector is a short piece of the track outline (the points come ready-made from
   * minisectors.json). We draw each piece in the colour of the driver who was fastest through
   * it in `lap`, a thin gap in the background colour marks where one piece ends and the next
   * starts, and the name of the driver is written on the piece.
   */
  drawMiniSectors(mini, lap, options) {
    const ctx = this.ctx;
    const { winners } = mini.analyse(lap);
    const width = Math.max(10, 130 * this.camera.scale);

    ctx.lineWidth = width;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    mini.data.sectors.forEach((points, j) => {
      ctx.beginPath();
      points.forEach(([x, y], i) => {
        const [px, py] = this.toScreen(x, y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = winners[j] ? mini.colors[winners[j]] : colors.track;
      ctx.stroke();
    });

    // Separators between the pieces: a short line across the track at the start of each piece.
    ctx.strokeStyle = colors.bg;
    ctx.lineWidth = 2;
    for (const points of mini.data.sectors) {
      const [x0, y0] = this.toScreen(points[0][0], points[0][1]);
      const [x1, y1] = this.toScreen(points[1][0], points[1][1]);
      const length = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / length * width / 2;          // perpendicular to the track
      const ny = (x1 - x0) / length * width / 2;
      ctx.beginPath();
      ctx.moveTo(x0 - nx, y0 - ny);
      ctx.lineTo(x0 + nx, y0 + ny);
      ctx.stroke();
    }

    if (!options.showMiniLabels) return;
    ctx.font = "bold 10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    mini.data.sectors.forEach((points, j) => {
      if (!winners[j]) return;
      const [x, y] = points[Math.floor(points.length / 2)];
      const [px, py] = this.toScreen(x, y);
      ctx.strokeStyle = "#000000bb";                      // dark outline so the text reads on any colour
      ctx.strokeText(winners[j], px, py);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(winners[j], px, py);
    });
  }

  drawCorners() {
    const ctx = this.ctx;
    ctx.font = "11px system-ui";
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const c of this.track.corners) {
      const [px, py] = this.toScreen(c.x, c.y);
      ctx.fillText(`${c.n}${c.letter}`, px, py);
    }
  }

  /*
   * The coloured trace of a highlighted driver: his path in the current lap so far, split in
   * small pieces coloured by what he was doing: green = accelerating, red = braking,
   * yellow = coasting. Consecutive pieces of the same colour are drawn as ONE path, so a
   * lap is a few dozen strokes instead of hundreds.
   */
  drawTrails(replay, highlighted, store) {
    if (!store) return;
    const ctx = this.ctx;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const abbr of highlighted) {
      const tel = store.get(abbr);
      const strategy = replay.race.strategy.drivers[abbr];
      if (!tel || !strategy) continue;

      const lap = Math.max(countUpTo(strategy.laps, replay.time), 1);
      const first = Math.max(Math.ceil(strategy.laps[lap - 1] / tel.step), 0);
      const last = Math.min(Math.floor(replay.time / tel.step), tel.speed.length - 1);

      let runColor = null;
      for (let i = first; i <= last; i++) {
        const p = replay.positionOf(abbr, i * tel.step);
        const [px, py] = this.toScreen(p.x, p.y);
        const color = STATE_COLORS[driveState(tel, i)];
        if (runColor === null) {
          ctx.beginPath();
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
          if (color !== runColor) {          // the colour changes here: close the previous stroke
            ctx.strokeStyle = runColor;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(px, py);
          }
        }
        runColor = color;
      }
      if (runColor !== null) {
        ctx.strokeStyle = runColor;
        ctx.stroke();
      }
    }
  }

  drawCars(replay, view) {
    const { highlighted, focus } = view;
    this.carSpots = [];                  // remembered for click detection (see carAt)
    const drawn = [];
    const size = this.sizeFactor();
    for (const d of replay.race.meta.drivers) {
      if (!replay.race.positions.drivers[d.abbr]) continue;   // driver without position data
      if (d.status === "DNS") continue;                       // never left the pit lane
      const p = replay.positionOf(d.abbr);
      const [px, py] = this.toScreen(p.x, p.y);
      const involved = !!view.action && view.action.abbrs.includes(d.abbr);
      this.carSpots.push({ abbr: d.abbr, px, py, radius: this.carRadius(view.options, size) });

      let style = "normal";
      let note = "";
      if (focus) {
        // Focus mode: only the driver and his two neighbours are drawn clearly.
        if (d.abbr === focus.abbr) style = "highlight";
        else if (focus.ahead && d.abbr === focus.ahead.abbr) { style = "neighbour"; note = gapText(focus.ahead.gap); }
        else if (focus.behind && d.abbr === focus.behind.abbr) { style = "neighbour"; note = gapText(focus.behind.gap); }
        else style = "hidden";
      } else if (highlighted.size > 0) {
        style = highlighted.has(d.abbr) ? "highlight" : involved ? "neighbour" : "dim";
      } else if (involved) {
        style = "neighbour";                // Highlights mode: the cars of the moment get a white ring
      }
      const look = { heading: this.headingOf(replay, d.abbr), variant: this.carVariants(replay).get(d.abbr) };
      drawn.push({ px, py, d, style, note, look, half: this.carRadius(view.options, size) });
    }
    // Draw order: faded cars first, highlighted last, so the important ones are on top.
    const order = { hidden: 0, dim: 1, normal: 2, neighbour: 3, highlight: 4 };
    drawn.sort((a, b) => order[a.style] - order[b.style]);
    const labels = [];
    for (const c of drawn) {
      const label = this.drawCar(c.px, c.py, c.d, c.style, c.note, view.options, c.look, size);
      if (label) {
        label.position = stepValue(replay.race.standings.position[c.d.abbr], replay.time) ?? 99;
        labels.push(label);
      }
    }
    this.drawLabels(labels, drawn);
  }

  /*
   * NAMES WITHOUT OVERLAPS. The labels are placed one by one: the highlighted drivers first, then
   * in race order (the leader first). Each one tries four places around its car (right, left,
   * above, below) and takes the first one that does not cover a label already placed or another
   * car. If none is free it tries again with just the race position ("7"), and if that does not
   * fit either the car gets no label. Highlighted drivers always get their name.
   */
  drawLabels(labels, cars) {
    const ctx = this.ctx;
    // Rectangles already taken: start with the cars (a small square around each one).
    const taken = cars.filter((c) => c.style !== "hidden").map((c) => {
      const s = c.half * 0.6;
      return { x: c.px - s, y: c.py - s, w: 2 * s, h: 2 * s };
    }).concat(this.gapLabels || []);
    const free = (r) => !taken.some((t) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h);

    labels.sort((a, b) => (b.important - a.important) || (a.position - b.position));
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const label of labels) {
      ctx.font = label.font;
      const texts = label.important || label.position === 99 ? [label.text] : [label.text, String(label.position)];
      let spot = null;
      for (const text of texts) {
        const w = ctx.measureText(text).width;
        const h = label.fontSize + 2;
        const gap = label.half + 3;
        const places = [
          { x: label.px + gap, y: label.py - h / 2 },          // right
          { x: label.px - gap - w, y: label.py - h / 2 },      // left
          { x: label.px - w / 2, y: label.py - gap - h },      // above
          { x: label.px - w / 2, y: label.py + gap },          // below
        ].map((p) => ({ ...p, w, h, text }));
        spot = places.find(free) || (label.important && text === label.text ? places[0] : null);
        if (spot) break;
      }
      if (!spot) continue;
      taken.push(spot);
      ctx.globalAlpha = label.alpha;
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.bg;                        // outline: readable over the track and the cars
      ctx.strokeText(spot.text, spot.x, spot.y + spot.h / 2);
      ctx.fillStyle = colors.mapText;
      ctx.fillText(spot.text, spot.x, spot.y + spot.h / 2);
    }
    ctx.globalAlpha = 1;
  }

  // Size of a car on the screen, in pixels. The "size" setting is the radius of the old dot;
  // the pixel-art car is 5 times that long (so the default 6 gives a car about 30 px long).
  carLength(options) {
    return options.dotSize * 5;
  }

  // Radius of the area where a click counts as "on this car" (`size`: see sizeFactor).
  carRadius(options, size = 1) {
    return options.carStyle === "pixel" ? Math.max(10, this.carLength(options) * size / 2) : 12;
  }

  // The two cars of a team have the same colour. The first one in the driver list gets variant 0
  // and the second variant 1 (a white or a black stripe on the engine cover).
  carVariants(replay) {
    if (!this.variants) {
      this.variants = new Map();
      const seen = {};
      for (const d of replay.race.meta.drivers) {
        seen[d.team] = (seen[d.team] ?? -1) + 1;
        this.variants.set(d.abbr, seen[d.team] % 2);
      }
    }
    return this.variants;
  }

  /*
   * HEADING: the direction a car points to, in radians, in screen coordinates (0 = right,
   * positive = clockwise, because the canvas Y axis points down).
   * On the racing line the car points along the line (see Replay.lineDirectionOf): smooth, and
   * also right for a car standing still on the grid or on track.
   * Elsewhere (pit lane, garage, off track) we have no heading in the data, so we take it from
   * the movement: where the car will be half a second later minus where it was half a second
   * earlier (the straight line between the two is the direction of travel; a window on both sides
   * keeps it steady).
   * A car that does not move there (in the pit box, stopped off the track) has no
   * direction of travel, so we look for the last time it was moving, then for the next time,
   * and as a last resort we use the direction of the track at the nearest point.
   */
  headingOf(replay, abbr) {
    const t = replay.time;
    const along = replay.lineDirectionOf(abbr, t);
    if (along) return Math.atan2(-along.dy, along.dx);
    const moving = (time) => {
      const a = replay.positionOf(abbr, time - 0.5);
      const b = replay.positionOf(abbr, time + 0.5);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      return Math.hypot(dx, dy) > 30 ? Math.atan2(-dy, dx) : null;   // 30 units = 3 m in 1 s
    };
    let heading = moving(t);
    for (let k = 1; heading === null && k <= 30; k++) heading = moving(t - 3 * k);   // earlier
    for (let k = 1; heading === null && k <= 30; k++) heading = moving(t + 3 * k);   // later
    return heading ?? this.trackHeadingAt(replay.positionOf(abbr));
  }

  // Direction of the track outline at the point nearest to `p` (data coordinates).
  trackHeadingAt(p) {
    const { x, y } = this.track;
    let nearest = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < x.length; i++) {
      const distance = Math.hypot(x[i] - p.x, y[i] - p.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = i;
      }
    }
    const next = (nearest + 1) % x.length;
    return Math.atan2(-(y[next] - y[nearest]), x[next] - x[nearest]);
  }

  // Which car is under the mouse, if any (abbreviation or null). Used to highlight by clicking.
  carAt(mouseX, mouseY) {
    let best = null;
    let bestDistance = Infinity;
    for (const c of this.carSpots) {
      const distance = Math.hypot(c.px - mouseX, c.py - mouseY);
      if (distance < c.radius && distance < bestDistance) {   // inside the car and the closest one
        best = c.abbr;
        bestDistance = distance;
      }
    }
    return best;
  }

  // Draws ONE car at screen position (px, py). `look` = { heading, variant } (see headingOf and
  // carVariants). style: "normal", "dim" (someone else is highlighted), "highlight", "neighbour"
  // (focus mode: the car ahead / behind, `note` is the gap) or "hidden" (focus mode: everybody
  // else). `options.carStyle` is "pixel" (pixel-art car) or "dot"; `options.dotSize` (settings)
  // is the radius of a normal dot, and the pixel car is sized from it (see carLength).
  // `size` = sizeFactor() (smaller cars when zoomed out). Returns the label to write (drawLabels
  // writes all of them at the end, so no car covers a name), or null.
  drawCar(px, py, driver, style, note, options, look, size = 1) {
    const ctx = this.ctx;
    const pixel = options.carStyle === "pixel";
    const r = options.dotSize * Math.min(Math.max(size, 0.7), 1.3);
    // Half of the space the car takes: used to put the label next to it, not on top of it.
    let half = r;
    ctx.globalAlpha = style === "dim" ? 0.4 : style === "hidden" ? 0.12 : 1;

    if (pixel) {
      const factor = ({ highlight: 1.4, neighbour: 1.15, hidden: 0.6 }[style] ?? 1) * size;
      const length = this.carLength(options) * factor;
      const width = length * SPRITE_HEIGHT / SPRITE_WIDTH;
      half = length / 2;

      if (style === "highlight" || style === "neighbour") {
        // White ring around the car (with a glow in the team colour for the highlighted one).
        ctx.shadowColor = driver.color;
        ctx.shadowBlur = style === "highlight" ? 18 : 0;
        ctx.beginPath();
        ctx.arc(px, py, length * 0.62, 0, Math.PI * 2);
        ctx.lineWidth = style === "highlight" ? 3 : 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.shadowBlur = 0;
        half = length * 0.62;
      }

      // Move the origin to the car and turn the canvas by the heading: the sprite looks right,
      // so after the rotation it points where the car goes. save/restore undo the transform.
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(look.heading);
      ctx.imageSmoothingEnabled = false;      // sharp pixels instead of a blurry enlargement
      ctx.drawImage(carSprite(driver.color, look.variant), -length / 2, -width / 2, length, width);
      ctx.restore();
    } else if (style === "highlight") {
      // Glow + white ring + bigger dot + bigger label.
      ctx.shadowColor = driver.color;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(px, py, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = driver.color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      half = r + 5;
    } else {
      ctx.beginPath();
      ctx.arc(px, py, style === "neighbour" ? r + 2 : style === "hidden" ? Math.max(3, r - 2) : r, 0, Math.PI * 2);
      ctx.fillStyle = driver.color;
      ctx.fill();
      ctx.lineWidth = style === "neighbour" ? 2 : 1;
      ctx.strokeStyle = style === "neighbour" ? "#ffffff" : "#000";
      ctx.stroke();
      half = style === "neighbour" ? r + 2 : r;
    }

    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    // Labels: faded cars in focus mode have none; the "driver names" setting hides the others.
    const important = style === "highlight" || style === "neighbour";
    if (style === "hidden" || !(important || options.showLabels)) return null;
    const fontSize = style === "highlight" ? 14 : 11;
    return {
      px, py, half, alpha, important, fontSize,
      font: `bold ${fontSize}px system-ui`,
      text: note ? `${driver.abbr}  ${note}` : driver.abbr,
    };
  }
}
