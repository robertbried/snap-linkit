/**
 * Snap Linkit - Shared default settings
 * Loaded before content.js (content script) and popup.js (popup).
 * Returns a fresh object each call so callers can mutate their copy
 * (e.g. push onto blacklist) without touching the defaults.
 */
globalThis.SnapLinkitDefaults = function SnapLinkitDefaults() {
  return {
    scrollEdgeThreshold: 50,
    autoScrollSpeed: 15,
    maxTabsWithoutConfirm: 20,
    tabOpenDelay: 50,
    blacklist: [],
    blacklistMode: 'blacklist',
    extensionEnabled: true,
    // What a plain right-drag release over links does (lib/helpers.js RELEASE_ACTIONS)
    releaseAction: 'open',
    // Fandom tracking boxes are saved one at a time: the extra wait after each
    // confirmed save, in ms (0-2000; lib/helpers.js saveGapMs). PROVISIONAL
    // until Rob's measurement (decision 15).
    checkboxSaveGap: 150,
  };
};
