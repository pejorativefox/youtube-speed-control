/* global YTPCS_Storage, YTPCS_Widget */
(function () {
  const STORAGE = window.YTPCS_Storage;
  const Widget = window.YTPCS_Widget;

  let currentChannel = null; // { key, channelId, handle, name }
  let lastVideoSrc = "";
  let isApplyingRate = false;
  let lastAppliedSpeed = null;
  let channelPollTimer = null;
  let widgetMounted = false;
  let pendingApplySpeed = null; // target speed (percent) we still owe the video
  let pageChannelInfo = null; // channel info reported by the main-world bridge

  // Content-script-scoped speed cache so repeated lookups (and the 0-ms bridge
  // event) never wait on chrome.storage more than once per page lifetime.
  const channelSpeedCache = Object.create(null);

  // Fallback bucket used when the channel can't be identified; keeps playback
  // speed working instead of silently dropping the setting.
  const DEFAULT_KEY = "__default__";

  const SAVE_DEBOUNCE_MS = 400;
  let saveTimer = null;
  let savesInFlight = 0;

  function isWatchPage() {
    return location.pathname === "/watch" || location.pathname.startsWith("/watch");
  }
  function isShortsPage() {
    return location.pathname.startsWith("/shorts");
  }
  function isRelevantPage() {
    return isWatchPage() || isShortsPage();
  }

  function getVideoElement() {
    // Prefer the main watch player, then shorts, then any non-ad video.
    const vids = document.querySelectorAll(
      "video.html5-main-video, #shorts-player video, video.video-stream"
    );
    for (const v of vids) {
      if (v && v.closest && v.closest(".ad-showing")) continue;
      return v;
    }
    return document.querySelector("video");
  }

  function isAdShowing() {
    const player = document.getElementById("movie_player");
    if (player && player.classList.contains("ad-showing")) return true;
    // also check for ad overlay
    if (document.querySelector(".ad-showing, .ytp-ad-module")) {
      const p = document.getElementById("movie_player");
      if (p && p.classList.contains("ad-showing")) return true;
    }
    return false;
  }

  function extractChannelInfo() {
    // Returns { key, channelId, handle, name } or null
    // 0) Main-world bridge data (most reliable, available very early)
    if (pageChannelInfo) return pageChannelInfo;

    let channelId = null;
    let handle = null;
    let name = null;

    // 1) From ytInitialData / ytInitialPlayerResponse (only directly reachable
    //    in the page world; kept as a fallback when the bridge is unavailable)
    try {
      // ytInitialPlayerResponse is set on window
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails) {
        if (pr.videoDetails.channelId) channelId = pr.videoDetails.channelId;
        if (pr.videoDetails.author) name = pr.videoDetails.author;
      }
      if (pr && pr.microformat && pr.microformat.playerMicroformatRenderer) {
        const mf = pr.microformat.playerMicroformatRenderer;
        if (mf.ownerChannelName) name = mf.ownerChannelName;
        if (mf.ownerProfileUrl) {
          const m = mf.ownerProfileUrl.match(/\/channel\/(UC[^/?#]+)/);
          if (m) channelId = m[1];
          const hm = mf.ownerProfileUrl.match(/\/@([^/?#]+)/);
          if (hm) handle = "@" + hm[1];
        }
      }
    } catch (_) {}

    try {
      const data = window.ytInitialData;
      if (data) {
        // Search for channelId in various places
        const str = JSON.stringify(data).slice(0, 50000); // avoid huge stringify cost on full data
        // Use DOM instead for precision below
      }
    } catch (_) {}

    // 2) DOM: owner renderer
    const ownerLink = document.querySelector("ytd-video-owner-renderer a[href^=\"/@\"], ytd-video-owner-renderer a[href^=\"/channel/\"], #owner a[href^=\"/@\"], #owner a[href^=\"/channel/\"]");
    if (ownerLink) {
      const href = ownerLink.getAttribute("href") || "";
      if (href.startsWith("/@")) {
        handle = handle || href.split("?")[0].split("/")[1]; // includes @
        if (handle && !handle.startsWith("@")) handle = "@" + handle;
      } else if (href.includes("/channel/")) {
        const m = href.match(/\/channel\/(UC[^/?#&]+)/);
        if (m) channelId = channelId || m[1];
      }
    }

    // Name: the dedicated channel-name element is cleanest; the owner link's
    // text contains the name twice plus layout whitespace, so it's a fallback.
    if (!name) {
      const cn = document.querySelector("ytd-video-owner-renderer #channel-name #text, ytd-channel-name #text, #owner #channel-name");
      if (cn) name = STORAGE.cleanName(cn.textContent) || null;
    }
    if (!name && ownerLink) name = STORAGE.cleanName(ownerLink.textContent) || null;

    // Handle from any link with /@
    if (!handle) {
      const anyHandleLink = document.querySelector('a[href^="/@"]');
      if (anyHandleLink) {
        const h = anyHandleLink.getAttribute("href").split("?")[0].split("/")[1];
        if (h) handle = h.startsWith("@") ? h : "@" + h;
      }
    }

    // Meta itemprop channelId
    if (!channelId) {
      const meta = document.querySelector('meta[itemprop="channelId"]');
      if (meta) channelId = meta.getAttribute("content") || channelId;
      const chLink = document.querySelector('link[itemprop="url"][href*="/channel/"]');
      if (chLink) {
        const m = chLink.getAttribute("href").match(/\/channel\/(UC[^/?#]+)/);
        if (m) channelId = m[1];
      }
    }

    // Canonical link
    if (!channelId || !handle) {
      const canonical = document.querySelector('link[rel="canonical"]');
      if (canonical) {
        const href = canonical.getAttribute("href") || "";
        const cm = href.match(/\/channel\/(UC[^/?#]+)/);
        if (cm) channelId = channelId || cm[1];
      }
    }

    // Shorts: check shorts owner
    if ((!channelId && !handle) && isShortsPage()) {
      const shortsOwner = document.querySelector('ytd-reel-video-renderer a[href^="/@"]');
      if (shortsOwner) {
        const h = shortsOwner.getAttribute("href").split("?")[0].split("/")[1];
        if (h) handle = "@" + h.replace(/^@/, "");
      }
    }

    if (!channelId && !handle) return null;

    const key = channelId || handle;
    return { key, channelId: channelId || null, handle: handle || null, name: name || handle || channelId };
  }

  function getPlayerContainer() {
    // Try movie_player first (watch), then shorts
    let container = document.getElementById("movie_player");
    if (container) return container;
    container = document.querySelector(".html5-video-container");
    if (container) return container;
    container = document.getElementById("shorts-player");
    if (container) return container;
    const reel = document.querySelector("ytd-reel-video-renderer");
    if (reel) return reel;
    return document.body;
  }

  function ensureWidgetMounted() {
    if (!isRelevantPage()) {
      unmountWidget();
      return;
    }
    const container = getPlayerContainer();
    if (!container) return;

    const widgetEl = Widget.createWidget();
    const toastEl = Widget.getToastElement();

    // Ensure container is positioning context; YouTube already sets position relative on movie_player
    const style = window.getComputedStyle(container);
    if (style.position === "static") {
      container.style.position = "relative";
    }

    if (!widgetEl.parentElement || widgetEl.parentElement !== container) {
      container.appendChild(widgetEl);
      // Toast sibling
      if (toastEl && toastEl.parentElement !== container) {
        container.appendChild(toastEl);
      }
      widgetMounted = true;
    }
  }

  function unmountWidget() {
    const el = Widget.getElement();
    if (el && el.parentElement) el.remove();
    const toast = Widget.getToastElement();
    if (toast && toast.parentElement) toast.remove();
    widgetMounted = false;
  }

  function cacheSpeed(info, speed) {
    if (!info || speed === undefined || speed === null) return;
    if (info.channelId) channelSpeedCache[info.channelId] = speed;
    if (info.handle) channelSpeedCache[info.handle] = speed;
    if (info.key) channelSpeedCache[info.key] = speed;
  }

  function getCachedSpeed(info) {
    if (!info) return undefined;
    if (info.channelId && info.channelId in channelSpeedCache) return channelSpeedCache[info.channelId];
    if (info.handle && info.handle in channelSpeedCache) return channelSpeedCache[info.handle];
    if (info.key && info.key in channelSpeedCache) return channelSpeedCache[info.key];
    return undefined;
  }

  // Remembers the desired rate and applies it as soon as a video exists.
  // Returns true if a video element was available.
  function applySpeedToVideo(speed) {
    const pct = Math.min(400, Math.max(25, Math.round(speed)));
    const target = pct / 100;
    // Stored as a percentage — the same unit applySpeedToVideo() takes, since
    // it is fed straight back in by the listeners and watchdog.
    pendingApplySpeed = pct;

    const video = getVideoElement();
    if (!video || isAdShowing()) return false;

    if (Math.abs(video.playbackRate - target) >= 0.01) {
      isApplyingRate = true;
      video._ytpcsSetAt = Date.now();
      try {
        video.playbackRate = target;
        video.defaultPlaybackRate = target;
        lastAppliedSpeed = Math.round(target * 100);
      } finally {
        // Reset flag next tick to avoid catching our own ratechange
        setTimeout(() => { isApplyingRate = false; }, 100);
      }
    }

    // The pending intent is intentionally NOT cleared: YouTube resets the rate
    // on ads, autoplay and source swaps, and a persistent target lets the
    // watchdog re-assert it in all of those cases.
    return true;
  }

  async function resolveAndApplyForCurrentChannel() {
    if (!isRelevantPage()) return;

    const info = extractChannelInfo();
    if (!info) {
      // Retry a few times — YouTube loads late
      return null;
    }

    currentChannel = info;
    Widget.setChannel({ key: info.key, handle: info.handle, name: info.name, channelId: info.channelId });

    // Fast path: the in-page cache lets us set the rate in the same tick,
    // i.e. before the video starts playing.
    const cached = getCachedSpeed(info);
    if (cached !== undefined) {
      Widget.updateSpeedDisplay(cached);
      applySpeedToVideo(cached);
      return info;
    }

    // Resolve speed: try channelId first, then handle fallback
    let saved = null;
    if (info.channelId) {
      saved = await STORAGE.getChannelSpeed(info.channelId);
    }
    if (!saved && info.handle) {
      saved = await STORAGE.getChannelSpeed(info.handle);
    }
    // Also try generic key (in case stored under whichever was available)
    if (!saved && info.key) {
      saved = await STORAGE.getChannelSpeed(info.key);
    }
    // Last resort: the site-wide default for channels we can't fingerprint.
    if (!saved) {
      saved = await STORAGE.getChannelSpeed(DEFAULT_KEY);
    }

    const speed = saved ? saved.speed : 100;
    cacheSpeed(info, speed);
    Widget.updateSpeedDisplay(speed);
    applySpeedToVideo(speed);
    return info;
  }

  async function pollForChannel(maxAttempts = 12) {
    clearInterval(channelPollTimer);
    let attempts = 0;
    const tryOnce = async () => {
      attempts++;
      // Nudge the page-world bridge: keeps info fresh across Shorts scrolls too.
      requestPageChannelInfo();
      const found = await resolveAndApplyForCurrentChannel();
      if (found) {
        clearInterval(channelPollTimer);
        channelPollTimer = null;
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(channelPollTimer);
        channelPollTimer = null;
        // Still show widget at 100% even if channel unknown
        Widget.setChannel(null);
        Widget.updateSpeedDisplay(100);
      }
    };
    await tryOnce();
    if (attempts < maxAttempts) {
      channelPollTimer = setInterval(tryOnce, 500);
    }
  }

  function bindVideoListeners() {
    const video = getVideoElement();
    if (!video) return;
    if (video._ytpcsBound) {
      // Already bound for this element; just re-apply any owed rate.
      if (pendingApplySpeed !== null) applySpeedToVideo(pendingApplySpeed);
      return;
    }
    video._ytpcsBound = true;
    lastVideoSrc = video.currentSrc || video.src || "";

    // Re-apply at every point where YouTube could clobber the rate.
    const tryApply = () => {
      if (pendingApplySpeed === null) return;
      if (isAdShowing()) return;
      applySpeedToVideo(pendingApplySpeed);
    };

    video.addEventListener("loadedmetadata", tryApply);
    video.addEventListener("loadeddata", tryApply);
    video.addEventListener("canplay", tryApply);
    video.addEventListener("playing", tryApply);

    video.addEventListener("play", () => {
      // Late channel detection: if we still don't know the channel, ask now.
      if (!currentChannel && isRelevantPage()) pollForChannel(30);
      // YouTube can reset the rate on play (e.g. after an ad). Re-apply soon.
      setTimeout(tryApply, 30);
      setTimeout(tryApply, 250);
    });

    video.addEventListener("ratechange", () => {
      if (isApplyingRate) return;
      // Re-assert only when YouTube dropped us back to its default 1x (ad end,
      // autoplay, source swap). A deliberate pick via YouTube's own menu is
      // respected so we don't fight the user.
      if (Math.abs(video.playbackRate - 1) < 0.001) setTimeout(tryApply, 20);
    });

    // If we already know the target and a video is present, apply right now.
    if (pendingApplySpeed !== null) applySpeedToVideo(pendingApplySpeed);
  }

  function saveErrorMessage(e) {
    const msg = (e && e.message) || String(e);
    // Happens when the extension is reloaded/updated while this tab stays open.
    if (/context invalidated/i.test(msg)) return "Extension was updated — refresh the page to save";
    return `Failed to save: ${msg}`;
  }

  function handleWidgetChange(newSpeed, channel) {
    // channel is { key, handle, name } from widget, but we prefer currentChannel
    const chan = currentChannel || channel;
    applySpeedToVideo(newSpeed);
    // Keep the in-memory cache in step with the click, otherwise any
    // re-resolve before/after the storage write reverts to the stale value.
    if (chan && chan.key) cacheSpeed(chan, newSpeed);
    else channelSpeedCache[DEFAULT_KEY] = newSpeed;

    // Debounce the write: rapid clicks only save the final value, which keeps
    // us well inside chrome.storage.sync's write-rate limits.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistSpeed(newSpeed, chan);
    }, SAVE_DEBOUNCE_MS);
  }

  function persistSpeed(newSpeed, chan) {
    let key, meta, label;
    if (chan && chan.key) {
      key = chan.channelId || chan.key;
      meta = { handle: chan.handle || "", name: chan.name || "" };
      label = chan.handle || chan.name || chan.key;
    } else {
      // No channel detected yet — remember it site-wide so the speed still
      // applies on reload instead of being silently dropped.
      key = DEFAULT_KEY;
      meta = { handle: "", name: "All channels" };
      label = "all channels";
    }
    savesInFlight++;
    STORAGE.setChannelSpeed(key, { ...meta, speed: newSpeed })
      .then(() => Widget.showToast(`Saved ${newSpeed}% for ${label}`))
      .catch((e) => Widget.showToast(saveErrorMessage(e)))
      .finally(() => { savesInFlight--; });
  }

  function onNavigation() {
    // Reset state
    lastVideoSrc = "";
    currentChannel = null;
    pendingApplySpeed = null;
    lastAppliedSpeed = null;
    pageChannelInfo = null;
    requestPageChannelInfo();
    Widget.updateSpeedDisplay(100);
    Widget.setChannel(null);
    ensureWidgetMounted();
    bindVideoListeners();
    if (isRelevantPage()) {
      // Poll until the channel is known (up to ~15s) so a slow page load can't
      // leave the speed unapplied.
      pollForChannel(30);
      setTimeout(bindVideoListeners, 300);
      setTimeout(bindVideoListeners, 1000);
      setTimeout(() => {
        ensureWidgetMounted();
        if (!currentChannel) pollForChannel(12);
      }, 1500);
    } else {
      clearInterval(channelPollTimer);
    }
  }

  function setupObservers() {
    // Listen YouTube SPA events
    window.addEventListener("yt-navigate-finish", onNavigation);
    window.addEventListener("popstate", () => setTimeout(onNavigation, 300));

    // MutationObserver for video element changes and player container
    const observer = new MutationObserver(() => {
      ensureWidgetMounted();
      bindVideoListeners();
      // If channel was null and now DOM populated, retry
      if (!currentChannel && isRelevantPage()) {
        // debounce
        clearTimeout(window._ytpcsDebounce);
        window._ytpcsDebounce = setTimeout(() => {
          if (!currentChannel) pollForChannel(3);
        }, 800);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Poll video element for src changes (YouTube reuses the video tag) and
    // re-assert any rate YouTube reset behind our back.
    setInterval(() => {
      if (!isRelevantPage()) return;
      const v = getVideoElement();
      if (!v) return;
      const src = v.currentSrc || v.src || "";
      if (src !== lastVideoSrc) bindVideoListeners();
      if (pendingApplySpeed !== null && !isAdShowing() && !isApplyingRate) {
        const resetToDefault =
          Math.abs(v.playbackRate - 1) < 0.001 && pendingApplySpeed !== 100;
        if (resetToDefault) applySpeedToVideo(pendingApplySpeed);
      }
    }, 1000);
  }

  // --- Main-world bridge ---------------------------------------------------
  // Content scripts run in an isolated world and cannot see YouTube's page
  // globals (ytInitialPlayerResponse), so channel detection used to depend on
  // the DOM rendering. This function is stringified and injected into the page
  // world; it reports the current channel back over postMessage.
  function pageBridgeFn() {
    function post() {
      var info = null;
      try {
        var pr = window.ytInitialPlayerResponse;
        if (pr && pr.videoDetails) {
          info = {
            channelId: pr.videoDetails.channelId || null,
            name: pr.videoDetails.author || null,
            handle: null,
          };
          var mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
          if (mf && mf.ownerProfileUrl) {
            var hm = mf.ownerProfileUrl.match(/\/@([^/?#]+)/);
            if (hm) info.handle = "@" + hm[1];
            var cm = mf.ownerProfileUrl.match(/\/channel\/(UC[^/?#]+)/);
            if (cm && !info.channelId) info.channelId = cm[1];
          }
        }
      } catch (e) { info = null; }
      try {
        window.postMessage({ source: "ytpcs", type: "channel", info: info }, "*");
      } catch (e) {}
    }
    post();
    window.addEventListener("yt-navigate-finish", post, true);
    window.addEventListener("yt-page-data-updated", post, true);
    window.addEventListener("yt-player-updated", post, true);
    // Content script asks us to refresh (e.g. new Shorts reel scrolled in).
    window.addEventListener("message", function (e) {
      if (e.source !== window) return;
      if (e.data && e.data.source === "ytpcs" && e.data.type === "request") post();
    }, true);
    // The player response is often injected after our first look; poll shortly.
    var n = 0;
    var t = setInterval(function () {
      n++;
      post();
      if (n > 24) clearInterval(t);
    }, 250);
  }

  function requestPageChannelInfo() {
    try {
      window.postMessage({ source: "ytpcs", type: "request" }, "*");
    } catch (_) {}
  }

  function installPageBridge() {
    try {
      const script = document.createElement("script");
      script.textContent = "(" + pageBridgeFn.toString() + ")();";
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (_) {
      // CSP may block injection; DOM-based detection still works.
    }

    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.source !== "ytpcs" || d.type !== "channel") return;
      const info = d.info;
      if (!info || (!info.channelId && !info.handle)) return;
      pageChannelInfo = {
        key: info.channelId || info.handle,
        channelId: info.channelId || null,
        handle: info.handle || null,
        name: info.name || info.handle || info.channelId,
      };
      if (!isRelevantPage()) return;
      if (currentChannel && currentChannel.key === pageChannelInfo.key) return;
      resolveAndApplyForCurrentChannel();
    });
  }

  function init() {
    Widget.createWidget();
    Widget.onChange(handleWidgetChange);
    ensureWidgetMounted();
    setupObservers();
    installPageBridge();

    // Warm the in-memory cache once so SPA channel switches can apply a saved
    // speed synchronously instead of waiting on chrome.storage again.
    STORAGE.getAllSpeeds().then((all) => {
      for (const [k, v] of Object.entries(all || {})) {
        if (v && typeof v.speed === "number") channelSpeedCache[k] = v.speed;
      }
      if (currentChannel) resolveAndApplyForCurrentChannel();
    }).catch(() => {});

    onNavigation();

    // Listen for saves/imports from the popup or other tabs.
    STORAGE.storageAddChangedListener((changes) => {
      if (!changes || !Object.keys(changes).some((k) => k.startsWith(STORAGE.ITEM_PREFIX))) return;
      // Our own pending/in-flight save already updated the cache; re-reading
      // mid-write could briefly revert to the previous value.
      if (saveTimer || savesInFlight) return;
      // Saved elsewhere (popup, another tab, another device): reload the
      // merged sync+local view and re-apply for the current channel.
      STORAGE.getAllSpeeds().then((all) => {
        for (const k of Object.keys(channelSpeedCache)) delete channelSpeedCache[k];
        for (const [k, v] of Object.entries(all || {})) channelSpeedCache[k] = v.speed;
        resolveAndApplyForCurrentChannel();
      }).catch(() => {});
    });
  }

  // Run as early as possible — at document_start the video element does not
  // exist yet, but the bridge/observers are installed immediately so the saved
  // speed is applied the moment playback begins.
  init();
})();
