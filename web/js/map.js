// Canvas 2D drawing of the track, corner numbers, the cars, and the camera that can follow a driver.
import { countUpTo } from "./replay.js";
import { STATE_COLORS, driveState } from "./telemetry.js";
import { gapText } from "./focus.js";
import { colors } from "./theme.js";
import { carSprite, SPRITE_WIDTH, SPRITE_HEIGHT } from "./carsprite.js";
import { SECTOR_COLORS, formatSeconds } from "./sectors.js";

export class TrackMap {
  constructor(canvas, track) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.track = track;
    this.camera = null;      // { cx, cy, scale }: see updateCamera
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
    this.camera = { ...this.fit };
  }

  /*
   * CAMERA
   * The camera is the centre (cx, cy) in data units and a zoom `scale` (pixels per data unit).
   * Overview: the camera shows the whole track. Focus mode: the camera centres on the driver
   * and zooms in until `radius` metres fit between his position and the nearest edge.
   * We do not jump to the target: every frame we move a fraction k of the remaining distance
   * ("exponential smoothing"). k depends on the frame time, so it looks the same at any frame
   * rate. The zoom is smoothed through its ratio, because zooming feels linear in the ratio.
   */
  updateCamera(dt, focusPoint, radiusMetres) {
    const c = this.camera;
    let target = this.fit;
    if (focusPoint) {
      const unitsToEdge = radiusMetres * 10;           // 1 data unit = 1/10 metre
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
   */
  draw(replay, view, dt) {
    const ctx = this.ctx;
    let focusPoint = null;
    let radius = view.zoomMetres;
    if (view.focus) {
      focusPoint = replay.positionOf(view.focus.abbr);
    } else if (view.action) {
      ({ point: focusPoint, radius } = this.actionView(replay, view));
    }
    this.updateCamera(dt, focusPoint, radius);

    ctx.clearRect(0, 0, this.width, this.height);
    this.drawTrack();
    if (view.mini) this.drawMiniSectors(view.mini.data, view.mini.lap, view.options);
    if (view.sectors) this.drawSectors(view.sectors);
    if (view.options.showCorners) this.drawCorners();
    this.drawSelectedEvent(view.selected || (view.action && view.action.event), replay.time);
    if (!view.focus) this.drawBattleLinks(replay, view.battleLinks);
    if (!view.sectors) this.drawTrails(replay, view.highlighted, view.telemetry);   // it would hide the sector colours
    this.drawCars(replay, view);
  }

  // Highlights mode: the camera centres on the drivers of the event and zooms so that they fit.
  // Returns { point, radius } for updateCamera (radius in metres, from the centre to the edge).
  actionView(replay, view) {
    const points = view.action.abbrs.map((abbr) => replay.positionOf(abbr));
    const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    let spread = 0;                                     // metres from the centre to the farthest car
    for (const p of points) spread = Math.max(spread, Math.hypot(p.x - cx, p.y - cy) / 10);
    return { point: { x: cx, y: cy }, radius: Math.max(view.zoomMetres * 0.6, spread * 1.4 + 100) };
  }

  // A line between the two cars of every battle in progress, with the gap in seconds.
  drawBattleLinks(replay, links) {
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

  drawTrack() {
    const ctx = this.ctx;
    const { x, y } = this.track;
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
    for (const d of replay.race.meta.drivers) {
      if (!replay.race.positions.drivers[d.abbr]) continue;   // driver without position data
      if (d.status === "DNS") continue;                       // never left the pit lane
      const p = replay.positionOf(d.abbr);
      const [px, py] = this.toScreen(p.x, p.y);
      const involved = !!view.action && view.action.abbrs.includes(d.abbr);
      this.carSpots.push({ abbr: d.abbr, px, py, radius: this.carRadius(view.options) });

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
      drawn.push({ px, py, d, style, note, look });
    }
    // Draw order: faded cars first, highlighted last, so the important ones are on top.
    const order = { hidden: 0, dim: 1, normal: 2, neighbour: 3, highlight: 4 };
    drawn.sort((a, b) => order[a.style] - order[b.style]);
    for (const c of drawn) this.drawCar(c.px, c.py, c.d, c.style, c.note, view.options, c.look);
  }

  // Size of a car on the screen, in pixels. The "size" setting is the radius of the old dot;
  // the pixel-art car is 5 times that long (so the default 6 gives a car about 30 px long).
  carLength(options) {
    return options.dotSize * 5;
  }

  // Radius of the area where a click counts as "on this car".
  carRadius(options) {
    return options.carStyle === "pixel" ? Math.max(12, this.carLength(options) / 2) : 12;
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
   * We have no heading in the data, so we take it from the movement: where the car will be half
   * a second later minus where it was half a second earlier (the straight line between the two
   * is the direction of travel; a window on both sides keeps it steady).
   * A car that does not move (grid before the start, in the pit box, stopped on track) has no
   * direction of travel, so we look for the last time it was moving, then for the next time,
   * and as a last resort we use the direction of the track at the nearest point.
   */
  headingOf(replay, abbr) {
    const t = replay.time;
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
  drawCar(px, py, driver, style, note, options, look) {
    const ctx = this.ctx;
    const pixel = options.carStyle === "pixel";
    const r = options.dotSize;
    // Half of the space the car takes: used to put the label next to it, not on top of it.
    let half = r;
    ctx.globalAlpha = style === "dim" ? 0.4 : style === "hidden" ? 0.12 : 1;

    if (pixel) {
      // Zoomed in (focus mode) only three cars are clear, so they can be bigger: up to 1.6x.
      const zoomedIn = Math.min(Math.max(this.camera.scale / this.fit.scale - 1, 0), 2) / 2;
      const factor = ({ highlight: 1.4, neighbour: 1.15, hidden: 0.6 }[style] ?? 1) * (1 + 0.6 * zoomedIn);
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

    // Labels: faded cars in focus mode have none; the "driver names" setting hides the others.
    const important = style === "highlight" || style === "neighbour";
    if (style !== "hidden" && (important || options.showLabels)) {
      ctx.font = style === "highlight" ? "bold 14px system-ui" : "bold 11px system-ui";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = colors.mapText;
      ctx.fillText(note ? `${driver.abbr}  ${note}` : driver.abbr, px + half + 4, py);
    }
    ctx.globalAlpha = 1;
  }
}
