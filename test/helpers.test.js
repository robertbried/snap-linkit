'use strict';
// Unit tests for src/lib/helpers.js. Zero dependencies: node:test + node:assert.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib/helpers.js');

test('SnapLinkitLib exposes every helper and is frozen', () => {
  assert.deepEqual(Object.keys(lib).sort(), [
    'DOWNLOAD_EXTENSIONS', 'OPENABLE_PROTOCOLS', 'RELEASE_ACTIONS', 'WHATS_NEW_SHORTCUTS', 'WHATS_NEW_VERSION',
    'blacklistBytes', 'clampMenuAxis', 'dragModifierMode', 'filenameFromUrl', 'fitMenuAxis', 'formatShortcut', 'isDownloadableUrl', 'isOpenableUrl',
    'isValidPattern', 'isVersionBefore', 'majorityShouldCheck', 'matchesPattern', 'normalizeReleaseAction', 'plural',
    'rectsIntersect', 'selectionRect', 'shouldOfferWhatsNew', 'whatsNewLines',
  ]);
  assert.ok(Object.isFrozen(lib));
  assert.equal(globalThis.SnapLinkitLib, lib);
});

test('isOpenableUrl: only http and https, judged on the parsed URL', () => {
  const cases = {
    'https://a.b/c': true, 'http://a.b/': true, 'HTTP://A.B/': true, '  https://x.y/z  ': true,
    'https://a.b/c#frag': true, 'https://a.b/?q=1': true,
    'javascript:alert(1)': false, 'JavaScript:alert(1)': false, ' javascript:x': false,
    'data:text/plain,hi.pdf': false, 'blob:https://a.b/uuid': false, 'file:///etc/passwd': false,
    'about:blank': false, 'mailto:a@b.c': false, 'tel:+1': false, 'ftp://a.b/': false,
    '': false, 'not a url': false,
  };
  for (const [url, expected] of Object.entries(cases)) assert.equal(lib.isOpenableUrl(url), expected, url);
});

test('isOpenableUrl: non-strings are never openable (background.js relies on this for message payloads)', () => {
  for (const v of [undefined, null, 42, {}, [], { href: 'https://a.b/' }]) assert.equal(lib.isOpenableUrl(v), false);
  assert.deepEqual([...lib.OPENABLE_PROTOCOLS], ['http:', 'https:']);
});

test('matchesPattern: leading "*." matches the apex and every subdomain', () => {
  assert.equal(lib.matchesPattern('example.com', '*.example.com'), true);
  assert.equal(lib.matchesPattern('a.example.com', '*.example.com'), true);
  assert.equal(lib.matchesPattern('a.b.example.com', '*.example.com'), true);
  assert.equal(lib.matchesPattern('notexample.com', '*.example.com'), false);
  assert.equal(lib.matchesPattern('example.com.evil.net', '*.example.com'), false);
});

test('matchesPattern: exact patterns, other wildcards, case, IDN, empty', () => {
  assert.equal(lib.matchesPattern('example.com', 'example.com'), true);
  assert.equal(lib.matchesPattern('a.example.com', 'example.com'), false);
  assert.equal(lib.matchesPattern('mail.google.com', 'mail.*.com'), true);
  assert.equal(lib.matchesPattern('mail.google.org', 'mail.*.com'), false);
  assert.equal(lib.matchesPattern('Example.COM', '*.example.com'), true);
  assert.equal(lib.matchesPattern('example.com', '*.EXAMPLE.com'), true);
  assert.equal(lib.matchesPattern('xn--bcher-kva.example', '*.xn--bcher-kva.example'), true);
  assert.equal(lib.matchesPattern('shop.xn--bcher-kva.example', '*.xn--bcher-kva.example'), true);
  assert.equal(lib.matchesPattern('example.com', ''), false);
  assert.equal(lib.matchesPattern('', 'example.com'), false);
  assert.equal(lib.matchesPattern('example.com', '*.a.*.com'), false); // mixed wildcard: regex path
  assert.equal(lib.matchesPattern('x.a.y.com', '*.a.*.com'), true);
});

