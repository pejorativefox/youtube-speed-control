/* global chrome */
// Shared storage helper — loaded before content.js and popup.js (no modules needed, MV3 compatible)

const STORAGE_KEY = "channelSpeeds";
const MIN_SPEED = 25;
const MAX_SPEED = 400;

function clampSpeed(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  if (n < MIN_SPEED || n > MAX_SPEED) return null;
  return n;
}

function storageAreaSync() {
  try {
    if (chrome && chrome.storage && chrome.storage.sync) return chrome.storage.sync;
  } catch (_) {}
  return null;
}

function storageAreaLocal() {
  try {
    if (chrome && chrome.storage && chrome.storage.local) return chrome.storage.local;
  } catch (_) {}
  return null;
}

// Try sync first, fall back to local on error (quota exceeded, sync disabled, etc.)
async function storageGet(keys) {
  const sync = storageAreaSync();
  const local = storageAreaLocal();
  if (!sync && !local) return {};

  if (sync) {
    try {
      const result = await sync.get(keys);
      // Check lastError via promise rejection not needed; sync.get resolves even if empty
      // But if sync is disabled it may still resolve empty — treat as valid
      return result;
    } catch (e) {
      // fall through to local
      if (local) {
        try { return await local.get(keys); } catch (_) { return {}; }
      }
      return {};
    }
  }
  try { return await local.get(keys); } catch (_) { return {}; }
}

async function storageSet(obj) {
  const sync = storageAreaSync();
  const local = storageAreaLocal();
  if (sync) {
    try {
      await sync.set(obj);
      return;
    } catch (e) {
      // QuotaExceeded or sync disabled -> fallback to local
      if (local) {
        try { await local.set(obj); return; } catch (_) {}
      }
      throw e;
    }
  }
  if (local) await local.set(obj);
}

async function storageRemove(keys) {
  const sync = storageAreaSync();
  const local = storageAreaLocal();
  // Remove from both to avoid stale data
  const promises = [];
  if (sync) promises.push(sync.remove(keys).catch(() => {}));
  if (local) promises.push(local.remove(keys).catch(() => {}));
  await Promise.all(promises);
}

// Internal: always store under single key STORAGE_KEY
async function getAllSpeeds() {
  const data = await storageGet({ [STORAGE_KEY]: {} });
  const raw = data[STORAGE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // sanitize: drop invalid entries
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const speed = clampSpeed(v.speed);
    if (speed === null) continue;
    out[k] = {
      handle: typeof v.handle === "string" ? v.handle : "",
      name: typeof v.name === "string" ? v.name : "",
      speed,
      updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : Date.now(),
    };
  }
  return out;
}

async function setChannelSpeed(channelKey, { handle, name, speed }) {
  const clamped = clampSpeed(speed);
  if (clamped === null) throw new Error(`Invalid speed ${speed}, must be ${MIN_SPEED}-${MAX_SPEED}`);
  if (!channelKey || typeof channelKey !== "string") throw new Error("Invalid channelKey");
  const all = await getAllSpeeds();
  all[channelKey] = {
    handle: handle || "",
    name: name || "",
    speed: clamped,
    updatedAt: Date.now(),
  };
  await storageSet({ [STORAGE_KEY]: all });
  return all[channelKey];
}

async function getChannelSpeed(channelKey) {
  if (!channelKey) return null;
  const all = await getAllSpeeds();
  return all[channelKey] || null;
}

async function removeChannelSpeed(channelKey) {
  const all = await getAllSpeeds();
  if (!(channelKey in all)) return false;
  delete all[channelKey];
  await storageSet({ [STORAGE_KEY]: all });
  return true;
}

