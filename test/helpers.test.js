'use strict';
// Unit tests for src/lib/helpers.js. Zero dependencies: node:test + node:assert.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib/helpers.js');

test('SnapLinkitLib exposes every helper and is frozen', () => {
  assert.deepEqual(Object.keys(lib).sort(), [
    'DOWNLOAD_EXTENSIONS', 'OPENABLE_PROTOCOLS', 'RELEASE_ACTIONS', 'WHATS_NEW_SHORTCUTS', 'WHATS_NEW_VERSION',
    'TRACKED_CHECKBOX_SELECTOR', 'TRACKED_TABLE_SELECTOR', 'afterClickOutcome', 'blacklistBytes', 'carefulCheckboxMessage', 'carefulConfirmText',
    'carefulProgressMessage', 'carefulFallbackMessage', 'carefulNotStartedMessage', 'clampMenuAxis', 'faultMatches', 'dragModifierMode', 'filenameFromUrl', 'fitMenuAxis', 'formatDurationEstimate', 'formatShortcut',
    'isDownloadableUrl', 'isOpenableUrl', 'isStyleHidden', 'isTrackedCheckbox', 'isValidPattern', 'isVersionBefore', 'majorityShouldCheck',
    'matchesPattern', 'normalizeReleaseAction', 'ordinaryCheckboxMessage', 'ordinaryUnreadMessage', 'plural',
    'proxyLabelIndexes', 'rectsIntersect', 'selectionRect', 'rectFromPoints', 'dragStartPoint', 'uniqueMatch', 'firstUsableAnchor', 'dragPageChangedMessage', 'dragStartFailedMessage', 'DRAG_OFF_REASONS', 'DRAG_ENDS', 'dragDiagName', 'dragDiagPx', 'dragDiagLine', 'DRAG_EXTRAS', 'anchorLostOutcome', 'dragFollowNeeded', 'trackingLock', 'fixedContainerAllows', 'autoScrollStep', 'autoScrollZone', 'AUTO_SCROLL_CREEP', 'AUTO_SCROLL_CAP', 'autoScrollRate', 'autoScrollDelta', 'clampToArea', 'liveCountText', 'selectableVerdict', 'labelMapFrom', 'touchesSelection', 'onlyOwnClassChange', 'pageChangeMarksStale', 'shouldOfferWhatsNew', 'whatsNewLines', 'whatsNewRecord', 'whatsNewShowsShortcuts',
  ].sort());
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

// Brief 3: the drag start tied to the pressed element (BRIEF-3-DESIGN.md 4.1)
test('dragStartPoint U1: no layout change, the anchored start equals the old scroll maths', () => {
  // Pressed at (40, 300) on an element whose box was at (20, 280); the page has since scrolled 500 down, so with
  // nothing else changing the element's box is now at (20, -220)
  const start = { x: 40, y: 300, scrollX: 0, scrollY: 0 };
  const scroll = { x: 0, y: 500 };
  const anchored = lib.dragStartPoint({ offX: 20, offY: 20 }, { left: 20, top: -220 }, scroll, start);
  const old = lib.dragStartPoint(null, null, scroll, start);
  assert.deepEqual(anchored, old);
  assert.deepEqual(anchored, { x: 40, y: -200 });
});

test('dragStartPoint U2/U3: content above shrinks or grows by 350: the start follows the element', () => {
  const start = { x: 40, y: 300, scrollX: 0, scrollY: 0 };
  const scroll = { x: 0, y: 500 };
  // Shrink: the element is 350 higher than scrolling alone would put it
  assert.deepEqual(lib.dragStartPoint({ offX: 20, offY: 20 }, { left: 20, top: -570 }, scroll, start), { x: 40, y: -550 });
  // Grow: 350 lower
  assert.deepEqual(lib.dragStartPoint({ offX: 20, offY: 20 }, { left: 20, top: 130 }, scroll, start), { x: 40, y: 150 });
  // The old maths would have stayed at y = -200 in both cases (the bug)
  assert.deepEqual(lib.dragStartPoint(null, null, scroll, start), { x: 40, y: -200 });
});

test('dragStartPoint U4: an anchor without a box is a caller error, not a silent fallback', () => {
  assert.throws(() => lib.dragStartPoint({ offX: 1, offY: 1 }, null, { x: 0, y: 0 }, { x: 0, y: 0, scrollX: 0, scrollY: 0 }),
    /no box/);
});

test('uniqueMatch U5: only an unambiguous match counts', () => {
  assert.equal(lib.uniqueMatch([]), null);
  assert.equal(lib.uniqueMatch(['a']), 'a');
  assert.equal(lib.uniqueMatch(['a', 'b']), null);
  assert.equal(lib.uniqueMatch(null), null);
});

test('dragStartPoint U6: no anchor gives exactly what selectionRect used before brief 3', () => {
  const cases = [
    [{ x: 10, y: 100, scrollX: 0, scrollY: 0 }, { x: 0, y: 40 }],
    [{ x: 100, y: 10, scrollX: 20, scrollY: 0 }, { x: 50, y: 0 }],
    [{ x: 7.5, y: 3.25, scrollX: 1.5, scrollY: 2.75 }, { x: 0.5, y: 900.125 }],
  ];
  for (const [start, scroll] of cases) {
    assert.deepEqual(lib.dragStartPoint(null, null, scroll, start),
      { x: start.x - (scroll.x - start.scrollX), y: start.y - (scroll.y - start.scrollY) });
  }
});

test('dragStartPoint U7: the pointer offset inside the element is kept', () => {
  // Pressed 30 px below the element's top and 12 px in from its left
  assert.deepEqual(lib.dragStartPoint({ offX: 12, offY: 30 }, { left: 100, top: 200 }, { x: 0, y: 0 },
    { x: 0, y: 0, scrollX: 0, scrollY: 0 }), { x: 112, y: 230 });
});

test('rectFromPoints U8: either way round, same as selectionRect without scroll', () => {
  const r = { left: 10, top: 10, right: 50, bottom: 30, width: 40, height: 20 };
  assert.deepEqual(lib.rectFromPoints({ x: 10, y: 10 }, { x: 50, y: 30 }), r);
  assert.deepEqual(lib.rectFromPoints({ x: 50, y: 30 }, { x: 10, y: 10 }), r);
  assert.deepEqual(lib.selectionRect({ x: 50, y: 30, scrollX: 0, scrollY: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }), r);
});

// Brief 5b: the fallback chain. Candidates are plain objects; `map` follows .mapped, `usable` reads .ok.
const chain = (cands) => lib.firstUsableAnchor(cands, {
  isStop: (c) => !!c.stop, map: (c) => c.mapped || c, usable: (c) => !!c.ok,
});

test('firstUsableAnchor: the mapped element (label or link) comes before the candidate itself', () => {
  const label = { name: 'label', ok: true };
  const hit = { name: 'hit', ok: true, mapped: label };
  assert.equal(chain([hit]), label);
});

test('firstUsableAnchor: the candidate itself when its mapped element is unusable (e.g. a display:contents link)', () => {
  const link = { name: 'link', ok: false };
  const span = { name: 'span', ok: true, mapped: link };
  assert.equal(chain([span]), span);
});

test('firstUsableAnchor: unusable candidates are skipped, in order (fixed/sticky or 0x0)', () => {
  const sticky = { name: 'sticky', ok: false };
  const a16 = { name: 'a16', ok: true };
  const a17 = { name: 'a17', ok: true };
  assert.equal(chain([sticky, sticky, a16, a17]), a16);
});

test('firstUsableAnchor: stops at <html>/<body> (null: the old maths), even with usable candidates after it', () => {
  const sticky = { name: 'sticky', ok: false };
  const body = { name: 'body', stop: true, ok: true };
  const later = { name: 'later', ok: true };
  assert.equal(chain([sticky, body, later]), null);
  assert.equal(chain([]), null);
  assert.equal(chain([sticky]), null);
});

test('firstUsableAnchor: lazy, nothing after the winner is read (the point is asked only when needed)', () => {
  const read = [];
  function* cands() {
    for (const c of [{ name: 'hit', ok: true }, { name: 'never', ok: true }]) { read.push(c.name); yield c; }
  }
  assert.equal(chain(cands()).name, 'hit');
  assert.deepEqual(read, ['hit']);
});

test('styles.css: Snap Linkit\'s own UI is position: fixed, so the fallback chain never anchors to it (brief 5b)', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const UI = ['lasso', 'menu', 'toast', 'confirm', 'confirm-overlay'];
  const seen = Object.fromEntries(UI.map((c) => [c, []]));
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const positions = [...m[2].matchAll(/(?:^|[;\s])position\s*:\s*([^;]+)/g)].map((x) => x[1].trim());
    for (const sel of m[1].split(',')) {
      const subject = sel.trim().split(/[\s>+~]+/).pop();
      const hit = /^\.snaplinkit-([a-z-]+?)(?=$|[.:[])/.exec(subject);
      if (hit && hit[1] in seen) seen[hit[1]].push(...positions);
    }
  }
  for (const c of UI) assert.deepEqual([...new Set(seen[c])], ['fixed'], `.snaplinkit-${c}: ${JSON.stringify(seen[c])}`);
});

test('dragPageChangedMessage: the on-screen text of decision 2', () => {
  assert.equal(lib.dragPageChangedMessage(), 'The page changed under the drag; drag again.');
});

test('dragStartFailedMessage: the on-screen text Rob approved for a failed drag start (brief 5)', () => {
  assert.equal(lib.dragStartFailedMessage(), "Snap Linkit couldn't start this selection; drag again.");
});

// Brief 4: the test-build drag line (one per drag)
const DIAG = {
  n: 1, end: 'release', protection: 'on', anchor: 'label', key: 'row', refind: 'none', pressed: 'Master Support (Legacy)',
  moved: 0, gap: 0, selected: 80, boxes: 80, links: 0, first: 'Master Support (Legacy)', last: 'Inspiring',
  updates: 76, slowest: 212.4, scrollPause: 1810.2, rebuilds: 0,
};
const DIAG_RE = /^\[Snap Linkit\] drag (\d+): (.*)$/;
const diagFields = (line) => Object.fromEntries([...DIAG_RE.exec(line)[2].matchAll(/(\w+)=("[^"]*"|\S+)/g)].map((m) => [m[1], m[2]]));

test('dragDiagLine: the exact line for a normal drag', () => {
  assert.equal(lib.dragDiagLine(DIAG),
    '[Snap Linkit] drag 1: end=release protection=on anchor=label key=row refind=none pressed="Master Support (Legacy)" ' +
    'moved=0px gap=0px selected=80 boxes=80 links=0 first="Master Support (Legacy)" last="Inspiring" ' +
    'updates=76 slowest=212ms scrollPause=1810ms rebuilds=0');
});

test('dragDiagLine: every end and every protection value', () => {
  assert.deepEqual([...lib.DRAG_ENDS], ['release', 'esc', 'page-changed', 'switched-off', 'replaced', 'start-failed']);
  for (const end of lib.DRAG_ENDS) assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, end })).end, end);
  assert.deepEqual({ ...lib.DRAG_OFF_REASONS },
    { fixedOrSticky: 'fixed-or-sticky', noBox: 'no-box', noElement: 'no-element', threw: 'threw' });
  assert.ok(Object.isFrozen(lib.DRAG_OFF_REASONS) && Object.isFrozen(lib.DRAG_ENDS));
  for (const protection of ['on', ...Object.values(lib.DRAG_OFF_REASONS).flatMap((r) => ['off:' + r, 'on:' + r])]) {
    assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, protection })).protection, protection);
  }
});