test('isValidPattern: accepted forms', () => {
  for (const p of ['example.com', '*.example.com', 'sub.example.com', '*.co.uk', 'a-b.example', 'xn--bcher-kva.example']) {
    assert.deepEqual(lib.isValidPattern(p), { valid: true }, p);
  }
});

test('isValidPattern: rejected forms carry the message the popup shows', () => {
  const expect = (p, message) => assert.deepEqual(lib.isValidPattern(p), { valid: false, message }, p);
  expect('', 'Pattern too short (min 3 chars)');
  expect('ab', 'Pattern too short (min 3 chars)');
  expect('a'.repeat(254), 'Pattern too long (max 253 chars)');
  expect('***', 'Must contain letters or numbers');
  expect('...', 'Must contain letters or numbers');
  expect('exa mple.com', 'Invalid characters (use a-z, 0-9, ., -, *)');
  expect('Example.com', 'Invalid characters (use a-z, 0-9, ., -, *)'); // popup lowercases before validating
  expect('bücher.example', 'Invalid characters (use a-z, 0-9, ., -, *)'); // IDN must be entered as punycode
  expect('localhost', 'Must include a dot (e.g., *.example.com)');
  expect('a..com', 'Invalid: consecutive dots');
});

test('blacklistBytes: UTF-8 size of the JSON list', () => {
  assert.equal(lib.blacklistBytes([]), 2);
  assert.equal(lib.blacklistBytes(['a.com']), 9);
  assert.equal(lib.blacklistBytes(['ü.de']), 9); // ü is two bytes
  assert.equal(lib.blacklistBytes(['a.com', 'b.org']), 17);
});

test('rectsIntersect: overlap, touching edges, containment, disjoint', () => {
  const r = (l, t, rt, b) => ({ left: l, top: t, right: rt, bottom: b });
  assert.equal(lib.rectsIntersect(r(0, 0, 10, 10), r(5, 5, 15, 15)), true);
  assert.equal(lib.rectsIntersect(r(0, 0, 10, 10), r(10, 0, 20, 10)), true); // shared edge counts
  assert.equal(lib.rectsIntersect(r(0, 0, 10, 10), r(2, 2, 3, 3)), true); // contained
  assert.equal(lib.rectsIntersect(r(0, 0, 10, 10), r(11, 0, 20, 10)), false);
  assert.equal(lib.rectsIntersect(r(0, 0, 10, 10), r(0, 11, 10, 20)), false);
  assert.equal(lib.rectsIntersect(r(0, 0, 0, 0), r(0, 0, 0, 0)), true); // zero-size at the same point
});

test('selectionRect: plain drag, reversed drag, and scroll compensation', () => {
  const noScroll = { x: 0, y: 0 };
  assert.deepEqual(
    lib.selectionRect({ x: 10, y: 10, scrollX: 0, scrollY: 0 }, { x: 50, y: 30 }, noScroll),
    { left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 });
  assert.deepEqual(
    lib.selectionRect({ x: 50, y: 30, scrollX: 0, scrollY: 0 }, { x: 10, y: 10 }, noScroll),
    { left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 });
  // Page scrolled down 40px since the drag began: the start point moves up in viewport space
  assert.deepEqual(
    lib.selectionRect({ x: 10, y: 100, scrollX: 0, scrollY: 0 }, { x: 30, y: 120 }, { x: 0, y: 40 }),
    { left: 10, top: 60, right: 30, bottom: 120, width: 20, height: 60 });
  // Horizontal scroll works the same way
  assert.deepEqual(
    lib.selectionRect({ x: 100, y: 10, scrollX: 20, scrollY: 0 }, { x: 100, y: 30 }, { x: 50, y: 0 }),
    { left: 70, top: 10, right: 100, bottom: 30, width: 30, height: 20 });
});

test('isDownloadableUrl: known extensions at the end of the URL, case-insensitive', () => {
  for (const u of ['https://a.b/x.pdf', 'https://a.b/x.PDF', 'https://a.b/x.tar.gz', 'https://a.b/x.svg', 'https://a.b/p/x.docx']) {
    assert.equal(lib.isDownloadableUrl(u), true, u);
  }
  for (const u of ['https://a.b/x.html', 'https://a.b/x.zipper', 'https://a.b/x.pdf?dl=1', 'https://a.b/x.pdf#p', 'https://a.b/', '', undefined]) {
    assert.equal(lib.isDownloadableUrl(u), false, String(u));
  }
  assert.ok(lib.DOWNLOAD_EXTENSIONS instanceof RegExp);
});

