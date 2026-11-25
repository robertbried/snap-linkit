#!/usr/bin/env node
/**
 * Snap Linkit build: one source tree (src/) for both browsers.
 *
 *   node build.mjs            -> dist/firefox and dist/chrome, plus a zip of each
 *   node build.mjs firefox    -> dist/firefox (exactly src/, nothing added or changed)
 *   node build.mjs chrome     -> dist/chrome (src/ with the files in chrome/ added or replacing)
 *   node build.mjs --test [firefox|chrome]
 *                             -> dist/test/<target> and dist/test/snap_linkit-<target>-<version>-test.zip: the same
 *                                files, except that content.js writes test-build console lines: one per Fandom
 *                                checkbox save and one per drag (SAVE_LOG on). For test builds only; never for a
 *                                store upload.
 *   node build.mjs --faults [firefox|chrome]
 *                             -> dist/lab/<target> and dist/lab/snap_linkit-<target>-<version>-lab.zip: the test build
 *                                plus failure injection (FAULTS on: the page can make named steps fail through
 *                                <html data-snaplinkit-fault>). For the lab harness only; never for Rob or a store.
 *
 * chrome/ holds only what Chrome needs to be different: manifest.json (service worker, no
 * browser_specific_settings, minimum_chrome_version, Chrome 128 px icon), sw.js, images/icon128-chrome.png and
 * privacy-policy.html (the Chrome wording of the policy; src/privacy-policy.html is the Firefox one).
 * Zips are deterministic (sorted entries, fixed timestamps), so the same files always give the same bytes.
 * No dependencies: node:fs, node:path, node:zlib, node:crypto only.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OVERLAYS = { firefox: null, chrome: path.join(ROOT, 'chrome') };

// Relative paths of every file under dir, sorted, '/' separators; dot-files are refused, not skipped
function listFiles(dir) {
  const out = [];
  (function walk(rel) {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.name.startsWith('.')) throw new Error(`build: unexpected dot-file ${path.join(dir, r)}`);
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) out.push(r);
      else throw new Error(`build: not a regular file: ${path.join(dir, r)}`);
    }
  })('');
  return out.sort();
}

function manifestVersion(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

// CRC-32 (zip): zlib.crc32 where available (Node >= 22.2), else a table
const crc32 = zlib.crc32 || (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = t[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
})();

// Minimal deterministic zip writer: deflate (or store when deflate is not smaller), DOS time 1980-01-01 00:00
function writeZip(zipPath, baseDir, files) {
  const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const local = [], central = [];
  let offset = 0;
  for (const rel of files) {
    const data = fs.readFileSync(path.join(baseDir, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...local, cd, end]));
}

// Test builds: the one line of content.js that turns the per-save console line on. Must occur exactly once.
const SAVE_LOG_OFF = 'const SAVE_LOG = false;';
const SAVE_LOG_ON = 'const SAVE_LOG = true; ';
// Lab builds: the one line that turns failure injection on. Must occur exactly once.
const FAULTS_OFF = 'const FAULTS = false;';
const FAULTS_ON = 'const FAULTS = true; ';

// Replace the one occurrence of `off` with `on`, or throw
function switchOn(text, off, on, what) {
  if (text.split(off).length !== 2) throw new Error(`build: ${what} needs exactly one "${off}" in content.js`);
  return text.replace(off, on);
}

/**
 * Build one target into <outDir>/<target>/ and <outDir>/snap_linkit-<target>-<version><suffix>.zip.
 * Options:
 *   {}                (default) the store build, no suffix: content.js exactly as in src/;
 *   { test: true }    a test build, suffix -test: SAVE_LOG on (one diagnostic console line per save and per drag);
 *   { test: true, faults: true }
 *                     a lab build, suffix -lab: the test build with failure injection on (FAULTS). `faults`
 *                     without `test` throws.
 * Returns { target, dir, zip, version, files, sha256 }. Throws on any problem (a failed build may leave a
 * partial <outDir>/<target>/; the next build deletes and rebuilds it).
 */
export function buildTarget(target, outDir = path.join(ROOT, 'dist'), { test = false, faults = false } = {}) {
  if (faults && !test) throw new Error('build: a fault-injection build is also a test build');
  if (!(target in OVERLAYS)) throw new Error(`build: unknown target "${target}" (firefox or chrome)`);
  const version = manifestVersion(path.join(SRC, 'manifest.json'));
  const overlay = OVERLAYS[target];
  if (overlay) {
    const ov = manifestVersion(path.join(overlay, 'manifest.json'));
    if (ov !== version) throw new Error(`build: ${target}/manifest.json version ${ov} != src/manifest.json ${version}`);
  }
  const dir = path.join(outDir, target);
  fs.rmSync(dir, { recursive: true, force: true });
  const from = new Map(listFiles(SRC).map((f) => [f, path.join(SRC, f)]));
  if (overlay) for (const f of listFiles(overlay)) from.set(f, path.join(overlay, f));
  const files = [...from.keys()].sort();
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(from.get(f), path.join(dir, f));
  }
  if (test) {
    const cs = path.join(dir, 'content.js');
    let text = switchOn(fs.readFileSync(cs, 'utf8'), SAVE_LOG_OFF, SAVE_LOG_ON, 'a test build');
    if (faults) text = switchOn(text, FAULTS_OFF, FAULTS_ON, 'a fault-injection build');
    fs.writeFileSync(cs, text);
  }
  const zip = path.join(outDir, `snap_linkit-${target}-${version}${faults ? '-lab' : test ? '-test' : ''}.zip`);
  writeZip(zip, dir, files);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  return { target, dir, zip, version, files, sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const faults = args.includes('--faults');
  const test = faults || args.includes('--test');
  const named = args.filter((a) => a !== '--test' && a !== '--faults');
  const targets = named.length ? named : ['firefox', 'chrome'];
  for (const t of targets) {
    const r = faults ? buildTarget(t, path.join(ROOT, 'dist', 'lab'), { test: true, faults: true })
      : test ? buildTarget(t, path.join(ROOT, 'dist', 'test'), { test: true }) : buildTarget(t);
    console.log(`${r.target} ${r.version}: ${r.files.length} files -> ${path.relative(ROOT, r.zip)} (sha256 ${r.sha256})`);
  }
}
