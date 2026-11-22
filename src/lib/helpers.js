/**
 * Snap Linkit - pure helpers shared by content.js, background.js and popup.js.
 *
 * Classic script: it is listed before those files in manifest.json and
 * popup.html and exposes globalThis.SnapLinkitLib. Nothing here touches the
 * DOM, the WebExtension API or extension state, so the same file is also
 * loadable with require() by the unit tests in test/.
 */
(function () {
  'use strict';

  // Only http(s) URLs can be opened by tabs.create or fetched by
  // downloads.download; javascript:, data:, blob:, file:, about: and
  // friends are rejected by the browser. Checked on the resolved URL so
  // case and whitespace variants of an href attribute are covered.
  const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);
  function isOpenableUrl(url) {
    try {
      return typeof url === 'string' && OPENABLE_PROTOCOLS.has(new URL(url).protocol);
    } catch (e) {
      return false;
    }
  }

  // Site-list matching on lowercased strings.
  //   "*.example.com"  matches example.com and any subdomain (a.example.com,
  //                    a.b.example.com) but not notexample.com or example.com.evil.net
  //   "example.com"    matches exactly that host
  //   other wildcards  ("mail.*.com") keep the original regex semantics
  // IDN: the popup accepts ASCII only, so patterns are entered as punycode, and
  // location.hostname is punycode too, so plain comparison is correct.
  function matchesPattern(hostname, pattern) {
    const host = String(hostname || '').toLowerCase();
    const pat = String(pattern || '').toLowerCase();
    if (!pat) return false;

    if (pat.startsWith('*.') && !pat.slice(2).includes('*')) {
      const base = pat.slice(2);
      return host === base || host.endsWith('.' + base);
    }

    if (!pat.includes('*')) {
      return host === pat;
    }

    // Remaining wildcard forms: escape regex specials (except *), then * -> .*
    const escaped = pat
      .replace(/\\/g, '\\\\')
      .replace(/[.+?^${}()|[\]]/g, '\\$&')
      .replace(/\*/g, '.*');
    try {
      return new RegExp('^' + escaped + '$').test(host);
    } catch (e) {
      return false;
    }
  }

  // Validate a site-list entry (already trimmed and lowercased by the popup).
  // Valid: domain.com, *.domain.com, sub.domain.com, *.co.uk
  // Invalid: empty, just symbols, no alphanumeric, too short
  function isValidPattern(pattern) {
    if (!pattern || pattern.length < 3) {
      return { valid: false, message: 'Pattern too short (min 3 chars)' };
    }

    if (pattern.length > 253) {
      return { valid: false, message: 'Pattern too long (max 253 chars)' };
    }

    // Must contain at least one alphanumeric character
    if (!/[a-z0-9]/.test(pattern)) {
      return { valid: false, message: 'Must contain letters or numbers' };
    }

    // Only allow valid domain characters plus wildcards
    if (/[^a-z0-9.*-]/.test(pattern)) {
      return { valid: false, message: 'Invalid characters (use a-z, 0-9, ., -, *)' };
    }

    // Must have at least one dot (domain separator)
    if (!pattern.includes('.')) {
      return { valid: false, message: 'Must include a dot (e.g., *.example.com)' };
    }

    // Reject patterns that are only dots and asterisks
    if (/^[.*]+$/.test(pattern)) {
      return { valid: false, message: 'Must include domain name' };
    }

    // Reject consecutive dots
    if (/\.\./.test(pattern)) {
      return { valid: false, message: 'Invalid: consecutive dots' };
    }

    return { valid: true };
  }

  // Serialized size of the site list, the quantity storage.sync limits per item
  function blacklistBytes(list) {
    return new TextEncoder().encode(JSON.stringify(list)).length;
  }

  // A computed style that draws nothing: display none, visibility hidden or
  // opacity 0 (the visibility test getSelectableElements has always used)
  function isStyleHidden(style) {
    return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
  }

  // Custom-styled checkboxes hide the real <input> (opacity 0,
  // display none, visibility hidden or a 0x0 box) and draw the box on a
  // <label> (issue #1). Given the input's state and its labels' states, return
  // the indexes of the labels that stand in for it: the visible, non-empty
  // ones. [] means the input is used as itself (it shows, or no label shows).
  //   input   { hidden, rect: { width, height } }   hidden = isStyleHidden(style)
  //   labels  [{ hidden, rect: { width, height } }]
  function proxyLabelIndexes(input, labels) {
    const shows = (s) => !s.hidden && s.rect.width > 0 && s.rect.height > 0;
    if (shows(input)) return [];
    const out = [];
    labels.forEach((label, i) => { if (shows(label)) out.push(i); });
    return out;
  }

  // Axis-aligned rectangle intersection (no snapping tolerance)
  function rectsIntersect(r1, r2) {
    return !(
      r1.right < r2.left ||
      r1.left > r2.right ||
      r1.bottom < r2.top ||
      r1.top > r2.bottom
    );
  }

  // Scroll-aware selection rectangle in viewport coordinates.
  //   start   { x, y, scrollX, scrollY }  pointer and page scroll when the drag began
  //   current { x, y }                    pointer now
  //   scroll  { x, y }                    page scroll now
  // The start point is shifted by the scroll delta instead of being mutated:
  // if the user scrolled down, the start point moves up in viewport space.
  function selectionRect(start, current, scroll) {
    const scrollDeltaX = scroll.x - start.scrollX;
    const scrollDeltaY = scroll.y - start.scrollY;

    const adjustedStartX = start.x - scrollDeltaX;
    const adjustedStartY = start.y - scrollDeltaY;

    const left = Math.min(adjustedStartX, current.x);
    const top = Math.min(adjustedStartY, current.y);
    const width = Math.abs(current.x - adjustedStartX);
    const height = Math.abs(current.y - adjustedStartY);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  // Links that the "Download N Files" action offers (by URL suffix)
  const DOWNLOAD_EXTENSIONS = /\.(pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|jpg|jpeg|png|gif|svg)$/i;
  function isDownloadableUrl(url) {
    return typeof url === 'string' && DOWNLOAD_EXTENSIONS.test(url);
  }

  // Checkbox majority rule: if half or fewer are checked, check all; otherwise uncheck all
  function majorityShouldCheck(checkedCount, total) {
    return checkedCount <= total / 2;
  }

  // Place one axis of the action menu inside the visible area.
  //   start   pointer coordinate (where the menu would start)
  //   size    the menu's natural size on this axis
  //   space   visible size of the viewport on this axis (scrollbars excluded)
  //   margin  gap to keep from both edges
  // Returns { pos, max }: pos is the menu's start coordinate; max is null when
  // the menu fits, otherwise the size to cap it at (it then scrolls inside).
  // - Fits with `margin` on both sides: at the pointer, moved back by the
  //   overflow, never closer than `margin` to the start edge (the menu's
  //   placement before P2-3).
  // - Fits only with less: the margins shrink (centred), so the whole menu
  //   stays visible without scrolling.
  // - Larger than the space: capped to space - 2 * margin, pinned at margin.
  function fitMenuAxis(start, size, space, margin) {
    const avail = Math.max(0, space - 2 * margin);
    if (size > space) return { pos: margin, max: avail };
    if (size > avail) return { pos: (space - size) / 2, max: null };
    let pos = start;
    if (pos + size > space - margin) pos = space - margin - size;
    return { pos: Math.max(margin, pos), max: null };
  }

  // Clamp one axis of a menu the user is dragging so it stays inside the
  // visible area, with the same rule as fitMenuAxis: `margin` from both edges
  // when there is room for it, otherwise the margin shrinks (down to 0).
  //   pos    wanted start coordinate   size   menu size on this axis
  //   space  visible size of the viewport on this axis
  function clampMenuAxis(pos, size, space, margin) {
    const m = Math.max(0, Math.min(margin, (space - size) / 2));
    return Math.min(Math.max(pos, m), Math.max(m, space - size - m));
  }

  // "When I let go": what a plain release over links does. Ctrl at release
  // and add/remove drags (dragModifierMode) always show the menu, whatever
  // this says.
  const RELEASE_ACTIONS = Object.freeze(['open', 'openUnloaded', 'copyUrls', 'menu']);
  // A stored value that is not one of RELEASE_ACTIONS (missing, older or
  // hand-edited) counts as the default, 'open'.
  function normalizeReleaseAction(value) {
    return RELEASE_ACTIONS.includes(value) ? value : 'open';
  }

  // How a right-drag edits the selection, from the modifier keys held as it
  // starts (a mousedown event, or any { ctrlKey, shiftKey, altKey }):
  //   'add'     Ctrl (advertised since P2-9), or Shift (the old key, kept
  //             working but no longer advertised: Firefox always shows its
  //             own context menu after a Shift+right-click, and pages cannot
  //             cancel it)
  //   'remove'  Alt
  //   null      none of these: a fresh selection
  // Shift and Alt win over Ctrl, so every combination that worked before
  // P2-9 (Shift+Alt = add, Ctrl+Alt = remove) does the same thing now.
  function dragModifierMode(keys) {
    if (!keys) return null;
    if (keys.shiftKey) return 'add';
    if (keys.altKey) return 'remove';
    return keys.ctrlKey ? 'add' : null;
  }

  function plural(count, noun) {
    return `${count} ${noun}${count !== 1 ? 's' : ''}`;
  }

  // Characters the downloads API rejects in a filename: backslash, slash,
  // colon, star, question mark, quote, angle brackets, pipe, and the ASCII
  // control range (built from char codes so this file stays free of them).
  const FILENAME_UNSAFE = new RegExp(
    '[\\\\/:*?"<>|' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']',
    'g'
  );

  // Derive a download filename from the URL path: last path segment,
  // percent-decoded, with unsafe characters replaced and leading dots
  // stripped. Falls back to "download" for paths ending in "/".
  function filenameFromUrl(url) {
    let segment = '';
    try {
      segment = new URL(url).pathname.split('/').pop() || '';
    } catch (e) {
      return 'download';
    }
    try {
      segment = decodeURIComponent(segment);
    } catch (e) {
      // Malformed escape sequence: keep the encoded form
    }
    const cleaned = segment
      .replace(FILENAME_UNSAFE, '_')
      .replace(/^\.+/, '')
      .trim();
    return cleaned || 'download';
  }

  // ---- "What's new" notice (1.4.0: letting go acts at once) ----
  // WHATS_NEW_VERSION: an update from any version before it gets the note.
  // People updating from before 1.3.0 also get the 1.3.0 shortcut lines: the
  // version that changed the defaults, and the new defaults. A command
  // whose current shortcut still equals its entry here is one the user saw
  // change; a customised or cleared shortcut did not change for them.
  const WHATS_NEW_VERSION = '1.4.0';
  const WHATS_NEW_SHORTCUTS_VERSION = '1.3.0';
  const WHATS_NEW_SHORTCUTS = Object.freeze([
    Object.freeze({ name: 'toggle-extension', label: 'Turn Snap Linkit on or off', shortcut: 'Alt+Shift+L' }),
    Object.freeze({ name: 'open-selected-tabs', label: 'Open selected links', shortcut: 'Alt+Shift+Comma' }),
  ]);

  // Dotted numeric version compare: true when a is older than b
  // ("1.2.1" < "1.3.0"). Missing or non-numeric parts count as 0.
  function isVersionBefore(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  // runtime.onInstalled details -> offer the notice? Only an update from a
  // version before 1.4.0. Installs, browser updates and reloads of the same
  // version are excluded; temporary loads are deliberately not.
  function shouldOfferWhatsNew(details) {
    return Boolean(details) && details.reason === 'update' &&
      typeof details.previousVersion === 'string' &&
      isVersionBefore(details.previousVersion, WHATS_NEW_VERSION);
  }

  // "Alt+Shift+Comma" -> "Alt + Shift + Comma"; on macOS Alt is the Option
  // key and Ctrl means Command (MDN manifest.json/commands).
  const MAC_KEY_NAMES = { Alt: 'Option', Ctrl: 'Command', MacCtrl: 'Control' };
  function formatShortcut(shortcut, isMac) {
    return String(shortcut).split('+')
      .map((part) => (isMac && MAC_KEY_NAMES[part]) || (part === 'MacCtrl' ? 'Control' : part))
      .join(' + ');
  }

  // storage.local "whatsNew" record for an update from previousVersion.
  // shortcuts: also show the 1.3.0 shortcut lines, for an update from before
  // 1.3.0 or when a 1.3.0 note was still waiting for "Got it" (pending).
  function whatsNewRecord(previousVersion, pending) {
    return {
      version: WHATS_NEW_VERSION,
      badge: true,
      shortcuts: isVersionBefore(previousVersion, WHATS_NEW_SHORTCUTS_VERSION) || whatsNewShowsShortcuts(pending),
    };
  }

  // Does a stored record ask for the shortcut lines? A 1.3.0 record (written
  // by 1.3.0, no shortcuts field) was a shortcut note, so it does.
  function whatsNewShowsShortcuts(record) {
    return Boolean(record) && (record.shortcuts === true || record.version === WHATS_NEW_SHORTCUTS_VERSION);
  }

  // commands.getAll() result -> note lines, one per command still on its new
  // default. Empty when the user customised or cleared both.
  function whatsNewLines(commands, isMac) {
    const current = new Map((Array.isArray(commands) ? commands : []).map((c) => [c && c.name, c && c.shortcut]));
    return WHATS_NEW_SHORTCUTS
      .filter((s) => current.get(s.name) === s.shortcut)
      .map((s) => `${s.label}: ${formatShortcut(s.shortcut, isMac)}`);
  }

  globalThis.SnapLinkitLib = Object.freeze({
    OPENABLE_PROTOCOLS,
    isOpenableUrl,
    matchesPattern,
    isValidPattern,
    blacklistBytes,
    rectsIntersect,
    isStyleHidden,
    proxyLabelIndexes,
    selectionRect,
    DOWNLOAD_EXTENSIONS,
    isDownloadableUrl,
    majorityShouldCheck,
    fitMenuAxis,
    clampMenuAxis,
    RELEASE_ACTIONS,
    normalizeReleaseAction,
    dragModifierMode,
    plural,
    filenameFromUrl,
    WHATS_NEW_VERSION,
    WHATS_NEW_SHORTCUTS,
    isVersionBefore,
    shouldOfferWhatsNew,
    whatsNewRecord,
    whatsNewShowsShortcuts,
    formatShortcut,
    whatsNewLines,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.SnapLinkitLib;
  }
})();
