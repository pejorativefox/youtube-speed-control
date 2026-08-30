# YouTube Per-Channel Speed — Chrome / Brave Extension (MV3)

Set YouTube playback speed **per channel** and remember it. Hover widget on video (`[+] 110% [-]`), auto-applies on revisit, with JSON import/export.

## Features
- Hover-only widget top-right of video (`25% - 400%`, step `10%`, `Shift` = `5%`)
- Auto-applies saved speed for channel (keyed by `channelId`, fallback to `@handle`)
- Supports `youtube.com/watch` and `youtube.com/shorts` (no embeds)
- Storage: `chrome.storage.sync` with `local` fallback
- Popup: list/search, per-channel `+/-` and delete, Export / Import (Merge or Replace)

## Load in Brave / Chrome
1. `brave://extensions` (or `chrome://extensions`) → Enable **Developer mode**
2. **Load unpacked** → select this folder (`manifest.json` at root)
3. Open a YouTube video → hover the video → widget appears top-right → `[−] 100% [+]`
4. Click `+/-` → saved per channel. Revisit channel → auto-applied.
5. Click extension icon → popup lists saved channels, Export/Import JSON.

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
- YouTube SPA navigation (`yt-navigate-finish`) is observed; no reload needed.