test('dragDiagLine: the exact line for a drag whose start failed (brief 5)', () => {
  assert.equal(lib.dragDiagLine({ ...DIAG, end: 'start-failed', protection: 'off:threw', anchor: 'none', key: 'none', pressed: 'a',
    moved: 0, gap: null, selected: 0, boxes: 0, links: 0, first: null, last: null, updates: 0, slowest: 0, scrollPause: 0 }),
    '[Snap Linkit] drag 1: end=start-failed protection=off:threw anchor=none key=none refind=none pressed="a" ' +
    'moved=0px gap=n/a selected=0 boxes=0 links=0 first="" last="" updates=0 slowest=0ms scrollPause=0ms rebuilds=0');
});

test('dragDiagLine: anchor, key and re-find values', () => {
  for (const anchor of ['label', 'link', 'element', 'none']) assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, anchor })).anchor, anchor);
  for (const key of ['row', 'id', 'link', 'none']) assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, key })).key, key);
  for (const refind of ['none', 'found:1', 'found:12', 'cancelled']) assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, refind })).refind, refind);
});

test('dragDiagName: quoting, whitespace and truncation at 40 characters', () => {
  assert.equal(lib.dragDiagName('Say "hi"'), '"Say \'hi\'"');
  assert.equal(lib.dragDiagName('  a\n  b  '), '"a b"');
  assert.equal(lib.dragDiagName(null), '""');
  assert.equal(lib.dragDiagName(undefined), '""');
  assert.equal(lib.dragDiagName('x'.repeat(40)), `"${'x'.repeat(40)}"`);
  assert.equal(lib.dragDiagName('x'.repeat(41)), `"${'x'.repeat(40)}\u2026"`);
  assert.equal(lib.dragDiagName('div.wds-checkbox'), '"div.wds-checkbox"');
});

