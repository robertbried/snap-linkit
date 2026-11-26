'use strict';
// build.mjs: which switches each kind of build turns on, and (item 4, big run 2) that store builds carry no test-only
// code at all. Rob's test zips and store zips must never carry the lab-only failure injection (FAULTS). Builds into a
// throw-away directory, never dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SWITCHES = (text) => ({
  saveLog: text.includes('const SAVE_LOG = true; ') ? true : text.includes('const SAVE_LOG = false;') ? false : 'missing',
  faults: text.includes('const FAULTS = true; ') ? true : text.includes('const FAULTS = false;') ? false : 'missing',
});
// The packaged file's source: chrome/ replaces or adds files for the Chrome target, src/ has the rest
const sourceOf = (target, f) => (target === 'chrome' && fs.existsSync(path.join(ROOT, 'chrome', f))
  ? path.join(ROOT, 'chrome', f) : path.join(ROOT, 'src', f));

test('build: store, test and lab builds switch SAVE_LOG and FAULTS as documented; store builds have neither', async () => {
  const { buildTarget, stripTestOnly, TEST_ONLY_NAMES } = await import('../build.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'snaplinkit-build-test-'));
  try {
    for (const target of ['firefox', 'chrome']) {
      const store = buildTarget(target, path.join(out, 'store'));
      const t = buildTarget(target, path.join(out, 'test'), { test: true });
      const lab = buildTarget(target, path.join(out, 'lab'), { test: true, faults: true });
      const read = (r, f) => fs.readFileSync(path.join(r.dir, f), 'utf8');
      const cs = (r) => read(r, 'content.js');
      // Store: the test-only code is left out of every script (no SAVE_LOG, no FAULTS, no drag line, no fault hook)
      assert.deepEqual(SWITCHES(cs(store)), { saveLog: 'missing', faults: 'missing' }, `${target} store`);
      for (const f of store.files.filter((name) => name.endsWith('.js'))) {
        const text = read(store, f);
        assert.doesNotMatch(text, TEST_ONLY_NAMES, `${target} store ${f}: test-only code left`);
        assert.doesNotThrow(() => new vm.Script(text, { filename: f }), `${target} store ${f} parses`);
        // ...and what's left is the source minus exactly its marked lines
        assert.equal(text, stripTestOnly(fs.readFileSync(sourceOf(target, f), 'utf8'), f).text, `${target} store ${f}`);
      }
      assert.ok(store.stripped['content.js'] > 100, `${target}: content.js lost its test-only lines (${store.stripped['content.js']})`);
      assert.ok(store.stripped['lib/helpers.js'] > 50, `${target}: helpers.js lost its test-only lines (${store.stripped['lib/helpers.js']})`);
      // Every other store file is its source, byte for byte
      for (const f of store.files.filter((name) => !name.endsWith('.js'))) {
        assert.ok(fs.readFileSync(path.join(store.dir, f)).equals(fs.readFileSync(sourceOf(target, f))), `${target} store ${f}`);
      }
      // Test and lab builds keep every line: the test build is src/'s content.js with SAVE_LOG on, nothing else
      assert.deepEqual(SWITCHES(cs(t)), { saveLog: true, faults: false }, `${target} test (Rob's zips)`);
      assert.deepEqual(SWITCHES(cs(lab)), { saveLog: true, faults: true }, `${target} lab`);
      const src = fs.readFileSync(path.join(ROOT, 'src', 'content.js'), 'utf8').split('\n');
      const a = cs(t).split('\n');
      assert.equal(a.length, src.length);
      assert.deepEqual(src.map((l, i) => [l, a[i]]).filter(([x, y]) => x !== y),
        [['  const SAVE_LOG = false;', '  const SAVE_LOG = true; ']]);
      assert.equal(read(t, 'lib/helpers.js'), fs.readFileSync(path.join(ROOT, 'src', 'lib', 'helpers.js'), 'utf8'));
      assert.match(path.basename(t.zip), /-test\.zip$/);
      assert.match(path.basename(lab.zip), /-lab\.zip$/);
      // The test and lab content.js differ in that one line only
      const b = cs(lab).split('\n');
      assert.equal(a.length, b.length);
      assert.deepEqual(a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y),
        [['  const FAULTS = false;', '  const FAULTS = true; ']]);
    }
    assert.throws(() => buildTarget('firefox', path.join(out, 'bad'), { faults: true }), /also a test build/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('build: test and lab builds are their own add-on (own Firefox ID, "(test build)" name); store builds keep the store ID (item 1)', async () => {
  const { buildTarget, STORE_GECKO_ID, TEST_GECKO_ID } = await import('../build.mjs');
  assert.equal(STORE_GECKO_ID, 'snap-linkit@privacy-guaranteed');
  assert.equal(TEST_GECKO_ID, 'snap-linkit-test@privacy-guaranteed');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'snaplinkit-build-test-'));
  try {
    for (const target of ['firefox', 'chrome']) {
      const mf = (r) => JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8'));
      const source = JSON.parse(fs.readFileSync(sourceOf(target, 'manifest.json'), 'utf8'));
      const store = mf(buildTarget(target, path.join(out, 'store')));
      assert.deepEqual(store, source, `${target} store manifest is the source's`);
      for (const opts of [{ test: true }, { test: true, faults: true }]) {
        const m = mf(buildTarget(target, path.join(out, opts.faults ? 'lab' : 'test'), opts));
        const expect = structuredClone(source);
        expect.name = 'Snap Linkit (test build)';
        expect.action.default_title = 'Snap Linkit (test build)';
        if (target === 'firefox') expect.browser_specific_settings.gecko.id = TEST_GECKO_ID;
        assert.deepEqual(m, expect, `${target} ${opts.faults ? 'lab' : 'test'} manifest: only the ID, name and title differ`);
      }
      if (target === 'firefox') assert.equal(store.browser_specific_settings.gecko.id, STORE_GECKO_ID);
      else assert.ok(!('browser_specific_settings' in store));
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('stripTestOnly: marked lines and blocks are left out; malformed markers and leftovers fail the build', async () => {
  const { stripTestOnly } = await import('../build.mjs');
  const src = [
    'const a = 1;',
    'logIt(a); // @test-only',
    'logIt(a); // @test-only: with a reason',
    '// @test-only-begin',
    'function logIt() {}',
    '// @test-only-end',
    'const b = 2; // a plain comment that mentions test-only stays',
  ].join('\n');
  assert.deepEqual(stripTestOnly(src), { text: 'const a = 1;\nconst b = 2; // a plain comment that mentions test-only stays', removed: 5 });
  assert.deepEqual(stripTestOnly('const a = 1;'), { text: 'const a = 1;', removed: 0 });
  assert.throws(() => stripTestOnly('// @test-only-begin\n// @test-only-begin\n// @test-only-end'), /inside another/);
  assert.throws(() => stripTestOnly('const a = 1;\n// @test-only-end'), /without a begin/);
  assert.throws(() => stripTestOnly('// @test-only-begin\nconst a = 1;'), /never closed/);
  assert.throws(() => stripTestOnly('if (SAVE_LOG) x();'), /test-only code left after stripping \("SAVE_LOG"\)/);
  assert.throws(() => stripTestOnly('faultPoint("x");'), /left after stripping/);
  assert.throws(() => stripTestOnly('if (a) {\n// @test-only-begin\n}\n// @test-only-end'), /doesn't parse after stripping/);
});