function validateImportedData(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Invalid JSON: expected object");
  }
  // Support two formats:
  // 1) New: { version, channelSpeeds: { "UC...": { handle, name, speed } } }
  // 2) Legacy flat: { "@handle": 130, "UC...": 110 } or { "@handle": { speed: 130 } }
  let channelSpeeds = null;
  if (json.channelSpeeds && typeof json.channelSpeeds === "object" && !Array.isArray(json.channelSpeeds)) {
    channelSpeeds = json.channelSpeeds;
  } else {
    // Heuristic: if keys look like channels and values are numbers/objects, treat top-level as map
    const maybeFlat = Object.keys(json).some(k => k.startsWith("UC") || k.startsWith("@") || k.startsWith("channelSpeeds") === false);
    // If it has version but no channelSpeeds, error
    if ("version" in json && !json.channelSpeeds) throw new Error("Missing channelSpeeds field");
    // Assume flat if no channelSpeeds wrapper and values are plausible
    const flatKeys = Object.keys(json).filter(k => k !== "version" && k !== "exportedAt");
    if (flatKeys.length > 0) {
      const looksFlat = flatKeys.every(k => {
        const v = json[k];
        return typeof v === "number" || (v && typeof v === "object" && "speed" in v);
      });
      if (looksFlat) {
        channelSpeeds = {};
        for (const k of flatKeys) {
          const v = json[k];
          if (typeof v === "number") channelSpeeds[k] = { handle: k.startsWith("@") ? k : "", name: "", speed: v };
          else channelSpeeds[k] = v;
        }
      }
    }
  }
  if (!channelSpeeds) throw new Error("Missing channelSpeeds field");
  const sanitized = {};
  for (const [k, v] of Object.entries(channelSpeeds)) {
    if (!k || typeof k !== "string") continue;
    if (!v || typeof v !== "object") continue;
    // Allow number shorthand
    let entry = v;
    if (typeof v === "number") entry = { speed: v };
    const speed = clampSpeed(entry.speed);
    if (speed === null) throw new Error(`Invalid speed for ${k}: ${entry.speed}`);
    sanitized[k] = {
      handle: typeof entry.handle === "string" ? entry.handle : (k.startsWith("@") ? k : ""),
      name: typeof entry.name === "string" ? entry.name : "",
      speed,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    };
  }
  return sanitized;
}

async function importSpeeds(json, mode = "merge") {
  const sanitized = validateImportedData(json);
  if (mode === "replace") {
    await storageSet({ [STORAGE_KEY]: sanitized });
    return sanitized;
  }
  // merge
  const existing = await getAllSpeeds();
  const merged = { ...existing, ...sanitized };
  // preserve updatedAt from import if newer? just overwrite imported keys
  await storageSet({ [STORAGE_KEY]: merged });
  return merged;
}

async function exportSpeeds() {
  const all = await getAllSpeeds();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    channelSpeeds: all,
  };
}

// Best-effort synchronous read of the whole speed map, used to apply a saved
// speed immediately on page load (before the async storage read resolves).
// chrome.storage exposes the sync values synchronously; when the SW is asleep
// this returns null and the caller falls back to the async read.
function storageGetSync(key) {
  try {
    const getter = (chrome.storage.sync && chrome.storage.sync.get) ||
      (chrome.storage.local && chrome.storage.local.get);
    if (!getter) return null;
    const res = getter({ [key]: null });
    if (res && typeof res.then === "function") {
      // Chrome returns a promise for the async API; not usable synchronously.
      res.catch(() => {});
      return null;
    }
    if (res && typeof res === "object" && key in res) return res[key];
  } catch (_) {}
  return null;
}

// Notify callers whenever the stored speed map changes (save in another tab,
// import from popup, sync from another device).
function storageAddChangedListener(fn) {
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(fn);
    }
  } catch (_) {}
}

// Expose globally for non-module content scripts
if (typeof window !== "undefined") {
  window.YTPCS_Storage = {
    STORAGE_KEY, MIN_SPEED, MAX_SPEED,
    clampSpeed, getAllSpeeds, getChannelSpeed, setChannelSpeed, removeChannelSpeed,
    validateImportedData, importSpeeds, exportSpeeds, storageGet, storageSet,
    storageGetSync, storageAddChangedListener
  };
}
// Also for service worker / popup if using modules via global
if (typeof globalThis !== "undefined") {
  globalThis.YTPCS_Storage = globalThis.YTPCS_Storage || (typeof window !== "undefined" ? window.YTPCS_Storage : null);
  if (!globalThis.YTPCS_Storage) {
    globalThis.YTPCS_Storage = {
      STORAGE_KEY, MIN_SPEED, MAX_SPEED,
      clampSpeed, getAllSpeeds, getChannelSpeed, setChannelSpeed, removeChannelSpeed,
      validateImportedData, importSpeeds, exportSpeeds, storageGet, storageSet,
      storageGetSync, storageAddChangedListener
    };
  }
}
