/**
 * Snap Linkit - Chrome background service worker.
 * Firefox runs lib/helpers.js and background.js as background.scripts
 * (src/manifest.json). Chrome (Manifest V3) needs a single service-worker
 * file, so this one loads the same two files in the same order:
 * lib/helpers.js defines globalThis.SnapLinkitLib, which background.js
 * reads when it loads.
 */
importScripts('lib/helpers.js', 'background.js');
