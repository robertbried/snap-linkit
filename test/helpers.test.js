'use strict';
// Unit tests for src/lib/helpers.js. Zero dependencies: node:test + node:assert.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/lib/helpers.js');

test('SnapLinkitLib exposes every helper and is frozen', () => {
  assert.deepEqual(Object.keys(lib).sort(), [
    'DOWNLOAD_EXTENSIONS', 'OPENABLE_PROTOCOLS', 'blacklistBytes', 'filenameFromUrl',
    'isDownloadableUrl', 'isOpenableUrl', 'isValidPattern', 'majorityShouldCheck',
    'matchesPattern', 'plural', 'rectsIntersect', 'selectionRect',
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
