/* global YTPCS_Storage */
(function () {
  const STORAGE = window.YTPCS_Storage;
  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const searchEl = document.getElementById("search");
  const countEl = document.getElementById("count");
  const exportBtn = document.getElementById("exportBtn");
  const importFile = document.getElementById("importFile");
  const statusEl = document.getElementById("status");

  let allSpeeds = {};

  function showStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.className = "status " + (isError ? "err" : "ok");
    setTimeout(() => { statusEl.textContent = ""; statusEl.className = "status"; }, 3000);
  }

  function render() {
    const filter = (searchEl.value || "").toLowerCase().trim();
    const entries = Object.entries(allSpeeds).sort((a, b) => {
      const an = (a[1].name || a[1].handle || a[0]).toLowerCase();
      const bn = (b[1].name || b[1].handle || b[0]).toLowerCase();
      return an.localeCompare(bn);
    });

    const filtered = filter
      ? entries.filter(([k, v]) => {
          const hay = `${k} ${v.handle || ""} ${v.name || ""}`.toLowerCase();
          return hay.includes(filter);
        })
      : entries;

    listEl.innerHTML = "";
    countEl.textContent = filtered.length + " / " + entries.length;

    if (entries.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    if (filtered.length === 0) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = "No matches.";
      listEl.appendChild(d);
      return;
    }

    for (const [key, info] of filtered) {
      const row = document.createElement("div");
      row.className = "row";

      const main = document.createElement("div");
      main.className = "row-main";
      const title = document.createElement("div");
      title.className = "row-title";
      title.textContent = info.name || info.handle || key;
      title.title = info.name || "";
      const handle = document.createElement("div");
      handle.className = "row-handle";
      handle.textContent = info.handle || "";
      const keyEl = document.createElement("div");
      keyEl.className = "row-key";
      keyEl.textContent = key;
      main.appendChild(title);
      if (info.handle) main.appendChild(handle);
      main.appendChild(keyEl);

      const controls = document.createElement("div");
      controls.className = "row-controls";

      const minus = document.createElement("button");
      minus.className = "btn-small";
      minus.textContent = "−";
      minus.title = "-10% (Shift -5%)";
      minus.addEventListener("click", (e) => updateSpeed(key, info.speed - (e.shiftKey ? 5 : 10)));

      const label = document.createElement("span");
      label.className = "speed-label";
      label.textContent = info.speed + "%";

      const plus = document.createElement("button");
      plus.className = "btn-small";
      plus.textContent = "+";
      plus.title = "+10% (Shift +5%)";
      plus.addEventListener("click", (e) => updateSpeed(key, info.speed + (e.shiftKey ? 5 : 10)));

      const del = document.createElement("button");
      del.className = "delete-btn";
      del.textContent = "×";
      del.title = "Remove";
      del.addEventListener("click", () => deleteChannel(key));

      if (info.speed <= STORAGE.MIN_SPEED) minus.disabled = true;
      if (info.speed >= STORAGE.MAX_SPEED) plus.disabled = true;

      controls.appendChild(minus);
      controls.appendChild(label);
      controls.appendChild(plus);
      controls.appendChild(del);

      row.appendChild(main);
      row.appendChild(controls);
      listEl.appendChild(row);
    }
  }

  async function load() {
    allSpeeds = await STORAGE.getAllSpeeds();
    render();
  }

  async function updateSpeed(key, newSpeed) {
    const clamped = Math.min(STORAGE.MAX_SPEED, Math.max(STORAGE.MIN_SPEED, Math.round(newSpeed)));
    const info = allSpeeds[key];
    if (!info) return;
    await STORAGE.setChannelSpeed(key, { handle: info.handle, name: info.name, speed: clamped });
    allSpeeds[key].speed = clamped;
    allSpeeds[key].updatedAt = Date.now();
    render();
  }

  async function deleteChannel(key) {
    await STORAGE.removeChannelSpeed(key);
    delete allSpeeds[key];
    render();
    showStatus("Removed " + key);
  }

  exportBtn.addEventListener("click", async () => {
    const data = await STORAGE.exportSpeeds();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `youtube-channel-speeds-${date}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("Exported " + Object.keys(data.channelSpeeds).length + " channels");
  });

  importFile.addEventListener("change", async () => {
    const file = importFile.files[0];
    if (!file) return;
    const mode = document.querySelector('input[name="mode"]:checked')?.value || "merge";
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = await STORAGE.importSpeeds(json, mode);
      allSpeeds = await STORAGE.getAllSpeeds();
      render();
      showStatus(`Imported ${Object.keys(json.channelSpeeds || json).length} entries (${mode})`);
    } catch (e) {
      showStatus("Import failed: " + e.message, true);
    } finally {
      importFile.value = "";
    }
  });

  searchEl.addEventListener("input", render);

  // React to external changes
  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(() => load());
  }

  load();
})();
