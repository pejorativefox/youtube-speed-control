# YouTube Per-Channel Speed — Chrome / Brave Extension (MV3)

Set YouTube playback speed **per channel** and remember it. Hover widget on video (`[+] 110% [-]`), auto-applies on revisit, with JSON import/export.

## Features
- Hover-only widget top-right of video (`25% - 400%`, step `10%`, `Shift` = `5%`)
- Auto-applies saved speed for channel (keyed by `channelId`, fallback to `@handle`)
- Supports `youtube.com/watch` and `youtube.com/shorts` (no embeds)
- Storage: synced to your Google account via `chrome.storage.sync` (one item
  per channel, so ~500 channels fit), with a per-item `local` fallback
- Popup: list/search, per-channel `+/-` and delete, Export / Import (Merge or Replace)

## Load in Brave / Chrome
1. `brave://extensions` (or `chrome://extensions`) → Enable **Developer mode**
2. **Load unpacked** → select this folder (`manifest.json` at root)
3. Open a YouTube video → hover the video → widget appears top-right → `[−] 100% [+]`
4. Click `+/-` → saved per channel. Revisit channel → auto-applied.
5. Click extension icon → popup lists saved channels, Export/Import JSON.

## Syncing across browsers
`manifest.json` contains a pinned `key`, so the extension ID is always
`holeaccgpnebfmlckcpgkpfapidmpmdl` no matter which folder it is loaded from.
Saved speeds are tied to that ID, so they sync to any Chrome/Brave signed into
the same account (with extension sync on) and survive reloading the extension.
Removing the extension may still delete them — export a backup first.

The matching private key (`key.pem`) is only needed to pack a `.crx`; it is
git-ignored and must never be committed.

## JSON Format
```json
{
  "version": 1,
  "exportedAt": "2026-08-30T00:00:00Z",
  "channelSpeeds": {
    "UCxxx": { "handle": "@mkbhd", "name": "MKBHD", "speed": 130 },
    "UCyyy": { "handle": "@veritasium", "name": "Veritasium", "speed": 110 }
  }
}
```
Legacy flat `{"@handle":130}` also accepted on import.

## Project Structure
```
manifest.json
src/lib/storage.js        # shared storage helper
src/content/widget.js/css # hover widget UI
src/content/content.js    # SPA observer, channel detection, video binding
src/popup/*               # popup list + import/export
icons/
```

## Notes
- Ads (`.ad-showing`) are ignored when setting `playbackRate`.
- The content script runs at `document_start` and injects a tiny main-world
  bridge, so the saved speed is applied the moment the video can play rather
  than after page load.
- YouTube SPA navigation (`yt-navigate-finish`) is observed; no reload needed.
- A watchdog re-asserts the speed if YouTube resets it (ad end, autoplay,
  player reload), but never fights a speed you pick from YouTube's own menu.
- If the channel can't be identified (early load, Shorts transitions), the
  speed is stored under a site-wide fallback so changes are never lost.