test('majorityShouldCheck: half or fewer checked -> check all, otherwise uncheck all', () => {
  assert.equal(lib.majorityShouldCheck(3, 5), false);
  assert.equal(lib.majorityShouldCheck(2, 5), true);
  assert.equal(lib.majorityShouldCheck(0, 5), true);
  assert.equal(lib.majorityShouldCheck(5, 5), false);
  assert.equal(lib.majorityShouldCheck(2, 4), true); // exactly half -> check
  assert.equal(lib.majorityShouldCheck(1, 1), false);
  assert.equal(lib.majorityShouldCheck(0, 1), true);
});

test('plural', () => {
  assert.equal(lib.plural(1, 'tab'), '1 tab');
  assert.equal(lib.plural(0, 'tab'), '0 tabs');
  assert.equal(lib.plural(2, 'file'), '2 files');
});

test('filenameFromUrl: last path segment, decoded, sanitized, with fallback', () => {
  const cases = {
    'https://a.b/dir/file.pdf?x=1#page=2': 'file.pdf',
    'https://a.b/dir/': 'download',
    'https://a.b/': 'download',
    'https://a.b/na%20me.zip': 'na me.zip',
    'https://a.b/%E2%82%AC.pdf': '€.pdf',
    'https://a.b/bad%zz.pdf': 'bad%zz.pdf',
    'https://a.b/..%2F..%2Fetc': '_.._etc',
    'https://a.b/a:b*c.txt': 'a_b_c.txt',
    'https://a.b/a%5Cb.txt': 'a_b.txt', // backslash
    'https://a.b/x%01y%1Fz.pdf': 'x_y_z.pdf', // ASCII control characters
    'https://a.b/.hidden.tar.gz': 'hidden.tar.gz',
    'not a url': 'download',
    'https://a.b/report.PDF': 'report.PDF',
    'https://a.b/x/y/z.mp4?dl=1': 'z.mp4',
  };
  for (const [url, expected] of Object.entries(cases)) assert.equal(lib.filenameFromUrl(url), expected, url);
});

test('isVersionBefore: dotted numeric compare', () => {
  assert.equal(lib.isVersionBefore('1.2.1', '1.3.0'), true);
  assert.equal(lib.isVersionBefore('1.2', '1.3.0'), true);
  assert.equal(lib.isVersionBefore('0.9.99', '1.3.0'), true);
  assert.equal(lib.isVersionBefore('1.3.0', '1.3.0'), false);
  assert.equal(lib.isVersionBefore('1.3', '1.3.0'), false);
  assert.equal(lib.isVersionBefore('1.3.1', '1.3.0'), false);
  assert.equal(lib.isVersionBefore('1.10.0', '1.3.0'), false);
  assert.equal(lib.isVersionBefore('2.0', '1.3.0'), false);
});

test('shouldOfferWhatsNew: only an update from a version before 1.3.0', () => {
  assert.equal(lib.WHATS_NEW_VERSION, '1.3.0');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.2.1', temporary: false }), true);
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.2.1', temporary: true }), true, 'temporary loads are not skipped');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.3.0', temporary: true }), false, 'reload of the same version');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.3.1' }), false);
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'install', temporary: false }), false);
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'browser_update' }), false);
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update' }), false, 'no previousVersion');
  for (const v of [undefined, null, {}]) assert.equal(lib.shouldOfferWhatsNew(v), false);
});

test('formatShortcut: spaced, Option/Command/Control on macOS, Comma kept as a word', () => {
  assert.equal(lib.formatShortcut('Alt+Shift+Comma', false), 'Alt + Shift + Comma');
  assert.equal(lib.formatShortcut('Alt+Shift+L', true), 'Option + Shift + L');
  assert.equal(lib.formatShortcut('Ctrl+Shift+K', true), 'Command + Shift + K');
  assert.equal(lib.formatShortcut('MacCtrl+Shift+K', true), 'Control + Shift + K');
  assert.equal(lib.formatShortcut('Ctrl+Shift+K', false), 'Ctrl + Shift + K');
});

