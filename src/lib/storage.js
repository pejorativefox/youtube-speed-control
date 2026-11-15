/* global chrome */
// Shared storage helper — loaded before content.js and popup.js (no modules needed, MV3 compatible)

const STORAGE_KEY = "channelSpeeds"; // legacy single-map key, migrated on first read
const MIN_SPEED = 25;
const MAX_SPEED = 400;

function clampSpeed(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  if (n < MIN_SPEED || n > MAX_SPEED) return null;
  return n;
}

// Normalise a channel display name scraped from the DOM: collapse whitespace
// and undo YouTube's habit of rendering the name twice ("Foo   Foo" -> "Foo").
function cleanName(v) {
  if (typeof v !== "string") return "";
  let s = v.replace(/\s+/g, " ").trim();
  const words = s.split(" ");
  if (words.length % 2 === 0) {
    const half = words.length / 2;
    const a = words.slice(0, half).join(" ");
    if (a === words.slice(half).join(" ")) s = a;
  }
  return s;
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
      // Drop any local fallback copy so reads don't prefer stale data.
      if (local) { try { await local.remove(Object.keys(obj)); } catch (_) {} }
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

// --- Per-channel layout -----------------------------------------------------
// Each channel is its own item ("cs:<channelKey>") so the list isn't capped by
// chrome.storage.sync's 8KB-per-item limit (sync allows ~100KB / 512 items in
// total). Items normally live in sync; an item lands in local only when sync
// rejected that write (quota, rate limit, sync off), and reads merge both by
// updatedAt so nothing is lost either way.
const ITEM_PREFIX = "cs:";

function itemKey(channelKey) {
  return ITEM_PREFIX + channelKey;
}

function sanitizeEntry(v) {
  if (!v || typeof v !== "object") return null;
  const speed = clampSpeed(v.speed);
  if (speed === null) return null;
  return {
    handle: typeof v.handle === "string" ? v.handle : "",
    name: cleanName(v.name),
    speed,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : 0,
  };
}

async function areaGetAll(area) {
  if (!area) return {};
  try { return (await area.get(null)) || {}; } catch (_) { return {}; }
}

// Write items to sync, falling back to local if sync rejects them. A
// successful sync write clears any local fallback copy of the same items.
async function writeItems(items) {
  const keys = Object.keys(items);
  if (!keys.length) return;
  const sync = storageAreaSync();
  const local = storageAreaLocal();
  if (sync) {
    try {
      await sync.set(items);
      if (local) { try { await local.remove(keys); } catch (_) {} }
      return;
    } catch (e) {
      if (!local) throw e;
    }
  }
  if (local) await local.set(items);
}

// One-time move from the old single-map layout ({ channelSpeeds: {...} }).
let migrationPromise = null;
function migrateLegacy() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const sync = storageAreaSync();
    const local = storageAreaLocal();
    const legacy = {};
    for (const area of [sync, local]) {
      if (!area) continue;
      let raw;
      try { raw = (await area.get(STORAGE_KEY))[STORAGE_KEY]; } catch (_) { continue; }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      for (const [k, v] of Object.entries(raw)) {
        const e = sanitizeEntry(v);
        if (e && (!legacy[k] || e.updatedAt >= legacy[k].updatedAt)) legacy[k] = e;
      }
    }
    const legacyKeys = Object.keys(legacy);
    if (legacyKeys.length) {
      // Don't clobber a per-channel item that is already newer.
      const current = await readItems();
      const items = {};
      for (const k of legacyKeys) {
        if (!current[k] || legacy[k].updatedAt > current[k].updatedAt) items[itemKey(k)] = legacy[k];
      }
      await writeItems(items);
    }
    await storageRemove([STORAGE_KEY]);
  })().catch(() => { migrationPromise = null; });
  return migrationPromise;
}

async function readItems() {
  const [fromSync, fromLocal] = await Promise.all([
    areaGetAll(storageAreaSync()),
    areaGetAll(storageAreaLocal()),
  ]);
  const out = {};
  for (const src of [fromSync, fromLocal]) {
    for (const [k, v] of Object.entries(src)) {
      if (!k.startsWith(ITEM_PREFIX)) continue;
      const e = sanitizeEntry(v);
      if (!e) continue;
      const ck = k.slice(ITEM_PREFIX.length);
      if (!out[ck] || e.updatedAt >= out[ck].updatedAt) out[ck] = e;
    }
  }
  return out;
}

async function getAllSpeeds() {
  await migrateLegacy();
  return readItems();
}

async function setChannelSpeed(channelKey, { handle, name, speed }) {
  const clamped = clampSpeed(speed);
  if (clamped === null) throw new Error(`Invalid speed ${speed}, must be ${MIN_SPEED}-${MAX_SPEED}`);
  if (!channelKey || typeof channelKey !== "string") throw new Error("Invalid channelKey");
  await migrateLegacy();
  const entry = {
    handle: handle || "",
    name: cleanName(name),
    speed: clamped,
    updatedAt: Date.now(),
  };
  await writeItems({ [itemKey(channelKey)]: entry });
  return entry;
}

async function getChannelSpeed(channelKey) {
  if (!channelKey) return null;
  const all = await getAllSpeeds();
  return all[channelKey] || null;
}

async function removeChannelSpeed(channelKey) {
  const all = await getAllSpeeds();
  if (!(channelKey in all)) return false;
  await storageRemove([itemKey(channelKey)]);
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
  await migrateLegacy();
  if (mode === "replace") {
    const existing = await readItems();
    const drop = Object.keys(existing).filter((k) => !(k in sanitized)).map(itemKey);
    if (drop.length) await storageRemove(drop);
  }
  const items = {};
  for (const [k, v] of Object.entries(sanitized)) items[itemKey(k)] = v;
  await writeItems(items);
  return readItems();
}

async function exportSpeeds() {
  const all = await getAllSpeeds();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    channelSpeeds: all,
  };
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
    clampSpeed, cleanName, getAllSpeeds, getChannelSpeed, setChannelSpeed, removeChannelSpeed,
    validateImportedData, importSpeeds, exportSpeeds, storageGet, storageSet,
    ITEM_PREFIX, storageAddChangedListener
  };
}
// Also for service worker / popup if using modules via global
if (typeof globalThis !== "undefined") {
  globalThis.YTPCS_Storage = globalThis.YTPCS_Storage || (typeof window !== "undefined" ? window.YTPCS_Storage : null);
  if (!globalThis.YTPCS_Storage) {
    globalThis.YTPCS_Storage = {
      STORAGE_KEY, MIN_SPEED, MAX_SPEED,
      clampSpeed, cleanName, getAllSpeeds, getChannelSpeed, setChannelSpeed, removeChannelSpeed,
      validateImportedData, importSpeeds, exportSpeeds, storageGet, storageSet,
      ITEM_PREFIX, storageAddChangedListener
    };
  }
}
