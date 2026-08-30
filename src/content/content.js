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
    // Prefer main video, ignore ad videos handled separately
    const vids = document.querySelectorAll("video.html5-main-video, video.video-stream");
    for (const v of vids) {
      if (v && v.src) return v;
      if (v && v.closest && !v.closest(".ad-showing")) return v;
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
    let channelId = null;
    let handle = null;
    let name = null;

    // 1) From ytInitialData / ytInitialPlayerResponse (most reliable)
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
      const text = ownerLink.textContent.trim();
      if (text) name = name || text;
    }

    // Also try ytd-channel-name
    if (!name) {
      const cn = document.querySelector("ytd-channel-name #text, ytd-video-owner-renderer #channel-name #text, #owner #channel-name");
      if (cn) {
        const t = cn.textContent.trim();
        if (t) name = t;
      }
    }

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

  function applySpeedToVideo(speed) {
    const video = getVideoElement();
    if (!video) return;
    if (isAdShowing()) return;

    const target = Math.min(400, Math.max(25, Math.round(speed))) / 100;
    // Avoid loop: only set if different enough
    if (Math.abs(video.playbackRate - target) < 0.01) return;

    isApplyingRate = true;
    try {
      video.playbackRate = target;
      video.defaultPlaybackRate = target;
      lastAppliedSpeed = Math.round(target * 100);
    } finally {
      // Reset flag next tick to avoid catching our own ratechange
      setTimeout(() => { isApplyingRate = false; }, 100);
    }
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

    const speed = saved ? saved.speed : 100;
    Widget.updateSpeedDisplay(speed);
    applySpeedToVideo(speed);
    // Also try again after video metadata loads
    setTimeout(() => applySpeedToVideo(speed), 500);
    setTimeout(() => applySpeedToVideo(speed), 1500);
    return info;
  }

  async function pollForChannel(maxAttempts = 12) {
    clearInterval(channelPollTimer);
    let attempts = 0;
    const tryOnce = async () => {
      attempts++;
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
    const src = video.currentSrc || video.src || "";
    if (src && src === lastVideoSrc) {
      // already bound for this src
      return;
    }
    lastVideoSrc = src;

    // Re-apply on metadata loaded and play
    video.addEventListener("loadedmetadata", () => {
      if (currentChannel) {
        const speed = Widget.getCurrentSpeed();
        applySpeedToVideo(speed);
      } else {
        pollForChannel();
      }
    });

    video.addEventListener("play", () => {
      // YouTube may reset rate on play after ad
      if (isAdShowing()) return;
      const speed = Widget.getCurrentSpeed();
      if (speed !== 100) {
        // small delay to beat YouTube's reset
        setTimeout(() => applySpeedToVideo(speed), 50);
      }
    });

    video.addEventListener("ratechange", () => {
      if (isApplyingRate) return;
      // User changed via YouTube's own menu — we could optionally sync?
      // For now, ignore unless it's ad; don't overwrite saved value automatically
    });
  }

  function handleWidgetChange(newSpeed, channel) {
    // channel is { key, handle, name } from widget, but we prefer currentChannel
    const chan = currentChannel || channel;
    applySpeedToVideo(newSpeed);

    if (!chan || !chan.key) {
      Widget.showToast(`Speed ${newSpeed}% (channel not detected)`);
      return;
    }

    // Persist under both channelId and handle if we have both, but primary is key
    // Also store handle/name for popup display
    const primaryKey = chan.channelId || chan.key;
    STORAGE.setChannelSpeed(primaryKey, {
      handle: chan.handle || "",
      name: chan.name || "",
      speed: newSpeed,
    }).then(() => {
      // If we have both IDs, also store under handle for lookup migration help? Keep single source.
      Widget.showToast(`Saved ${newSpeed}% for ${chan.handle || chan.name || chan.key}`);
    }).catch((e) => {
      Widget.showToast(`Failed to save: ${e.message}`);
    });

    // If channel has both channelId and handle and we saved under channelId,
    // also remove stale handle entry if exists to avoid divergence? Not needed.
  }

  function onNavigation() {
    // Reset state
    lastVideoSrc = "";
    currentChannel = null;
    Widget.updateSpeedDisplay(100);
    Widget.setChannel(null);
    ensureWidgetMounted();
    bindVideoListeners();
    if (isRelevantPage()) {
      pollForChannel();
      // Also bind video observer after delay
      setTimeout(bindVideoListeners, 800);
      setTimeout(() => { ensureWidgetMounted(); pollForChannel(6); }, 1500);
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

    // Poll video element for src changes (YouTube reuses video tag)
    setInterval(() => {
      if (!isRelevantPage()) return;
      const v = getVideoElement();
      if (v) {
        const src = v.currentSrc || v.src || "";
        if (src !== lastVideoSrc) bindVideoListeners();
        // Re-apply if drifted (YouTube reset)
        if (!isAdShowing() && !isApplyingRate) {
          const expected = Widget.getCurrentSpeed();
          if (expected !== 100 && Math.abs(v.playbackRate * 100 - expected) > 1) {
            // Only re-apply if we have a saved channel speed
            if (currentChannel) applySpeedToVideo(expected);
          }
        }
      }
    }, 2000);
  }

  function init() {
    Widget.createWidget();
    Widget.onChange(handleWidgetChange);
    ensureWidgetMounted();
    setupObservers();
    onNavigation();

    // Listen storage changes from popup (e.g., import)
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (changes.channelSpeeds) {
          // Re-resolve current channel speed
          resolveAndApplyForCurrentChannel();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