test('dragDiagPx: signs, rounding and n/a', () => {
  assert.equal(lib.dragDiagPx(350), '+350px');
  assert.equal(lib.dragDiagPx(-350), '-350px');
  assert.equal(lib.dragDiagPx(0), '0px');
  assert.equal(lib.dragDiagPx(-0.4), '0px');
  assert.equal(lib.dragDiagPx(0.6), '+1px');
  assert.equal(lib.dragDiagPx(-349.6), '-350px');
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(lib.dragDiagPx(v), 'n/a');
  const f = diagFields(lib.dragDiagLine({ ...DIAG, moved: -350, gap: 350 }));
  assert.equal(f.moved, '-350px'); assert.equal(f.gap, '+350px');
  const na = diagFields(lib.dragDiagLine({ ...DIAG, moved: null, gap: null, first: null, last: null, selected: 0, boxes: 0 }));
  assert.equal(na.moved, 'n/a'); assert.equal(na.gap, 'n/a'); assert.equal(na.first, '""'); assert.equal(na.selected, '0');
});

test('dragDiagLine: values outside the documented sets throw (the caller reports "drag line failed")', () => {
  const bad = [
    { n: 0 }, { n: 1.5 }, { end: 'cancel' }, { protection: 'off' }, { protection: 'off:unknown' }, { protection: 'yes' },
    { protection: 'on:' }, { protection: 'on:unknown' }, { protection: 'on:off:no-box' },
    { anchor: 'div' }, { key: 'tracked' }, { refind: 'found:0' }, { refind: 'found' }, { selected: -1 }, { boxes: 1.5 },
    { links: undefined }, { updates: null }, { slowest: -1 }, { scrollPause: NaN },
    { rebuilds: -1 }, { rebuilds: 1.5 }, { rebuilds: undefined },
  ];
  for (const b of bad) assert.throws(() => lib.dragDiagLine({ ...DIAG, ...b }), /^Error: dragDiagLine: bad /, JSON.stringify(b));
});

test('dragDiagLine: the agreed regex parses every field, in the fixed order', () => {
  const line = lib.dragDiagLine({ ...DIAG, n: 12, end: 'page-changed', protection: 'off:threw', anchor: 'none', key: 'none',
    refind: 'cancelled', pressed: 'Master "Support"', moved: null, gap: 350, first: 'Master Marksman' });
  const m = DIAG_RE.exec(line);
  assert.equal(m[1], '12');
  assert.deepEqual(Object.keys(diagFields(line)), ['end', 'protection', 'anchor', 'key', 'refind', 'pressed', 'moved', 'gap',
    'selected', 'boxes', 'links', 'first', 'last', 'updates', 'slowest', 'scrollPause', 'rebuilds']);
  assert.equal(diagFields(line).pressed, '"Master \'Support\'"');
});

test('dragDiagLine: later fields only when passed, in DRAG_EXTRAS order (A1: follows)', () => {
  assert.deepEqual(lib.DRAG_EXTRAS.map(([k]) => k).slice(0, 1), ['follows']);
  assert.ok(Object.isFrozen(lib.DRAG_EXTRAS));
  assert.doesNotMatch(lib.dragDiagLine(DIAG), /follows=/);
  assert.match(lib.dragDiagLine({ ...DIAG, follows: 0 }), / rebuilds=0 follows=0$/);
  assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, follows: 12 })).follows, '12');
  for (const follows of [-1, 1.5, null, 'x']) assert.throws(() => lib.dragDiagLine({ ...DIAG, follows }), /^Error: dragDiagLine: bad follows/);
});

test('dragFollowNeeded (A1): a new update when the window scrolled since the last one, or a box inside the page did', () => {
  assert.equal(lib.dragFollowNeeded({ x: 0, y: 100 }, { x: 0, y: 100 }, false), false);
  assert.equal(lib.dragFollowNeeded({ x: 0, y: 100 }, { x: 0, y: 400 }, false), true);
  assert.equal(lib.dragFollowNeeded({ x: 0, y: 100 }, { x: 30, y: 100 }, false), true);
  assert.equal(lib.dragFollowNeeded({ x: 0, y: 100 }, { x: 0, y: 100 }, true), true);
  assert.equal(lib.dragFollowNeeded(null, { x: 0, y: 0 }, false), true);
});

test('trackingLock (B): a press on the box, its label or anywhere in its cell locks the drag to tracking boxes', () => {
  assert.equal(lib.trackingLock({ isTrackedBox: true }), true);
  assert.equal(lib.trackingLock({ labelsTrackedBox: true }), true);
  assert.equal(lib.trackingLock({ cellHasTrackedBox: true }), true);
  assert.equal(lib.trackingLock({ isTrackedBox: false, labelsTrackedBox: false, cellHasTrackedBox: false }), false);
  assert.equal(lib.trackingLock(null), false);
  assert.equal(lib.trackingLock({ cellHasTrackedBox: 'yes' }), false);
});

test('dragDiagLine: lock=tracking|none after follows (B)', () => {
  assert.deepEqual(lib.DRAG_EXTRAS.map(([k]) => k).slice(0, 2), ['follows', 'lock']);
  assert.match(lib.dragDiagLine({ ...DIAG, follows: 2, lock: 'tracking' }), / rebuilds=0 follows=2 lock=tracking$/);
  assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, follows: 0, lock: 'none' })).lock, 'none');
  for (const lock of ['yes', '', true]) assert.throws(() => lib.dragDiagLine({ ...DIAG, lock }), /^Error: dragDiagLine: bad lock/);
});

