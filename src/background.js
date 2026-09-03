/**
 * Snap Linkit - Background Service Worker
 * Privacy 100% Guaranteed - No data collection, no external requests
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

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
// MESSAGE HANDLER
// ============================================
// Listen for messages from content script
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'openTabs':
      // Clamp delay to 0-2000ms range
      const delay = Math.max(0, Math.min(2000, message.delay || 50));
      const discardAfterOpen = message.discardAfterOpen || false;
      openTabsSequentially(message.urls, sender.tab?.index, delay, discardAfterOpen);
      break;

    case 'downloadFiles':
      downloadFiles(message.urls);
      break;
  }
  // No async response needed - return false to close message port immediately
  return false;
});

/**
 * Check if tabs.discard API is available
 */
function canDiscardTabs() {
  return typeof browserAPI.tabs.discard === 'function';
}

/**
 * Only http(s) URLs can be opened by tabs.create / downloads.download
 * (and only those can be discarded). Mirrors isOpenableUrl in content.js;
 * re-checked here so the background never trusts message payloads.
 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);
function isOpenableUrl(url) {
  try {
    return typeof url === 'string' && OPENABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch (e) {
    return false;
  }
}

/**
 * Open tabs sequentially to maintain order
 * @param {string[]} urls - URLs to open
 * @param {number} currentTabIndex - Index of current tab for positioning
 * @param {number} delayMs - Delay between tab opens (0-2000ms, already clamped)
 * @param {boolean} discardAfterOpen - If true, attempt to discard tabs after opening (memory saver)
 */
async function openTabsSequentially(urls, currentTabIndex = 0, delayMs = 50, discardAfterOpen = false) {
  if (!Array.isArray(urls) || urls.length === 0) return;

  const supportsDiscard = canDiscardTabs();
  const tabsToDiscard = [];

  for (let i = 0; i < urls.length; i++) {
    if (!isOpenableUrl(urls[i])) {
      console.debug('Snap Linkit: skipping unopenable URL', urls[i]);
      continue;
    }
    try {
      const tab = await browserAPI.tabs.create({
        url: urls[i],
        active: false,
        index: currentTabIndex + i + 1
      });

      // Track tabs for potential discard (only http/https URLs)
      if (discardAfterOpen && supportsDiscard && tab.id) {
        tabsToDiscard.push(tab.id);
      }

      // Configurable delay between tabs
      if (i < urls.length - 1 && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      console.debug('Snap Linkit: Could not open tab for', urls[i]);
    }
  }

  // Best-effort discard: wait for tabs to load, then unload them
  if (tabsToDiscard.length > 0) {
    discardTabsWhenReady(tabsToDiscard);
  }
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
 */
async function downloadFiles(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return;

  for (const url of urls) {
    if (!isOpenableUrl(url)) {
      console.debug('Snap Linkit: skipping unopenable URL', url);
      continue;
    }
    try {
      // Extract filename from URL
      const filename = url.split('/').pop().split('?')[0] || 'download';

      await browserAPI.downloads.download({
        url: url,
        filename: filename,
        saveAs: false
      });
    } catch (error) {
      // Fallback: open in new tab (download will trigger)
      try {
        await browserAPI.tabs.create({ url, active: false });
      } catch (e) {
        console.debug('Snap Linkit: Could not download', url);
      }
    }
  }
}
