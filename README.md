# Snap Linkit

Select and manage multiple links, checkboxes, and buttons with a simple drag.

## Install

Firefox 142 or newer: install from addons.mozilla.org:
https://addons.mozilla.org/en-US/firefox/addon/snap-linkit/

Chrome 110 or newer: the same extension is built for Chrome from the same source (see Development).

## How it works

On any http or https page, hold the right mouse button and drag. Once the pointer has moved at least 5 pixels, a dashed selection box appears, and every visible link, checkbox, radio button, or button that the box touches is highlighted. Dragging near an edge of the window scrolls the page. A plain right-click without dragging still opens the normal context menu.

What happens when you let go of the button depends on what was selected:

- Links: they open in new tabs straight away. To change this, go to Settings > Tab Opening > "When I let go" and pick "Open in new tabs", "Open unloaded" (the tabs appear but don't load until you click them, which saves memory), "Copy links" or "Show the menu". Hold Ctrl as you let go to get the menu instead, whatever the setting. The menu has "Open N in New Tabs", "Open N Unloaded", "Copy Links", "Copy Link Text" and, when a selected link points at a file with one of these extensions (pdf, zip, rar, 7z, tar, gz, doc, docx, xls, xlsx, ppt, pptx, mp3, mp4, avi, mov, jpg, jpeg, png, gif, svg), "Download N Files". Drag the menu's top bar to move it. Tabs open in the background, in order, next to the current tab. "Unloaded" opens them the same way and then, where the browser supports discarding tabs, unloads each one once it has loaded, so the tabs appear but do not use memory until clicked. If the number of links is above the "Confirm at" setting, a confirmation dialog asks before opening.
- Only checkboxes or radio buttons: no menu. Checkboxes are toggled together (all checked if half or fewer were checked, otherwise all unchecked); the first selected radio button is selected. Checkboxes drawn on their labels (the real box hidden) are toggled through the label; hidden checkboxes that only open or close part of a page (menus, collapsible sections, spoilers) are left alone.
- Progress-tracking checkboxes on Fandom wikis (for example the "List" tab of a challenges page): Snap Linkit works with Fandom wikis' tracking tables. It ticks the boxes one at a time and waits for each save to finish before the next ("Delay Between Saves", below, adds a pause after each). The message says how many were saved; if a save fails or Fandom doesn't accept it (for example when you are signed out), it stops and says so. Above 30 boxes a dialog asks first, with how many are already ticked and the first and last rows it will change, for example "Check 35 items? (5 already checked) Master Marksman → Little Inanimate Spies". A drag that starts in a tracking box's cell selects only tracking boxes, never the links beside them. If the page changes under a drag so much that Snap Linkit can't tell which rows you meant, it saves nothing and says "The page changed under the drag; drag again."
- Only buttons: the selection is cleared and nothing else happens.

While links are selected, Ctrl+C (Cmd+C on macOS) copies them, Ctrl+drag (hold Ctrl as you start dragging) adds more links, Alt+drag removes some, and Escape or a left-click clears it. Duplicate URLs are opened and copied once. Links whose target is not an http or https URL are not selectable.

## Features

Toolbar popup, Info tab: a usage summary and the shortcut list.

The popup also says why Snap Linkit does nothing on the current tab, at the top, with a one-click fix: "Snap Linkit is switched off." ("Switch on"), or "Snap Linkit is off on this site (rule: …)." ("Remove rule", "Edit rules") when a Site Filtering rule excludes the site. Without access to websites Snap Linkit can't run on any page: the toolbar icon then shows "!" and the popup offers "Grant access". Pages that were already open need a reload after access is granted.

Toolbar popup, Settings tab:

- "Snap Linkit enabled": turns the extension on or off for all tabs. The Alt+Shift+L shortcut flips the same setting.
- Auto-Scroll: "Edge Threshold" (10 to 100 px, default 50), how close to the window edge the pointer must be before the page scrolls; "Scroll Speed" (5 to 30 px per frame, default 15).
- Tab Opening: "When I let go" (Open in new tabs, Open unloaded, Copy links, Show the menu; default Open in new tabs), what letting go after a drag over links does; "Confirm at" (5 to 100 tabs, default 20), the link count above which the confirmation dialog appears; "Delay Between" (0 to 2000 ms in steps of 50, default 50), the pause between opening one tab and the next.
- Fandom Tracking Boxes: "Delay Between Saves" (0 to 2000 ms in steps of 50, default 150), the extra pause after each saved tracking box.
- Site Filtering: a list of host patterns with a Blacklist/Whitelist switch. In Blacklist mode the extension runs everywhere except the listed sites; in Whitelist mode it runs only on them. Patterns use lowercase letters, digits, dots, hyphens and "*", and must contain a dot. "*.example.com" matches example.com and every subdomain of it; "example.com" matches only that exact host. Up to 100 entries and 6 KB in total. Internationalized domain names must be entered in punycode form (for example xn--bcher-kva.example).
- "Reset All to Defaults".

Keyboard shortcuts:

- Alt+Shift+L (Option+Shift+L on macOS): toggle Snap Linkit on/off (applies to all tabs).
- Alt+Shift+Comma (Option+Shift+Comma on macOS): open all selected links in new tabs.

## Permissions

- `clipboardWrite`: "Copy Links", "Copy Link Text", the "Copy links" choice of "When I let go", and Ctrl+C write to the clipboard (content.js).
- `storage`: settings are saved with storage.sync (popup.js, content.js).
- `downloads`: "Download N Files" uses the downloads API (background.js).
- Host permissions `http://*/*` and `https://*/*`: the content script that draws the selection box and reads the links under it runs on http and https pages (manifest.json content_scripts, content.js). With them the popup can also read the current tab's address, to say whether a Site Filtering rule switches Snap Linkit off there; it is not stored or sent (popup.js).

## Privacy

Snap Linkit sends nothing on its own: the source contains no fetch, XMLHttpRequest or WebSocket calls, and the only network requests are the pages and files you choose to open or download. Selected links are only opened, copied or downloaded when you choose an action. Your settings are kept in storage.sync (Firefox Sync can copy them to your other devices if you use Sync), and a one-time What's-new flag is kept in local storage. The bundled privacy policy is [src/privacy-policy.html](src/privacy-policy.html), also reachable from the "Privacy policy" link in the popup footer.

## Development

`src/` is the Firefox extension as it is; `chrome/` holds only what Chrome needs to be different.

1. Open `about:debugging` in Firefox, choose "This Firefox", then "Load Temporary Add-on…" and pick `src/manifest.json`.
2. Run the unit tests: `npm test`.
3. Lint before submitting: `npx web-ext lint --source-dir src`.
4. Build the store packages: `node build.mjs` writes `dist/firefox`, `dist/chrome` and a zip of each. Store packages leave out the test-only code (marked `@test-only` in `src/`).
5. Build test packages: `node build.mjs --test` writes `dist/test/`. They write diagnostic lines to the console (one per drag, one per saved tracking box, and each message shown), use their own Firefox ID (`snap-linkit-test@privacy-guaranteed`) so they never share the store copy's settings or site access, and show "(test build)" after the name. Never upload them to a store.

## License

MIT — see LICENSE.