test('fixedContainerAllows (C): an element in a fixed container only when the drag was pressed inside it', () => {
  assert.equal(lib.fixedContainerAllows({ inFixed: false, pressedInside: false }), true);
  assert.equal(lib.fixedContainerAllows({ inFixed: true, pressedInside: true }), true);
  assert.equal(lib.fixedContainerAllows({ inFixed: true, pressedInside: false }), false);
  assert.equal(lib.fixedContainerAllows({ inFixed: true }), false);
  assert.equal(lib.fixedContainerAllows(null), true);
});

test('dragDiagLine: fixedOut after lock (C)', () => {
  assert.deepEqual(lib.DRAG_EXTRAS.map(([k]) => k).slice(0, 4), ['follows', 'lock', 'fixedOut', 'topSpeed']);
  assert.match(lib.dragDiagLine({ ...DIAG, follows: 0, lock: 'none', fixedOut: 2 }), / follows=0 lock=none fixedOut=2$/);
  assert.throws(() => lib.dragDiagLine({ ...DIAG, fixedOut: -1 }), /^Error: dragDiagLine: bad fixedOut/);
});

test('anchorLostOutcome (ultrareview 1, #1): only a drag locked to tracking boxes is cancelled; any other carries on', () => {
  assert.equal(lib.anchorLostOutcome({ trackLock: true }), 'cancel');
  assert.equal(lib.anchorLostOutcome({ trackLock: false }), 'carry-on');
  assert.equal(lib.anchorLostOutcome({}), 'carry-on');
  assert.equal(lib.anchorLostOutcome(null), 'carry-on');
  assert.equal(lib.anchorLostOutcome({ trackLock: 'yes' }), 'carry-on'); // only a real true locks
});

test('dragDiagLine: carried=no|last-seen, the last field (ultrareview 1, #1)', () => {
  assert.deepEqual(lib.DRAG_EXTRAS.map(([k]) => k), ['follows', 'lock', 'fixedOut', 'topSpeed', 'carried']);
  assert.match(lib.dragDiagLine({ ...DIAG, follows: 0, lock: 'none', fixedOut: 0, topSpeed: 739, carried: 'last-seen' }),
    / follows=0 lock=none fixedOut=0 topSpeed=739 carried=last-seen$/);
  assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, carried: 'no' })).carried, 'no');
  assert.doesNotMatch(lib.dragDiagLine(DIAG), /carried=/);
  for (const carried of ['yes', 'press', '', true, 1]) assert.throws(() => lib.dragDiagLine({ ...DIAG, carried }), /^Error: dragDiagLine: bad carried/);
});

test('dragDiagLine: the agreed regex parses a full line, every later field in DRAG_EXTRAS order', () => {
  const line = lib.dragDiagLine({ ...DIAG, end: 'release', anchor: 'link', key: 'link', refind: 'found:2',
    follows: 3, lock: 'none', fixedOut: 1, topSpeed: 1250, carried: 'last-seen' });
  const f = diagFields(line);
  assert.deepEqual(Object.keys(f), ['end', 'protection', 'anchor', 'key', 'refind', 'pressed', 'moved', 'gap',
    'selected', 'boxes', 'links', 'first', 'last', 'updates', 'slowest', 'scrollPause', 'rebuilds',
    ...lib.DRAG_EXTRAS.map(([k]) => k)]);
  assert.deepEqual([f.follows, f.lock, f.fixedOut, f.topSpeed, f.carried], ['3', 'none', '1', '1250', 'last-seen']);
});

test('autoScrollStep: both directions, always instant (brief 7b)', () => {
  assert.deepEqual(lib.autoScrollStep(0, 15), { left: 0, top: 15, behavior: 'instant' });
  assert.deepEqual(lib.autoScrollStep(-15, 0), { left: -15, top: 0, behavior: 'instant' });
  assert.deepEqual(lib.autoScrollStep(30, -30), { left: 30, top: -30, behavior: 'instant' });
  assert.deepEqual(Object.keys(lib.autoScrollStep(1, 2)).sort(), ['behavior', 'left', 'top']);
});

test('autoScrollZone (A2): the setting at 1.5 device px per CSS px, bigger when pixels are smaller, never smaller', () => {
  assert.equal(lib.autoScrollZone(50, 1.5), 50);   // 100% zoom on a 150% display: today's zone
  assert.equal(lib.autoScrollZone(50, 0.6), 125);  // 40% zoom on it: the same size on screen
  assert.equal(lib.autoScrollZone(50, 1), 75);     // a 100% display
  assert.equal(lib.autoScrollZone(50, 3), 50);     // never smaller than the setting
  assert.equal(lib.autoScrollZone(100, 0.75), 200);
  for (const dpr of [undefined, 0, NaN, -1]) assert.equal(lib.autoScrollZone(50, dpr), 75, String(dpr)); // unknown: as at 1
});

test('autoScrollRate (A2): a creep at the zone border, today\'s speed at the edge, faster past it, capped', () => {
  const E = 937.5, Z = 50, W = 1000; // edge speed (15 px per 16 ms), zone, window
  assert.equal(lib.autoScrollRate(500, W, Z, E), 0);                    // outside the zone
  assert.equal(lib.autoScrollRate(W - Z, W, Z, E), 0);                  // its inner border: not yet
  assert.ok(Math.abs(lib.autoScrollRate(W - Z + 1e-9, W, Z, E) - E * lib.AUTO_SCROLL_CREEP) < 1e-6); // just inside: the creep
  assert.equal(lib.autoScrollRate(W, W, Z, E), E);                      // at the edge: exactly today's speed
  const mid = lib.autoScrollRate(W - Z / 2, W, Z, E);
  assert.ok(mid > E * lib.AUTO_SCROLL_CREEP && mid < E);                // grows with depth
  assert.equal(lib.autoScrollRate(W + Z / 2, W, Z, E), E * 2);          // half a zone past the edge
  assert.equal(lib.autoScrollRate(W + Z, W, Z, E), E * lib.AUTO_SCROLL_CAP);
  assert.equal(lib.autoScrollRate(W + 10 * Z, W, Z, E), E * lib.AUTO_SCROLL_CAP); // capped
  assert.equal(lib.autoScrollRate(0, W, Z, E), -E);                     // top edge: upwards, same rule
  assert.equal(lib.autoScrollRate(-Z, W, Z, E), -E * lib.AUTO_SCROLL_CAP);
  let prev = 0;
  for (let p = W - Z + 1; p <= W + 2 * Z; p += 5) { const r = lib.autoScrollRate(p, W, Z, E); assert.ok(r >= prev, String(p)); prev = r; }
  assert.equal(lib.autoScrollRate(W, W, 0, E), 0);
  assert.equal(lib.autoScrollRate(W, W, Z, 0), 0);
});

