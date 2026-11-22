'use strict';
// build.mjs: which switches each kind of build turns on. Rob's test zips and store zips must never carry the
// lab-only failure injection (FAULTS). Builds into a throw-away directory, never dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SWITCHES = (text) => ({
  saveLog: text.includes('const SAVE_LOG = true; ') ? true : text.includes('const SAVE_LOG = false;') ? false : 'missing',
  faults: text.includes('const FAULTS = true; ') ? true : text.includes('const FAULTS = false;') ? false : 'missing',
});

test('build: store, test and lab builds switch SAVE_LOG and FAULTS as documented', async () => {
  const { buildTarget } = await import('../build.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'snaplinkit-build-test-'));
  try {
    for (const target of ['firefox', 'chrome']) {
      const store = buildTarget(target, path.join(out, 'store'));
      const t = buildTarget(target, path.join(out, 'test'), { test: true });
      const lab = buildTarget(target, path.join(out, 'lab'), { test: true, faults: true });
      const cs = (r) => fs.readFileSync(path.join(r.dir, 'content.js'), 'utf8');
      assert.deepEqual(SWITCHES(cs(store)), { saveLog: false, faults: false }, `${target} store`);
      assert.deepEqual(SWITCHES(cs(t)), { saveLog: true, faults: false }, `${target} test (Rob's zips)`);
      assert.deepEqual(SWITCHES(cs(lab)), { saveLog: true, faults: true }, `${target} lab`);
      assert.match(path.basename(t.zip), /-test\.zip$/);
      assert.match(path.basename(lab.zip), /-lab\.zip$/);
      // The test and lab content.js differ in that one line only
      const a = cs(t).split('\n'), b = cs(lab).split('\n');
      assert.equal(a.length, b.length);
      assert.deepEqual(a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y),
        [['  const FAULTS = false;', '  const FAULTS = true; ']]);
    }
    assert.throws(() => buildTarget('firefox', path.join(out, 'bad'), { faults: true }), /also a test build/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
