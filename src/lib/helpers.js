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

  // ---- "What's new" notice for the 1.3.0 shortcut change ----
  // The version that changed the defaults, and the new defaults. A command
  // whose current shortcut still equals its entry here is one the user saw
  // change; a customised or cleared shortcut did not change for them.
  const WHATS_NEW_VERSION = '1.3.0';
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
  // version before 1.3.0. Installs, browser updates and reloads of the same
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
    selectionRect,
    DOWNLOAD_EXTENSIONS,
    isDownloadableUrl,
    majorityShouldCheck,
    plural,
    filenameFromUrl,
    WHATS_NEW_VERSION,
    WHATS_NEW_SHORTCUTS,
    isVersionBefore,
    shouldOfferWhatsNew,
    formatShortcut,
    whatsNewLines,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.SnapLinkitLib;
  }
})();