test('autoScrollDelta (A2): whole pixels per tick, the fraction carried', () => {
  assert.deepEqual(lib.autoScrollDelta(1000, 16, 0), { px: 16, carry: 0 });
  let carry = 0, total = 0;
  for (let i = 0; i < 10; i++) { const d = lib.autoScrollDelta(140.625, 16, carry); total += d.px; carry = d.carry; }
  assert.equal(total, 22); // 140.625 px/s for 160 ms = 22.5 px: 22 whole, 0.5 carried
  assert.ok(Math.abs(carry - 0.5) < 1e-9);
  const up = lib.autoScrollDelta(-1000, 16, 0);
  assert.equal(up.px, -16);
  assert.equal(lib.autoScrollDelta(0, 16, 0).px, 0);
});

test('clampToArea (A2): the pointer end held inside the visible window', () => {
  const A = { width: 1000, height: 800 };
  assert.deepEqual(lib.clampToArea({ x: 500, y: 400 }, A), { x: 500, y: 400 });
  assert.deepEqual(lib.clampToArea({ x: 1200, y: 1100 }, A), { x: 1000, y: 800 });
  assert.deepEqual(lib.clampToArea({ x: -50, y: -10 }, A), { x: 0, y: 0 });
});

test('liveCountText: what a release would act on; links win; singular and plural', () => {
  assert.equal(lib.liveCountText({ links: 3, boxes: 16, radios: 0 }), '3 links');
  assert.equal(lib.liveCountText({ links: 1 }), '1 link');
  assert.equal(lib.liveCountText({ links: 0, boxes: 16 }), '16 boxes');
  assert.equal(lib.liveCountText({ links: 0, boxes: 1 }), '1 box');
  assert.equal(lib.liveCountText({ links: 0, boxes: 0, radios: 2 }), '2 radio buttons');
  assert.equal(lib.liveCountText({ links: 0, boxes: 0, radios: 1 }), '1 radio button');
  assert.equal(lib.liveCountText({ links: 0, boxes: 0, radios: 0 }), '');
});

test('dragDiagLine: rebuilds, the last field (brief 7)', () => {
  assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, rebuilds: 0 })).rebuilds, '0');
  assert.equal(diagFields(lib.dragDiagLine({ ...DIAG, rebuilds: 3 })).rebuilds, '3');
  assert.match(lib.dragDiagLine({ ...DIAG, rebuilds: 2 }), / scrollPause=1810ms rebuilds=2$/);
});

// Brief 7: the drag's element cache (pure parts)
const SEL = { hidden: false, hasProxyLabels: false, isSvgLink: false, isLink: false, rawHref: null, openable: false };

test('selectableVerdict: today\'s rules for inputs, buttons and roles', () => {
  assert.equal(lib.selectableVerdict(SEL), true);
  assert.equal(lib.selectableVerdict({ ...SEL, hidden: true }), false);
  assert.equal(lib.selectableVerdict({ ...SEL, hidden: true, hasProxyLabels: true }), true); // a hidden checkbox shown by its label
});

test('selectableVerdict: links (fragments, unopenable, SVG) as getSelectableElements did', () => {
  const link = { ...SEL, isLink: true, rawHref: 'https://a.b/x', openable: true };
  assert.equal(lib.selectableVerdict(link), true);
  for (const rawHref of ['', '   ', '#top', '  #x', null]) assert.equal(lib.selectableVerdict({ ...link, rawHref }), false, String(rawHref));
  assert.equal(lib.selectableVerdict({ ...link, openable: false }), false); // javascript:, mailto:, ...
  assert.equal(lib.selectableVerdict({ ...SEL, isSvgLink: true }), false);
  assert.equal(lib.selectableVerdict({ ...link, hidden: true }), false); // a hidden link: no label stands in for it
});

test('labelMapFrom: each control\'s labels in document order (the inverse of label.control)', () => {
  const [a, b, l1, l2, l3, l4] = ['a', 'b', 'l1', 'l2', 'l3', 'l4'].map((n) => ({ n }));
  const m = lib.labelMapFrom([[l1, a], [l2, null], [l3, b], [l4, a]]);
  assert.deepEqual(m.get(a), [l1, l4]);
  assert.deepEqual(m.get(b), [l3]);
  assert.equal(m.size, 2); // a label without a control belongs to nothing
  assert.equal(lib.labelMapFrom([]).size, 0);
});

test('touchesSelection: own box, else a label\'s box; the labels are read only when needed', () => {
  const box = { left: 0, top: 0, right: 100, bottom: 100 };
  const inside = { left: 10, top: 10, right: 20, bottom: 20 };
  const outside = { left: 200, top: 200, right: 220, bottom: 220 };
  let asked = 0;
  const labels = (rects) => () => { asked++; return rects; };
  assert.equal(lib.touchesSelection(box, inside, labels([outside])), true);
  assert.equal(asked, 0); // the own box touches: labels not read
  assert.equal(lib.touchesSelection(box, outside, labels([outside, inside])), true); // a 0x0 Fandom input, its label inside
  assert.equal(lib.touchesSelection(box, outside, labels([outside])), false);
  assert.equal(lib.touchesSelection(box, outside, labels([])), false);
});

test('onlyOwnClassChange: only snaplinkit-* classes changed', () => {
  assert.equal(lib.onlyOwnClassChange('row', 'row snaplinkit-highlighted'), true);
  assert.equal(lib.onlyOwnClassChange('snaplinkit-highlighted a', 'a'), true);
  assert.equal(lib.onlyOwnClassChange(null, 'snaplinkit-selecting'), true);
  assert.equal(lib.onlyOwnClassChange('row', 'row'), true);
  assert.equal(lib.onlyOwnClassChange('row', 'row hidden'), false);
  assert.equal(lib.onlyOwnClassChange('row is-saving', 'row snaplinkit-highlighted'), false);
  assert.equal(lib.onlyOwnClassChange('', 'x'), false);
});

