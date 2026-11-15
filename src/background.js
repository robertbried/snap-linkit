/**
 * Snap Linkit - Background Service Worker
 * Privacy 100% Guaranteed - No data collection, no external requests
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Pure helpers live in lib/helpers.js (loaded first by the manifest)
const {
  isOpenableUrl, filenameFromUrl, shouldOfferWhatsNew, whatsNewLines, WHATS_NEW_VERSION, isVersionBefore
} = globalThis.SnapLinkitLib;

// ============================================
// KEYBOARD SHORTCUT HANDLER
// ============================================
browserAPI.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    // Forward command to content script. Awaited so a missing receiver
    // (about:, AMO, PDF viewer, ungranted host) lands in the catch below
    // instead of surfacing as an unhandled rejection.
    await browserAPI.tabs.sendMessage(tab.id, { action: command });
  } catch (error) {
    console.debug('Snap Linkit: Could not send command to tab:', error.message);
  }
});

// ============================================
// "WHAT'S NEW" NOTICE (1.3.0 shortcut change)
// ============================================
// storage.local "whatsNew" = { version, badge }. Set here on an update from
// before 1.3.0; popup.js sets badge to false when the popup first opens and
// removes the key on "Got it". The toolbar badge does not survive a browser
// restart, so onStartup puts it back while badge is still true. Both
// listeners are registered at the top level so the background page wakes.
const WHATS_NEW_TITLE = 'Snap Linkit: new keyboard shortcuts';

async function showWhatsNewBadge() {
  await browserAPI.action.setBadgeText({ text: 'NEW' });
  await browserAPI.action.setBadgeBackgroundColor({ color: '#bf00ff' });
  await browserAPI.action.setBadgeTextColor({ color: '#ffffff' });
  await browserAPI.action.setTitle({ title: WHATS_NEW_TITLE });
}

async function offerWhatsNew() {
  // Nothing changed for a user who customised or cleared both shortcuts
  const commands = await browserAPI.commands.getAll();
  if (whatsNewLines(commands, false).length === 0) return;
  await browserAPI.storage.local.set({ whatsNew: { version: WHATS_NEW_VERSION, badge: true } });
  await showWhatsNewBadge();
}

async function restoreWhatsNewBadge() {
  const { whatsNew } = await browserAPI.storage.local.get('whatsNew');
  if (whatsNew && whatsNew.badge === true) await showWhatsNewBadge();
}

// 1.2.1's content script matched <all_urls>, so Firefox granted <all_urls> at
// install and keeps it on update (Firefox Bug 2022704: stale host grants are
// only revoked for policy-managed add-ons). 1.3.0 no longer declares it, so the
// about:addons site-access toggle cannot revoke it and turning access off did
// nothing. Drop it once, on the update from a version before 1.3.0; the
// http/https grants stay. Failures are logged and never block anything else.
function clearLegacyAllUrlsGrant(details) {
  if (!details || details.reason !== 'update' || typeof details.previousVersion !== 'string' ||
      !isVersionBefore(details.previousVersion, '1.3.0')) {
    return;
  }
  Promise.resolve()
    .then(() => browserAPI.permissions.remove({ origins: ['<all_urls>'] }))
    .catch((error) => {
      console.warn('Snap Linkit: could not clear the <all_urls> grant left by 1.2.1:', error?.message);
    });
}

browserAPI.runtime.onInstalled.addListener((details) => {
  clearLegacyAllUrlsGrant(details);
  if (!shouldOfferWhatsNew(details)) return;
  offerWhatsNew().catch((error) => {
    console.warn("Snap Linkit: could not set up the what's new notice:", error?.message);
  });
});

browserAPI.runtime.onStartup.addListener(() => {
  restoreWhatsNewBadge().catch((error) => {
    console.warn("Snap Linkit: could not restore the what's new badge:", error?.message);
  });
});

// ============================================
// MESSAGE HANDLER
// ============================================
// Listen for messages from content script. Every action resolves to a
// summary ({ requested, opened/downloaded, failed }) that the content
// script turns into user feedback. sendResponse + `return true` keeps the
// channel open until the work is done and works for both browser.* and
// chrome.* namespaces.
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let work;
  switch (message?.action) {
    case 'openTabs': {
      // Clamp delay to 0-2000ms range
      const delay = Math.max(0, Math.min(2000, Number(message.delay) || 50));
      const discardAfterOpen = message.discardAfterOpen === true;
      work = openTabsSequentially(message.urls, sender.tab?.index, delay, discardAfterOpen);
      break;
    }

    case 'downloadFiles':
      work = downloadFiles(message.urls);
      break;

    default:
      return false;
  }

  work.then(sendResponse, (error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});

/**
 * Check if tabs.discard API is available
 */
