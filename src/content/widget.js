/* global YTPCS_Storage */
// Widget UI logic — exposes window.YTPCS_Widget

(function () {
  const MIN = 25;
  const MAX = 400;
  const STEP = 10;
  const FINE_STEP = 5;

  let widgetEl = null;
  let labelEl = null;
  let channelEl = null;
  let toastEl = null;
  let toastTimer = null;
  let currentSpeed = 100;
  let currentChannel = null; // { key, handle, name }
  let onChangeCallback = null;

  function createWidget() {
    if (widgetEl) return widgetEl;

    widgetEl = document.createElement("div");
    widgetEl.id = "yt-pcs-widget";
    widgetEl.setAttribute("role", "group");
    widgetEl.setAttribute("aria-label", "Per-channel playback speed");

    const channelSpan = document.createElement("span");
    channelSpan.className = "yt-pcs-channel";
    channelSpan.style.display = "none";
    channelEl = channelSpan;

    const btnMinus = document.createElement("button");
    btnMinus.className = "yt-pcs-btn";
    btnMinus.setAttribute("aria-label", "Decrease speed");
    btnMinus.textContent = "−";
    btnMinus.title = "Decrease (−10%, Shift −5%)";

    const label = document.createElement("span");
    label.className = "yt-pcs-label";
    label.textContent = "100%";
    label.setAttribute("aria-live", "polite");
    labelEl = label;

    const btnPlus = document.createElement("button");
    btnPlus.className = "yt-pcs-btn";
    btnPlus.setAttribute("aria-label", "Increase speed");
    btnPlus.textContent = "+";
    btnPlus.title = "Increase (+10%, Shift +5%)";

    btnMinus.addEventListener("click", (e) => {
      const step = e.shiftKey ? FINE_STEP : STEP;
      setSpeed(currentSpeed - step, true);
    });
    btnPlus.addEventListener("click", (e) => {
      const step = e.shiftKey ? FINE_STEP : STEP;
      setSpeed(currentSpeed + step, true);
    });

    // Keyboard: +/- while focused
    widgetEl.addEventListener("keydown", (e) => {
      if (e.key === "+" || e.key === "=" || e.key === "ArrowUp") {
        e.preventDefault();
        setSpeed(currentSpeed + (e.shiftKey ? FINE_STEP : STEP), true);
      } else if (e.key === "-" || e.key === "_" || e.key === "ArrowDown") {
        e.preventDefault();
        setSpeed(currentSpeed - (e.shiftKey ? FINE_STEP : STEP), true);
      } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSpeed(100, true);
      }
    });

    // Prevent YouTube player from handling clicks
    widgetEl.addEventListener("click", (e) => e.stopPropagation());
    widgetEl.addEventListener("mousedown", (e) => e.stopPropagation());

    widgetEl.appendChild(channelSpan);
    widgetEl.appendChild(btnMinus);
    widgetEl.appendChild(label);
    widgetEl.appendChild(btnPlus);

    toastEl = document.createElement("div");
    toastEl.className = "yt-pcs-toast";
    toastEl.setAttribute("role", "status");

    return widgetEl;
  }

  function setSpeed(newSpeed, persist) {
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(newSpeed)));
    currentSpeed = clamped;
    if (labelEl) labelEl.textContent = clamped + "%";
    updateButtonState();

    if (persist && onChangeCallback && currentChannel) {
      onChangeCallback(clamped, currentChannel);
    } else if (persist && onChangeCallback) {
      // No channel yet — still notify to set video rate, but no persistence key
      onChangeCallback(clamped, null);
    }
    // Also directly set video if callback not handling it
    return clamped;
  }

  function updateButtonState() {
    if (!widgetEl) return;
    const btns = widgetEl.querySelectorAll(".yt-pcs-btn");
    if (btns.length === 2) {
      btns[0].disabled = currentSpeed <= MIN;
      btns[1].disabled = currentSpeed >= MAX;
      btns[0].style.opacity = currentSpeed <= MIN ? "0.4" : "1";
      btns[1].style.opacity = currentSpeed >= MAX ? "0.4" : "1";
    }
  }

  function setChannel(channel) {
    currentChannel = channel;
    if (channelEl) {
      if (channel && (channel.handle || channel.name)) {
        channelEl.textContent = channel.handle || channel.name;
        channelEl.title = channel.name ? `${channel.name} (${channel.handle || channel.key})` : channel.handle || channel.key;
        channelEl.style.display = "";
      } else {
        channelEl.style.display = "none";
      }
    }
  }

  function updateSpeedDisplay(speed) {
    currentSpeed = Math.min(MAX, Math.max(MIN, Math.round(speed)));
    if (labelEl) labelEl.textContent = currentSpeed + "%";
    updateButtonState();
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("yt-pcs-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("yt-pcs-toast-show"), 2200);
  }

  function getElement() {
    return widgetEl;
  }

  function getToastElement() {
    return toastEl;
  }

  function onChange(cb) {
    onChangeCallback = cb;
  }

  function getCurrentSpeed() {
    return currentSpeed;
  }

  // Expose
  window.YTPCS_Widget = {
    createWidget,
    setSpeed,
    updateSpeedDisplay,
    setChannel,
    showToast,
    getElement,
    getToastElement,
    onChange,
    getCurrentSpeed,
    MIN, MAX, STEP
  };
})();
