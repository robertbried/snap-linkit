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
  };
};
