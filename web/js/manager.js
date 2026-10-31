// The "Races" panel: choose which races to export, watch the progress, and manage the download
// cache. It talks to the small API of serve.py (see /api/ there). The page itself does not export
// anything: serve.py starts python/export_race.py in the background, so you can even close the
// page and the export goes on.

// "Safe" request helper: POST requests carry a custom header that serve.py requires, which
// stops other websites from sending requests to your local server.
async function api(path, body) {
  const options = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Pitwall": "1" },
    body: JSON.stringify(body),
  };
  const response = await fetch(`/api/${path}`, options);
  let data;
  try {
    data = await response.json();
  } catch (err) {
    // A plain `python -m http.server` answers /api/ with an HTML error page, not JSON.
    throw new Error("The server has no API. Start it with: py serve.py");
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "unknown";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

// Small helper: <tag class="...">text</tag> without writing innerHTML by hand (names come from
// the network, so we never put them into HTML as text to be parsed).
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setupManager({ onRacesChanged }) {
  const panel = document.getElementById("manager");
  const thisYear = new Date().getFullYear();
  let year = thisYear;
  let calendar = [];                  // races of `year` (from the server), or [] while loading
  let calendarError = null;
  let selected = new Set();           // round numbers ticked in the list
  let keepCache = true;
  let serverState = { jobs: [], races: [], cacheTotal: 0 };
  let message = "";                   // result of the last action ("Freed 210 MB")
  let timer = null;

  // The panel is built once, from three parts that are redrawn separately: redrawing a part
  // that has inputs (the list with the tick boxes) on every poll would reset what you are doing.
  panel.querySelector("#managerBody").replaceChildren(
    el("div", null), el("div", null), el("div", null), el("p", "hintText"));
  const [pickBox, jobsBox, exportedBox, messageBox] = panel.querySelector("#managerBody").children;

  async function refreshState() {
    const before = serverState.jobs;
    serverState = await api("state");
    drawJobs();
    drawExported();
    // A job that just finished: the race list of the page and the "Exported" marks changed.
    const finished = serverState.jobs.some((j) => j.state === "done" &&
      before.some((b) => b.id === j.id && b.state !== "done"));
    if (finished) {
      await loadCalendar();
      onRacesChanged();
    }
  }

  async function loadCalendar() {
    try {
      calendar = await api(`calendar?year=${year}`);
      calendarError = null;
    } catch (err) {
      calendar = [];
      calendarError = err.message;
    }
    drawPick();
  }

  // ---- part 1: pick races ----
  function drawPick() {
    pickBox.replaceChildren();
    pickBox.appendChild(el("h3", null, "Download races"));

    const row = el("div", "row");
    const label = el("label", null, "Season");
    const select = document.createElement("select");
    for (let y = thisYear; y >= 2023; y--) select.add(new Option(y, y));
    select.value = year;
    select.onchange = () => { year = Number(select.value); selected.clear(); calendar = []; drawPick(); loadCalendar(); };
    row.append(label, select);
    pickBox.appendChild(row);

    if (calendarError) {
      pickBox.appendChild(el("p", "error", calendarError));
      return;
    }
    if (calendar.length === 0) {
      pickBox.appendChild(el("p", "hintText", "Loading the calendar..."));
      return;
    }

    const list = el("div", "raceList");
    for (const race of calendar) {
      const queued = serverState.jobs.some((j) => j.folder === race.folder && (j.state === "queued" || j.state === "running"));
      const item = el("label", "raceItem");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.disabled = !race.finished || queued;
      box.checked = selected.has(race.round);
      box.onchange = () => {
        if (box.checked) selected.add(race.round); else selected.delete(race.round);
        exportButton.disabled = selected.size === 0;
        exportButton.textContent = `Export selected (${selected.size})`;
      };
      const name = el("span", "raceName", `${race.round}. ${race.name}`);
      const date = el("span", "raceDate", race.date);
      let badgeText = "";
      if (queued) badgeText = "exporting";
      else if (!race.finished) badgeText = "not run yet";
      else if (race.exported) badgeText = "exported";
      item.append(box, name, date, el("span", `badge ${badgeText.replace(" ", "-")}`, badgeText));
      list.appendChild(item);
    }
    pickBox.appendChild(list);

    const keepRow = el("label", "keepRow");
    const keepBox = document.createElement("input");
    keepBox.type = "checkbox";
    keepBox.checked = keepCache;
    keepBox.onchange = () => { keepCache = keepBox.checked; };
    keepRow.append(keepBox, document.createTextNode(" Keep the downloaded data in the cache"));
    pickBox.appendChild(keepRow);
    pickBox.appendChild(el("p", "hintText",
      "A race downloads about 200 MB and takes a few minutes. With the cache kept, exporting it again " +
      "takes seconds; without it the disk space is freed right after the export. Already exported races " +
      "are exported again if you tick them."));

    const exportButton = el("button", "primary", `Export selected (${selected.size})`);
    exportButton.disabled = selected.size === 0;
    exportButton.onclick = async () => {
      exportButton.disabled = true;
      try {
        for (const round of [...selected].sort((a, b) => a - b)) {
          await api("export", { year, round, keepCache });
        }
        selected.clear();
        message = "";
      } catch (err) {
        message = err.message;
      }
      await refreshState();
      drawPick();
      drawMessage();
      schedulePolling();
    };
    pickBox.appendChild(exportButton);
  }

  // ---- part 2: exports in progress ----
  function drawJobs() {
    jobsBox.replaceChildren();
    if (serverState.jobs.length === 0) return;

    const head = el("h3", null, "Exports");
    const clear = el("button", "small", "Clear finished");
    clear.onclick = async () => { await api("clear-finished", {}); await refreshState(); };
    head.appendChild(clear);
    jobsBox.appendChild(head);

    for (const job of serverState.jobs) {
      const item = el("div", `job ${job.state}`);
      const top = el("div", "jobTop");
      top.appendChild(el("b", null, `${job.year} ${job.name}`));
      const status = { queued: "waiting", running: `${Math.round(job.fraction * 100)}%`, done: "done",
                       error: "failed", cancelled: "cancelled" }[job.state];
      top.appendChild(el("span", "jobStatus", status));
      if (job.state === "queued" || job.state === "running") {
        const cancel = el("button", "small", "Cancel");
        cancel.onclick = async () => { await api("cancel", { id: job.id }); await refreshState(); };
        top.appendChild(cancel);
      }
      item.appendChild(top);

      if (job.state === "running") {
        const bar = el("div", "bar");
        const fill = el("div", "barFill");
        fill.style.width = `${Math.round(job.fraction * 100)}%`;
        bar.appendChild(fill);
        item.appendChild(bar);
        const seconds = Math.round(Date.now() / 1000 - job.started);
        item.appendChild(el("div", "hintText", `${job.message} - ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`));
      } else if (job.state === "error") {
        item.appendChild(el("pre", "error", job.error));
      } else if (job.state === "done") {
        item.appendChild(el("div", "hintText", job.keepCache ? "Cache kept." : "Cache deleted."));
      }
      jobsBox.appendChild(item);
    }
  }

  // ---- part 3: exported races and their cache ----
  function drawExported() {
    exportedBox.replaceChildren();
    exportedBox.appendChild(el("h3", null, "Exported races and cache"));
    if (serverState.races.length === 0) {
      exportedBox.appendChild(el("p", "hintText", "No race exported yet."));
    }
    for (const race of serverState.races) {
      const item = el("div", "exportedItem");
      item.appendChild(el("span", "raceName", `${race.year} ${race.name}`));
      item.appendChild(el("span", "size", `data ${formatBytes(race.dataBytes)}`));
      item.appendChild(el("span", "size", `cache ${race.cacheBytes === null ? "not tracked" : formatBytes(race.cacheBytes)}`));
      const del = el("button", "small", "Delete cache");
      del.disabled = !race.cacheBytes;                // nothing to delete, or not known which files are its
      del.title = race.cacheBytes === null ? "Export this race again to track its cache files" : "";
      del.onclick = async () => {
        try {
          const result = await api("delete-cache", { folder: race.folder });
          message = `Freed ${formatBytes(result.freed)}.`;
        } catch (err) {
          message = err.message;
        }
        drawMessage();
        await refreshState();
      };
      item.appendChild(del);
      exportedBox.appendChild(item);
    }

    const total = el("div", "exportedItem total");
    total.appendChild(el("span", "raceName", "Whole cache folder"));
    total.appendChild(el("span", "size", formatBytes(serverState.cacheTotal)));
    const all = el("button", "small", "Delete all cache");
    all.disabled = serverState.cacheTotal === 0;
    all.onclick = async () => {
      if (!confirm("Delete ALL downloaded data? The exported races stay, but exporting a race again will download it again.")) return;
      try {
        const result = await api("delete-cache", { all: true });
        message = `Freed ${formatBytes(result.freed)}.`;
      } catch (err) {
        message = err.message;
      }
      drawMessage();
      await refreshState();
    };
    total.appendChild(all);
    exportedBox.appendChild(total);
  }

  function drawMessage() {
    messageBox.textContent = message;
  }

  // While the panel is open we ask the server for the state every 2 seconds.
  function schedulePolling() {
    clearTimeout(timer);
    if (panel.hidden) return;
    timer = setTimeout(async () => {
      try { await refreshState(); } catch (err) { /* the server is gone: try again next time */ }
      schedulePolling();
    }, 2000);
  }

  async function open() {
    panel.hidden = false;
    drawPick();
    try {
      await refreshState();
    } catch (err) {
      calendarError = err.message;
      drawPick();
      return;
    }
    await loadCalendar();
    schedulePolling();
  }

  function toggle() {
    if (panel.hidden) {
      document.getElementById("settings").hidden = true;
      open();
    } else {
      panel.hidden = true;
    }
  }
  document.getElementById("racesBtn").onclick = toggle;
  document.getElementById("managerClose").onclick = () => { panel.hidden = true; };
  // Opening the settings closes this panel (they sit in the same corner).
  document.getElementById("settingsBtn").addEventListener("click", () => { panel.hidden = true; });
  return { open };
}
