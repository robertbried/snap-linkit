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
 * Derive a download filename from the URL path: last path segment,
 * percent-decoded, with characters the downloads API rejects replaced and
 * leading dots stripped. Falls back to "download" for paths ending in "/".
 */
function filenameFromUrl(url) {
  let segment = '';
  try {
    segment = new URL(url).pathname.split('/').pop() || '';
  } catch (e) {
    return 'download';
  }
  try {
    segment = decodeURIComponent(segment);
  } catch (e) {
    // Malformed escape sequence: keep the encoded form
  }
  const cleaned = segment
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'download';
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