function canDiscardTabs() {
  return typeof browserAPI.tabs.discard === 'function';
}

/**
 * Open tabs sequentially to maintain order
 * @param {string[]} urls - URLs to open
 * @param {number} currentTabIndex - Index of current tab for positioning
 * @param {number} delayMs - Delay between tab opens (0-2000ms, already clamped)
 * @param {boolean} discardAfterOpen - If true, attempt to discard tabs after opening (memory saver)
 * @returns {Promise<{requested: number, opened: number, failed: number}>}
 */
async function openTabsSequentially(urls, currentTabIndex = 0, delayMs = 50, discardAfterOpen = false) {
  const result = { requested: Array.isArray(urls) ? urls.length : 0, opened: 0, failed: 0 };
  if (result.requested === 0) return result;

  const supportsDiscard = canDiscardTabs();
  const tabsToDiscard = [];

  for (let i = 0; i < urls.length; i++) {
    if (!isOpenableUrl(urls[i])) {
      console.debug('Snap Linkit: skipping unopenable URL', urls[i]);
      result.failed++;
      continue;
    }
    try {
      const tab = await browserAPI.tabs.create({
        url: urls[i],
        active: false,
        index: currentTabIndex + i + 1
      });
      result.opened++;

      // Track tabs for potential discard (only http/https URLs)
      if (discardAfterOpen && supportsDiscard && tab.id) {
        tabsToDiscard.push(tab.id);
      }

      // Configurable delay between tabs
      if (i < urls.length - 1 && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      result.failed++;
      console.debug('Snap Linkit: Could not open tab for', urls[i], error?.message);
    }
  }

  // Best-effort discard: wait for tabs to load, then unload them
  if (tabsToDiscard.length > 0) {
    discardTabsWhenReady(tabsToDiscard);
  }

  return result;
}

/**
 * Wait for tabs to finish loading, then discard them
 * Uses tabs.onUpdated listener for reliable timing
 */
function discardTabsWhenReady(tabIds) {
  const pendingTabs = new Set(tabIds);
  const TIMEOUT_MS = 30000; // 30 second timeout per tab
  const timeouts = new Map();

  function tryDiscard(tabId) {
    if (!pendingTabs.has(tabId)) return;
    pendingTabs.delete(tabId);

    // Clear timeout for this tab
    if (timeouts.has(tabId)) {
      clearTimeout(timeouts.get(tabId));
      timeouts.delete(tabId);
    }

    // Small delay to ensure tab is fully ready
    setTimeout(async () => {
      try {
        await browserAPI.tabs.discard(tabId);
      } catch (e) {
        // Graceful fallback: tab stays loaded if discard fails
        // This can happen if tab is active, playing audio, etc.
      }
    }, 50);
  }

  // Listener for tab updates
  function onTabUpdated(tabId, changeInfo, tab) {
    if (!pendingTabs.has(tabId)) return;

    // Wait for 'complete' status (page fully loaded)
    if (changeInfo.status === 'complete') {
      tryDiscard(tabId);
    }
  }

  // Add listener
  browserAPI.tabs.onUpdated.addListener(onTabUpdated);

  // Set timeouts for each tab (fallback if load never completes)
  for (const tabId of tabIds) {
    timeouts.set(tabId, setTimeout(() => {
      tryDiscard(tabId);
    }, TIMEOUT_MS));
  }

  // Cleanup listener when all tabs processed or after max timeout
  setTimeout(() => {
    browserAPI.tabs.onUpdated.removeListener(onTabUpdated);
    // Clear any remaining timeouts
    for (const timeout of timeouts.values()) {
      clearTimeout(timeout);
    }
  }, TIMEOUT_MS + 1000);
}

/**
 * Download files via browser download API
 * @returns {Promise<{requested: number, downloaded: number, openedInTab: number, failed: number}>}
 */
async function downloadFiles(urls) {
  const result = { requested: Array.isArray(urls) ? urls.length : 0, downloaded: 0, openedInTab: 0, failed: 0 };
  if (result.requested === 0) return result;

  for (const url of urls) {
    if (!isOpenableUrl(url)) {
      console.debug('Snap Linkit: skipping unopenable URL', url);
      result.failed++;
      continue;
    }
    try {
      const filename = filenameFromUrl(url);

      await browserAPI.downloads.download({
        url: url,
        filename: filename,
        saveAs: false
      });
      result.downloaded++;
    } catch (error) {
      // Fallback: open in new tab (download will trigger)
      try {
        await browserAPI.tabs.create({ url, active: false });
        result.openedInTab++;
      } catch (e) {
        result.failed++;
        console.debug('Snap Linkit: Could not download', url, e?.message);
      }
    }
  }

  return result;
}
