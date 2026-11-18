# Snap Linkit

Select and manage multiple links, checkboxes, and buttons with a simple drag.

## Install

Firefox only, version 142 or newer. Install from addons.mozilla.org:
https://addons.mozilla.org/en-US/firefox/addon/snap-linkit/

## How it works

On any http or https page, hold the right mouse button and drag. Once the pointer has moved at least 5 pixels, a dashed selection box appears, and every visible link, checkbox, radio button, or button that the box touches is highlighted. Dragging near an edge of the window scrolls the page. A plain right-click without dragging still opens the normal context menu.

What happens when you let go of the button depends on what was selected:

- Links: they open in new tabs straight away. To change this, go to Settings > Tab Opening > "When I let go" and pick "Open in new tabs", "Open unloaded" (the tabs appear but don't load until you click them, which saves memory), "Copy links" or "Show the menu". Hold Ctrl as you let go to get the menu instead, whatever the setting. The menu has "Open N in New Tabs", "Open N Unloaded", "Copy Links", "Copy Link Text" and, when a selected link points at a file with one of these extensions (pdf, zip, rar, 7z, tar, gz, doc, docx, xls, xlsx, ppt, pptx, mp3, mp4, avi, mov, jpg, jpeg, png, gif, svg), "Download N Files". Drag the menu's top bar to move it. Tabs open in the background, in order, next to the current tab. "Unloaded" opens them the same way and then, where the browser supports discarding tabs, unloads each one once it has loaded, so the tabs appear but do not use memory until clicked. If the number of links is above the "Confirm at" setting, a confirmation dialog asks before opening.
- Only checkboxes or radio buttons: no menu. Checkboxes are toggled together (all checked if half or fewer were checked, otherwise all unchecked); the first selected radio button is selected.
- Only buttons: the selection is cleared and nothing else happens.

While links are selected, Ctrl+C (Cmd+C on macOS) copies them, Ctrl+drag (hold Ctrl as you start dragging) adds more links, Alt+drag removes some, and Escape or a left-click clears it. Duplicate URLs are opened and copied once. Links whose target is not an http or https URL are not selectable.

## Features

Toolbar popup, Info tab: a usage summary and the shortcut list.

Toolbar popup, Settings tab:

- "Snap Linkit enabled": turns the extension on or off for all tabs. The Alt+Shift+L shortcut flips the same setting.
- Auto-Scroll: "Edge Threshold" (10 to 100 px, default 50), how close to the window edge the pointer must be before the page scrolls; "Scroll Speed" (5 to 30 px per frame, default 15).
- Tab Opening: "When I let go" (Open in new tabs, Open unloaded, Copy links, Show the menu; default Open in new tabs), what letting go after a drag over links does; "Confirm at" (5 to 100 tabs, default 20), the link count above which the confirmation dialog appears; "Delay Between" (0 to 2000 ms in steps of 50, default 50), the pause between opening one tab and the next.
- Site Filtering: a list of host patterns with a Blacklist/Whitelist switch. In Blacklist mode the extension runs everywhere except the listed sites; in Whitelist mode it runs only on them. Patterns use lowercase letters, digits, dots, hyphens and "*", and must contain a dot. "*.example.com" matches example.com and every subdomain of it; "example.com" matches only that exact host. Up to 100 entries and 6 KB in total. Internationalized domain names must be entered in punycode form (for example xn--bcher-kva.example).
- "Reset All to Defaults".

Keyboard shortcuts:

- Alt+Shift+L (Option+Shift+L on macOS): toggle Snap Linkit on/off (applies to all tabs).
- Alt+Shift+Comma (Option+Shift+Comma on macOS): open all selected links in new tabs.

## Permissions

- `clipboardWrite`: "Copy Links", "Copy Link Text", the "Copy links" choice of "When I let go", and Ctrl+C write to the clipboard (content.js).
- `storage`: settings are saved with storage.sync (popup.js, content.js).
- `downloads`: "Download N Files" uses the downloads API (background.js).
- Host permissions `http://*/*` and `https://*/*`: the content script that draws the selection box and reads the links under it runs on http and https pages (manifest.json content_scripts, content.js).

## Privacy

Snap Linkit sends nothing on its own: the source contains no fetch, XMLHttpRequest or WebSocket calls, and the only network requests are the pages and files you choose to open or download. Selected links are only opened, copied or downloaded when you choose an action. Your settings are kept in storage.sync (Firefox Sync can copy them to your other devices if you use Sync), and a one-time What's-new flag is kept in local storage. The bundled privacy policy is [src/privacy-policy.html](src/privacy-policy.html), also reachable from the "Privacy policy" link in the popup footer.

## Development

There is no build step; `src/` is the extension.

1. Open `about:debugging` in Firefox, choose "This Firefox", then "Load Temporary Add-on…" and pick `src/manifest.json`.
2. Run the unit tests: `npm test`.
3. Lint before submitting: `npx web-ext lint --source-dir src`.

## License

MIT — see LICENSE.