test('pageChangeMarksStale: page changes count, Snap Linkit\'s own never', () => {
  const R = { type: 'childList', inUi: false, nodesAllUi: false, attributeName: null, oldValue: null, newValue: null };
  assert.equal(lib.pageChangeMarksStale(R), true); // nodes added or removed by the page
  assert.equal(lib.pageChangeMarksStale({ ...R, nodesAllUi: true }), false); // the lasso, menu, toast or confirm added to <body>
  assert.equal(lib.pageChangeMarksStale({ ...R, inUi: true }), false); // inside Snap Linkit's UI
  const A = { ...R, type: 'attributes' };
  for (const attributeName of ['style', 'hidden', 'type', 'href', 'role']) assert.equal(lib.pageChangeMarksStale({ ...A, attributeName }), true, attributeName);
  assert.equal(lib.pageChangeMarksStale({ ...A, attributeName: 'class', oldValue: 'a', newValue: 'a snaplinkit-highlighted' }), false);
  assert.equal(lib.pageChangeMarksStale({ ...A, attributeName: 'class', oldValue: 'a', newValue: 'a collapsed' }), true);
  assert.equal(lib.pageChangeMarksStale({ ...A, inUi: true, attributeName: 'style' }), false); // the lasso being drawn
  assert.equal(lib.pageChangeMarksStale({}), true); // anything not understood counts (one rebuild, never a wrong selection)
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

test('shouldOfferWhatsNew: only an update from a version before 1.4.0', () => {
  assert.equal(lib.WHATS_NEW_VERSION, '1.4.0');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.2.1', temporary: false }), true);
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.2.1', temporary: true }), true, 'temporary loads are not skipped');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.3.0' }), true, 'every 1.3.x user gets the 1.4.0 note');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.3.9' }), true);
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.4.0', temporary: true }), false, 'reload of the same version');
  assert.equal(lib.shouldOfferWhatsNew({ reason: 'update', previousVersion: '1.4.1' }), false);
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

test('whatsNewRecord: 1.4.0 note with the badge; shortcut lines only from before 1.3.0 or a pending 1.3.0 note', () => {
  assert.deepEqual(lib.whatsNewRecord('1.3.0', undefined), { version: '1.4.0', badge: true, shortcuts: false });
  assert.deepEqual(lib.whatsNewRecord('1.3.5', null), { version: '1.4.0', badge: true, shortcuts: false });
  assert.deepEqual(lib.whatsNewRecord('1.2.1', undefined), { version: '1.4.0', badge: true, shortcuts: true });
  assert.deepEqual(lib.whatsNewRecord('1.0', undefined), { version: '1.4.0', badge: true, shortcuts: true });
  assert.deepEqual(lib.whatsNewRecord('1.3.0', { version: '1.3.0', badge: false }), { version: '1.4.0', badge: true, shortcuts: true },
    'a 1.3.0 note never dismissed keeps its shortcut lines');
  assert.deepEqual(lib.whatsNewRecord('1.3.0', { version: '1.4.0', badge: false, shortcuts: false }), { version: '1.4.0', badge: true, shortcuts: false });
});

test('whatsNewShowsShortcuts: shortcuts flag, or a record written by 1.3.0', () => {
  assert.equal(lib.whatsNewShowsShortcuts({ version: '1.4.0', badge: true, shortcuts: true }), true);
  assert.equal(lib.whatsNewShowsShortcuts({ version: '1.4.0', badge: true, shortcuts: false }), false);
  assert.equal(lib.whatsNewShowsShortcuts({ version: '1.3.0', badge: false }), true);
  for (const v of [undefined, null, {}, { shortcuts: 'yes' }]) assert.equal(lib.whatsNewShowsShortcuts(v), false);
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

test('isStyleHidden: display none, visibility hidden or opacity 0 draw nothing', () => {
  const base = { display: 'block', visibility: 'visible', opacity: '1' };
  assert.equal(lib.isStyleHidden(base), false);
  assert.equal(lib.isStyleHidden({ ...base, display: 'none' }), true);
  assert.equal(lib.isStyleHidden({ ...base, visibility: 'hidden' }), true);
  assert.equal(lib.isStyleHidden({ ...base, opacity: '0' }), true);
  assert.equal(lib.isStyleHidden({ ...base, opacity: '0.5' }), false);
});

test('proxyLabelIndexes: a hidden checkbox is stood in for by its visible labels (issue #1)', () => {
  const box = (w, h, hidden = false) => ({ hidden, rect: { width: w, height: h } });
  // Fandom progress table: input opacity 0 and 0x0, empty <label for> filling the cell
  assert.deepEqual(lib.proxyLabelIndexes(box(0, 0, true), [box(24, 24)]), [0]);
  // display:none input inside a wrapping label
  assert.deepEqual(lib.proxyLabelIndexes(box(0, 0, true), [box(120, 20)]), [0]);
  // visible but 0x0 input with a visible label
  assert.deepEqual(lib.proxyLabelIndexes(box(0, 0), [box(24, 24)]), [0]);
  // only the labels that show count; order is kept
  assert.deepEqual(lib.proxyLabelIndexes(box(0, 0, true), [box(24, 24, true), box(0, 0), box(30, 10), box(5, 5)]), [2, 3]);
  // a visible input is used as itself, even with a visible label (no behaviour change)
  assert.deepEqual(lib.proxyLabelIndexes(box(13, 13), [box(80, 18)]), []);
  // hidden input without a visible label stays unselectable
  assert.deepEqual(lib.proxyLabelIndexes(box(0, 0, true), []), []);
  assert.deepEqual(lib.proxyLabelIndexes(box(0, 0, true), [box(0, 0)]), []);
});

// ---- Brief 2: careful saving of Fandom tracking checkboxes ----

test('tracked-checkbox selectors are Fandom\'s own (July 2026 CHECKBOX_SELECTOR and table attribute)', () => {
  assert.equal(lib.TRACKED_CHECKBOX_SELECTOR, 'input[type="checkbox"][data-tpt-row-id][data-table-id]');
  assert.equal(lib.TRACKED_TABLE_SELECTOR, 'table[data-tpt-id]');
});

test('isTrackedCheckbox: Fandom markup on any host; Telepedia data-row-id, plain checkboxes and radios are not', () => {
  const fandom = { tagName: 'input', type: 'checkbox', hasRowId: true, hasTableId: true, inTrackedTable: true };
  assert.equal(lib.isTrackedCheckbox(fandom), true);
  assert.equal(lib.isTrackedCheckbox({ ...fandom, tagName: 'INPUT', type: 'CHECKBOX' }), true);
  assert.equal(lib.isTrackedCheckbox({ ...fandom, hasRowId: false }), false, 'Telepedia: data-row-id, no data-tpt-row-id');
  assert.equal(lib.isTrackedCheckbox({ ...fandom, hasTableId: false }), false);
  assert.equal(lib.isTrackedCheckbox({ ...fandom, inTrackedTable: false }), false, 'outside table[data-tpt-id]');
  assert.equal(lib.isTrackedCheckbox({ ...fandom, type: 'radio' }), false);
  assert.equal(lib.isTrackedCheckbox({ ...fandom, tagName: 'div' }), false, 'ARIA role=checkbox widget');
  assert.equal(lib.isTrackedCheckbox({ tagName: 'input', type: 'checkbox', hasRowId: false, hasTableId: false, inTrackedTable: false }), false);
  assert.equal(lib.isTrackedCheckbox({ ...fandom, hasRowId: 'yes' }), false, 'facts must be real booleans');
  assert.equal(lib.isTrackedCheckbox(null), false);
  assert.equal(lib.isTrackedCheckbox(undefined), false);
});

test('afterClickOutcome: the four rows of the design\'s step 3 table, for both targets', () => {
  for (const target of [true, false]) {
    assert.equal(lib.afterClickOutcome({ checked: target, target, saving: true }), 'saving');
    assert.equal(lib.afterClickOutcome({ checked: !target, target, saving: false }), 'refused');
    assert.equal(lib.afterClickOutcome({ checked: target, target, saving: false }), 'unconfirmed');
    assert.equal(lib.afterClickOutcome({ checked: !target, target, saving: true }), 'unexpected');
  }
});

const base = { m: 10, k: 10, n: 0, i: 0, rest: 0, already: 0, disabled: 0, timeoutSec: 10 };
const cm = (o) => lib.carefulCheckboxMessage({ ...base, ...o });

test('carefulCheckboxMessage: success, with notes and singular', () => {
  assert.equal(cm({ kind: 'done', target: true, n: 10 }), 'Checked and saved 10 items.');
  assert.equal(cm({ kind: 'done', target: true, n: 10, m: 12, already: 2 }), 'Checked and saved 10 items (2 already checked).');
  assert.equal(cm({ kind: 'done', target: false, n: 5, m: 6, k: 5, already: 1 }), 'Unchecked and saved 5 items (1 already unchecked).');
  assert.equal(cm({ kind: 'done', target: true, n: 1, k: 1, m: 1 }), 'Checked and saved 1 item.');
  assert.equal(cm({ kind: 'done', target: true, n: 3, k: 3, m: 6, already: 2, disabled: 1 }),
    'Checked and saved 3 items (2 already checked, 1 disabled skipped).');
});

test('carefulCheckboxMessage: all disabled is unchanged from today', () => {
  assert.equal(cm({ kind: 'done', target: true, m: 10, k: 0, disabled: 10 }), 'Checked 0 of 10 items (10 disabled skipped)');
  assert.equal(cm({ kind: 'done', target: true, m: 1, k: 0, disabled: 1 }), 'Checked 0 of 1 item (1 disabled skipped)');
});

test('carefulCheckboxMessage: Esc', () => {
  assert.equal(cm({ kind: 'esc', target: true, n: 3, k: 10, rest: 7 }), 'Stopped: checked and saved 3 of 10 items. 7 not tried.');
  assert.equal(cm({ kind: 'esc', target: false, n: 0, k: 1, rest: 1 }), 'Stopped: unchecked and saved 0 of 1 item. 1 not tried.');
});

test('carefulCheckboxMessage: failed save (design T3 numbers)', () => {
  assert.equal(cm({ kind: 'failed', target: true, n: 37, k: 208, i: 38, rest: 170 }),
    "Stopped: the page couldn't save item 38 of 208. 37 checked and saved; 170 not tried. Try again later.");
  assert.equal(cm({ kind: 'failed', target: false, n: 0, k: 4, i: 1, rest: 3, already: 1 }),
    "Stopped: the page couldn't save item 1 of 4. 0 unchecked and saved (1 already unchecked); 3 not tried. Try again later.");
});

test('carefulCheckboxMessage: time-out', () => {
  assert.equal(cm({ kind: 'timeout', target: true, n: 4, k: 10, i: 5, rest: 5, timeoutSec: 10 }),
    'Stopped: item 5 of 10 was still saving after 10 seconds. It may still save; reload to check. 4 checked and saved; 5 not tried.');
});

test('carefulCheckboxMessage: refused click, first box and later box', () => {
  assert.equal(cm({ kind: 'refusedFirst', target: true, k: 10, i: 1, rest: 9 }),
    "This page didn't accept the change (0 of 10 changed); you may need to sign in.");
  assert.equal(cm({ kind: 'refusedFirst', target: true, k: 1, i: 1 }),
    "This page didn't accept the change (0 of 1 changed); you may need to sign in.");
  assert.equal(cm({ kind: 'refusedLater', target: true, n: 3, k: 10, i: 4, rest: 6 }),
    "Stopped: the page didn't accept item 4 of 10; you may need to sign in. 3 checked and saved.");
});

test('carefulCheckboxMessage: changed but no save seen; table changed; internal error', () => {
  assert.equal(cm({ kind: 'unconfirmed', target: true, n: 0, k: 10, i: 1 }),
    "Stopped: item 1 changed, but Snap Linkit couldn't confirm it was saved. Reload to check. 0 checked and saved.");
  assert.equal(cm({ kind: 'tableChanged', target: true, n: 5, k: 10, i: 6, rest: 4 }),
    'Stopped: the table changed while saving. 5 checked and saved; 4 not tried.');
  assert.equal(cm({ kind: 'error', target: false, n: 2, k: 10, i: 3, rest: 7 }),
    'Stopped: Snap Linkit hit an error at item 3 of 10. 2 unchecked and saved; 7 not tried.');
  assert.throws(() => cm({ kind: 'nope', target: true }), /unknown kind/);
});

test('ordinaryCheckboxMessage: honest counts (the "Unchecked 6" fix), not accepted, failed, all disabled', () => {
  const om = (o) => lib.ordinaryCheckboxMessage({ refused: 0, failed: 0, already: 0, disabled: 0, ...o });
  assert.equal(om({ target: false, m: 6, k: 5, n: 5, already: 1 }), 'Unchecked 5 items (1 already unchecked)');
  assert.equal(om({ target: true, m: 5, k: 5, n: 5 }), 'Checked 5 items');
  assert.equal(om({ target: true, m: 1, k: 1, n: 1 }), 'Checked 1 item');
  assert.equal(om({ target: true, m: 10, k: 10, n: 0, refused: 10 }), 'Checked 0 of 10 items (10 not accepted by the page)');
  assert.equal(om({ target: true, m: 3, k: 3, n: 2, failed: 1 }), 'Checked 2 of 3 items (1 failed)');
  assert.equal(om({ target: true, m: 3, k: 2, n: 2, disabled: 1 }), 'Checked 2 items (1 disabled skipped)');
  assert.equal(om({ target: true, m: 10, k: 0, n: 0, disabled: 10 }), 'Checked 0 of 10 items (10 disabled skipped)');
  assert.equal(om({ target: true, m: 8, k: 6, n: 5, refused: 1, already: 1, disabled: 1 }),
    'Checked 5 of 6 items (1 not accepted by the page, 1 already checked, 1 disabled skipped)');
});

test('carefulProgressMessage: progress, and the ignored-drag note', () => {
  assert.equal(lib.carefulProgressMessage(3, 10, false), 'Saving 3 of 10… Press Esc to stop.');
  assert.equal(lib.carefulProgressMessage(3, 10, true), 'Saving 3 of 10… Press Esc to stop. A new drag was ignored while saving.');
});

test('formatDurationEstimate: 5-second steps under a minute, then whole minutes', () => {
  assert.equal(lib.formatDurationEstimate(0), 'about 5 seconds');
  assert.equal(lib.formatDurationEstimate(1200), 'about 5 seconds');
  assert.equal(lib.formatDurationEstimate(18000), 'about 20 seconds');
  assert.equal(lib.formatDurationEstimate(56999), 'about 55 seconds');
  assert.equal(lib.formatDurationEstimate(58000), 'about 1 minute');
  assert.equal(lib.formatDurationEstimate(62400), 'about 1 minute', '208 x 300 ms, the design\'s example');
  assert.equal(lib.formatDurationEstimate(93600), 'about 2 minutes');
  assert.equal(lib.formatDurationEstimate(NaN), 'about 5 seconds');
});

test('carefulConfirmText: title, estimate text and button', () => {
  assert.deepEqual(lib.carefulConfirmText(true, 40, 450), {
    title: 'Check 40 items?', message: 'Snap Linkit will save them one at a time. This takes about 20 seconds.', confirmLabel: 'Check All',
  });
  assert.deepEqual(lib.carefulConfirmText(false, 208, 300), {
    title: 'Uncheck 208 items?', message: 'Snap Linkit will save them one at a time. This takes about 1 minute.', confirmLabel: 'Uncheck All',
  });
});

// ---- Brief 2b: no silent or wrong message around a careful run ----

test('ordinaryUnreadMessage: admits the boxes were clicked; no trailing period (it can lead a careful message)', () => {
  assert.equal(lib.ordinaryUnreadMessage(), "Snap Linkit clicked the checkboxes, but couldn't check the result");
});

test('carefulFallbackMessage: says how far the run got', () => {
  const f = lib.carefulFallbackMessage;
  assert.equal(f('before', null, 35), 'Stopped: Snap Linkit hit an error before saving. Nothing was changed (0 of 35 items).');
  assert.equal(f('before', null, 1), 'Stopped: Snap Linkit hit an error before saving. Nothing was changed (0 of 1 item).');
  assert.equal(f('after', { kind: 'done', target: true, n: 10, k: 10 }, 10),
    'Snap Linkit hit an error showing the result: 10 of 10 items checked and saved. Reload to check.');
  assert.equal(f('after', { kind: 'failed', target: false, n: 3, k: 7 }, 7),
    'Snap Linkit hit an error showing the result: 3 of 7 items unchecked and saved. Reload to check.');
  // No counts: never invents numbers
  for (const [stage, c] of [['running', null], ['after', null], ['after', { n: 'x', k: 3 }], ['nonsense', null]]) {
    assert.equal(f(stage, c, 5), 'Stopped: Snap Linkit hit an error while saving. Reload to check what was saved.', stage);
  }
});

test('carefulNotStartedMessage: an earlier save is still running, so nothing was clicked (ultrareview #4)', () => {
  assert.equal(lib.carefulNotStartedMessage('saving', 12),
    'An earlier save is still running. Wait until it finishes, or reload the page, then drag again. Nothing was saved (0 of 12 items).');
  assert.equal(lib.carefulNotStartedMessage('saving', 1),
    'An earlier save is still running. Wait until it finishes, or reload the page, then drag again. Nothing was saved (0 of 1 item).');
});

test('carefulNotStartedMessage: the confirm could not be shown, so nothing was saved', () => {
  assert.equal(lib.carefulNotStartedMessage('busy', 35),
    'Another Snap Linkit dialog is open. Close it and drag again. Nothing was saved (0 of 35 items).');
  assert.equal(lib.carefulNotStartedMessage('failed', 31),
    "Stopped: Snap Linkit couldn't open its confirm dialog. Nothing was saved (0 of 31 items).");
});

test('faultMatches: lab fault list ("name" or "name@N", comma separated)', () => {
  const m = lib.faultMatches;
  assert.equal(m('report', 'report'), true);
  assert.equal(m('report, progress@3', 'progress', 3), true);
  assert.equal(m('report,progress@3', 'progress', 2), false);
  assert.equal(m('progress@3', 'progress'), false);
  assert.equal(m('reportx', 'report'), false);
  assert.equal(m('progress@', 'progress', 0), false);
  assert.equal(m('a@1@2', 'a', 1), false);
  for (const spec of [null, undefined, '', '  ', 42, {}]) assert.equal(m(spec, 'report'), false, String(spec));
});