test('whatsNewLines: one line per command still on its new default', () => {
  const defaults = [{ name: 'toggle-extension', shortcut: 'Alt+Shift+L' }, { name: 'open-selected-tabs', shortcut: 'Alt+Shift+Comma' }];
  assert.deepEqual(lib.whatsNewLines(defaults, false), [
    'Turn Snap Linkit on or off: Alt + Shift + L', 'Open selected links: Alt + Shift + Comma',
  ]);
  assert.deepEqual(lib.whatsNewLines(defaults, true), [
    'Turn Snap Linkit on or off: Option + Shift + L', 'Open selected links: Option + Shift + Comma',
  ]);
  const oneCustom = [{ name: 'toggle-extension', shortcut: 'Alt+Shift+K' }, { name: 'open-selected-tabs', shortcut: 'Alt+Shift+Comma' }];
  assert.deepEqual(lib.whatsNewLines(oneCustom, false), ['Open selected links: Alt + Shift + Comma']);
  const cleared = [{ name: 'toggle-extension', shortcut: '' }, { name: 'open-selected-tabs', shortcut: 'Ctrl+Alt+P' }];
  assert.deepEqual(lib.whatsNewLines(cleared, false), []);
  assert.deepEqual(lib.whatsNewLines(undefined, false), []);
});

test('fitMenuAxis: menu that fits stays at the pointer, or moves back by its overflow, never past the margin', () => {
  assert.deepEqual(lib.fitMenuAxis(500, 257, 1000, 10), { pos: 500, max: null });   // room below the pointer
  assert.deepEqual(lib.fitMenuAxis(900, 257, 1000, 10), { pos: 733, max: null });   // 1000 - 10 - 257
  assert.deepEqual(lib.fitMenuAxis(0, 257, 1000, 10), { pos: 10, max: null });      // start edge
  assert.deepEqual(lib.fitMenuAxis(-40, 220, 1000, 10), { pos: 10, max: null });    // pointer outside the window
  assert.deepEqual(lib.fitMenuAxis(400, 257, 277, 10), { pos: 10, max: null });     // exactly fills space - 2 margins
});

test('fitMenuAxis: menu that fits the space but not the margins: margins shrink, no cap, no scroll', () => {
  assert.deepEqual(lib.fitMenuAxis(200, 217, 227, 10), { pos: 5, max: null });      // 4-item menu, 227 px window
  assert.deepEqual(lib.fitMenuAxis(0, 227, 227, 10), { pos: 0, max: null });        // exactly the space
});

test('fitMenuAxis: menu larger than the space is capped to space - 2 margins and pinned at the margin', () => {
  assert.deepEqual(lib.fitMenuAxis(200, 257, 227, 10), { pos: 10, max: 207 });
  assert.deepEqual(lib.fitMenuAxis(5, 306, 300, 10), { pos: 10, max: 280 });
  assert.deepEqual(lib.fitMenuAxis(150, 220, 200, 10), { pos: 10, max: 180 });     // width axis
  assert.deepEqual(lib.fitMenuAxis(0, 50, 10, 10), { pos: 10, max: 0 });           // degenerate: never negative
});

test('fitMenuAxis: result always lies inside the space; inside the margins unless only the shrunk margins fit (sweep)', () => {
  for (const space of [60, 227, 300, 326, 715, 1000]) {
    for (const size of [40, 217, 240.5, 257, 300, 306, 900]) {
      for (const start of [-50, 0, 5, space / 2, space - 5, space + 50]) {
        const { pos, max } = lib.fitMenuAxis(start, size, space, 10);
        const used = max === null ? size : max;
        const where = `space ${space} size ${size} start ${start}`;
        assert.ok(pos >= 0 && pos + used <= space + 1e-9, `outside: pos ${pos} end ${pos + used} ${where}`);
        if (size <= space - 20 || size > space) {
          assert.ok(pos >= 10 && pos + used <= space - 10 + 1e-9, `margin: pos ${pos} end ${pos + used} ${where}`);
        }
        assert.equal(max === null, size <= space, `capped iff larger than the space: ${where}`);
      }
    }
  }
});

