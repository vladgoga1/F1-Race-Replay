// Floating windows: a side tab can be dragged out of the side panel and dropped on the map. It then
// lives in a small window that can be moved (drag its title bar), resized (drag the bottom right
// corner: this sets how much of it is visible, the rest scrolls), made see-through and brought in
// front of the other windows (click it). "Dock" puts the tab back in the side panel.
//
// Nothing is copied: the real tab (the "tab-xxx" element) is moved into the window and back, so all
// the code that fills it keeps working. The windows are remembered in the settings (`floating`):
//   { radio: { x, y, w, h, z, o }, ... }   position, size, stacking order (z) and opacity (o)
const MIN_W = 200;
const MIN_H = 110;

export class FloatingTabs {
  constructor({ layer, sidebar, bar, settings, onLayout }) {
    this.layer = layer;           // the transparent box that holds all windows (over the whole page)
    this.sidebar = sidebar;
    this.bar = bar;               // the row of tab buttons
    this.settings = settings;
    this.onLayout = onLayout;     // called when a tab goes to / comes back from a window
    this.windows = new Map();     // tab name -> window element
    this.top = 0;                 // highest z-index given so far
    window.addEventListener("resize", () => this.windows.forEach((win) => this.place(win, win.offsetLeft, win.offsetTop)));
  }

  isFloating(name) {
    return this.windows.has(name);
  }

  // Makes the windows match the saved settings (at start-up and after "Reset").
  applySaved() {
    const saved = this.settings.values.floating || {};
    for (const name of [...this.windows.keys()]) {
      if (!saved[name]) this.dock(name, true);
    }
    for (const [name, geometry] of Object.entries(saved)) {
      if (!this.windows.has(name)) this.float(name, geometry, true);
    }
  }

  // Moves the tab into a window. `geometry` = {x, y, w, h, z, o}; missing values get defaults.
  float(name, geometry = {}, quiet = false) {
    const pane = document.getElementById(`tab-${name}`);
    const button = this.bar.querySelector(`button[data-tab="${name}"]`);
    if (!pane || !button || this.windows.has(name)) return;

    const win = document.createElement("div");
    win.className = "floatWin";
    win.dataset.tab = name;
    win.innerHTML = `<div class="floatHead"><span class="floatTitle"></span>
      <input type="range" min="0.4" max="1" step="0.05" title="Transparency of the window (left = see-through)">
      <button title="Put it back in the side panel">Dock</button></div><div class="floatBody"></div>`;
    win.querySelector(".floatTitle").textContent = button.firstChild.textContent.trim();
    const slider = win.querySelector("input");
    const body = win.querySelector(".floatBody");
    slider.value = geometry.o ?? 1;
    body.style.opacity = slider.value;
    win.style.width = `${geometry.w ?? 340}px`;
    win.style.height = `${geometry.h ?? 440}px`;
    win.style.zIndex = geometry.z ?? ++this.top;
    this.top = Math.max(this.top, Number(win.style.zIndex));

    pane.hidden = false;
    body.appendChild(pane);
    button.hidden = true;
    button.classList.remove("active");
    this.layer.appendChild(win);
    this.windows.set(name, win);
    this.place(win, geometry.x ?? 80, geometry.y ?? 80);
    this.setupWindow(name, win, slider);
    if (!quiet) this.save();
    this.onLayout();
  }

  // Puts the tab back at the end of the side panel.
  dock(name, quiet = false) {
    const win = this.windows.get(name);
    if (!win) return;
    const pane = document.getElementById(`tab-${name}`);
    pane.hidden = true;                                  // onLayout shows it again if it is the chosen tab
    this.sidebar.appendChild(pane);
    this.bar.querySelector(`button[data-tab="${name}"]`).hidden = false;
    win.resizeWatcher.disconnect();
    win.remove();
    this.windows.delete(name);
    if (!quiet) this.save();
    this.onLayout();
  }

  bringToFront(name) {
    const win = this.windows.get(name);
    if (!win || Number(win.style.zIndex) === this.top) return;
    win.style.zIndex = ++this.top;
    this.save();
  }

  // Keeps the title bar inside the screen (and above the bottom bar) so the window can always be grabbed.
  place(win, x, y) {
    win.style.left = `${Math.min(Math.max(x, 60 - win.offsetWidth), window.innerWidth - 60)}px`;
    win.style.top = `${Math.min(Math.max(y, 0), window.innerHeight - 100)}px`;
  }

  setupWindow(name, win, slider) {
    const head = win.querySelector(".floatHead");
    // Move: pointer events + setPointerCapture keep sending the mouse moves to the title bar even
    // when the mouse leaves it (which happens all the time while dragging).
    head.onpointerdown = (e) => {
      if (e.target.closest("button, input")) return;
      const dx = e.clientX - win.offsetLeft;
      const dy = e.clientY - win.offsetTop;
      head.setPointerCapture(e.pointerId);
      head.onpointermove = (ev) => this.place(win, ev.clientX - dx, ev.clientY - dy);
      head.onpointerup = () => { head.onpointermove = head.onpointerup = null; this.save(); };
    };
    head.querySelector("button").onclick = () => this.dock(name);
    slider.oninput = () => { win.querySelector(".floatBody").style.opacity = slider.value; };
    slider.onchange = () => this.save();
    // Any click on the window brings it in front of the others (capture phase: before its own handlers).
    win.addEventListener("pointerdown", () => this.bringToFront(name), true);
    // The size is changed by the browser (CSS "resize: both"); a ResizeObserver tells us when it ends up different.
    let last = `${win.offsetWidth}x${win.offsetHeight}`;
    win.resizeWatcher = new ResizeObserver(() => {
      const now = `${win.offsetWidth}x${win.offsetHeight}`;
      if (now === last) return;
      last = now;
      clearTimeout(win.saveTimer);
      win.saveTimer = setTimeout(() => this.save(), 300);   // wait until the mouse is released
    });
    win.resizeWatcher.observe(win);
  }

  save() {
    // Renumber the stacking order 1, 2, 3... so the numbers do not grow for ever.
    const ordered = [...this.windows.entries()].sort((a, b) => a[1].style.zIndex - b[1].style.zIndex);
    const saved = {};
    ordered.forEach(([name, win], i) => {
      win.style.zIndex = i + 1;
      saved[name] = {
        x: win.offsetLeft, y: win.offsetTop, w: Math.max(win.offsetWidth, MIN_W), h: Math.max(win.offsetHeight, MIN_H),
        z: i + 1, o: Number(win.querySelector("input").value),
      };
    });
    this.top = ordered.length;
    this.settings.set("floating", saved);
  }
}