test('clampMenuAxis: dragged menu stays at the wanted spot inside the margins, else clamps to them', () => {
  assert.equal(lib.clampMenuAxis(300, 220, 1000, 10), 300);
  assert.equal(lib.clampMenuAxis(-500, 220, 1000, 10), 10);
  assert.equal(lib.clampMenuAxis(5000, 220, 1000, 10), 770);         // 1000 - 10 - 220
  assert.equal(lib.clampMenuAxis(0, 207, 227, 10), 10);              // capped menu (P2-3): exactly one place
  assert.equal(lib.clampMenuAxis(50, 207, 227, 10), 10);
  // fits only with shrunk margins: equal margins of 3, as fitMenuAxis placed it (no room to move on this axis)
  assert.equal(lib.clampMenuAxis(-5, 221, 227, 10), 3);
  assert.equal(lib.clampMenuAxis(99, 221, 227, 10), 3);
});

test('clampMenuAxis: result always inside the space, and agrees with fitMenuAxis placements (sweep)', () => {
  for (const space of [60, 227, 300, 715, 1000]) {
    for (const size0 of [40, 187, 221, 257, 900]) {
      const { pos: placed, max } = lib.fitMenuAxis(space / 2, size0, space, 10);
      const size = max === null ? size0 : max;               // size after P2-3 placement
      assert.equal(lib.clampMenuAxis(placed, size, space, 10), placed, `placement kept: space ${space} size ${size}`);
      for (const want of [-1000, -1, 0, 7, space / 3, space - 1, space + 1000]) {
        const pos = lib.clampMenuAxis(want, size, space, 10);
        assert.ok(pos >= 0 && pos + size <= space + 1e-9, `space ${space} size ${size} want ${want} -> ${pos}`);
      }
    }
  }
});

test('RELEASE_ACTIONS: the four "When I let go" values, frozen', () => {
  assert.deepEqual([...lib.RELEASE_ACTIONS], ['open', 'openUnloaded', 'copyUrls', 'menu']);
  assert.ok(Object.isFrozen(lib.RELEASE_ACTIONS));
});

test('normalizeReleaseAction: known values kept, anything else is the default "open"', () => {
  for (const v of lib.RELEASE_ACTIONS) assert.equal(lib.normalizeReleaseAction(v), v);
  for (const v of [undefined, null, '', 'OPEN', 'Open in new tabs', 'copy', 'menu ', 0, 1, true, {}, ['menu']]) {
    assert.equal(lib.normalizeReleaseAction(v), 'open', JSON.stringify(v));
  }
});

test('dragModifierMode: Ctrl or Shift held as the drag starts = add, Alt = remove, nothing = fresh', () => {
  const k = (ctrlKey, shiftKey, altKey) => ({ ctrlKey, shiftKey, altKey });
  assert.equal(lib.dragModifierMode(k(false, false, false)), null);
  assert.equal(lib.dragModifierMode(k(true, false, false)), 'add');    // P2-9: Ctrl adds
  assert.equal(lib.dragModifierMode(k(false, true, false)), 'add');    // Shift still adds (unadvertised alias)
  assert.equal(lib.dragModifierMode(k(false, false, true)), 'remove');
  // Combinations keep their pre-P2-9 meaning: Shift, then Alt, win over Ctrl
  assert.equal(lib.dragModifierMode(k(true, true, false)), 'add');
  assert.equal(lib.dragModifierMode(k(false, true, true)), 'add');
  assert.equal(lib.dragModifierMode(k(true, false, true)), 'remove'); // Ctrl+Alt (AltGr on many layouts) stays remove
  assert.equal(lib.dragModifierMode(k(true, true, true)), 'add');
  // metaKey (Windows/Command key) is not a modifier here
  assert.equal(lib.dragModifierMode({ metaKey: true }), null);
  for (const v of [undefined, null, {}]) assert.equal(lib.dragModifierMode(v), null);
});
