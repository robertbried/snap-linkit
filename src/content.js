/**
 * Snap Linkit - Content Script
 * Privacy 100% Guaranteed - No data collection, no external requests
 */

(function() {
  'use strict';

  // ============================================
  // SETTINGS
  // ============================================
  // Defaults live in defaults.js (shared with popup.js)
  // Mutable settings object - starts with defaults, hydrated async
  let settings = SnapLinkitDefaults();

  // Hardcoded (not configurable - frame timing)
  const FRAME_INTERVAL = 16;
  const MIN_DRAG_DISTANCE = 5; // Pixels to drag before activating selection (allows normal clicks)

  // ============================================
  // STATE
  // ============================================
  let state = {
    isSelecting: false,
    isDragging: false,   // True only after MIN_DRAG_DISTANCE reached
    blockNextContextMenu: false, // Block context menu after right-click drag
    startX: 0,           // Viewport X at drag start (never mutated during drag)
    startY: 0,           // Viewport Y at drag start (never mutated during drag)
    startScrollX: 0,     // window.scrollX at drag start
    startScrollY: 0,     // window.scrollY at drag start
    currentX: 0,
    currentY: 0,
    selectedElements: new Set(),
    persistentSelection: new Set(),
    modifierMode: null,
    scrollInterval: null,
  };

  // Extension active state (can be disabled via blacklist)
  let extensionActive = false;
  let listenersAttached = false;

  // ============================================
  // DOM ELEMENTS
  // ============================================
  let lassoEl = null;
  let menuEl = null;

  // ============================================
  // BROWSER API
  // ============================================
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // Only http(s) URLs can be opened by tabs.create or fetched by
  // downloads.download; javascript:, data:, blob:, file:, about: and
  // friends are rejected by the browser. Checked on the resolved URL so
  // case and whitespace variants of the attribute are covered.
  const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);
  function isOpenableUrl(url) {
    try {
      return OPENABLE_PROTOCOLS.has(new URL(url).protocol);
    } catch (e) {
      return false;
    }
  }

  // ============================================
  // SETTINGS LOADER
  // ============================================

  // Load settings from storage.sync, the single source of truth: the popup
  // writes there and reports any failed save to the user.
  async function loadSettings() {
    try {
      const stored = await browserAPI.storage.sync.get(SnapLinkitDefaults());
      settings = { ...SnapLinkitDefaults(), ...stored };
    } catch (e) {
      settings = SnapLinkitDefaults();
    }
    checkBlacklistAndInit();
  }

  // Listen for live settings updates
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;

    Object.keys(changes).forEach(key => {
      if (key in settings) {
        // A removed key reverts to its default rather than becoming undefined
        settings[key] = changes[key].newValue ?? SnapLinkitDefaults()[key];
      }
    });

    // Re-check blacklist on relevant settings changes
    if ('blacklist' in changes || 'blacklistMode' in changes || 'extensionEnabled' in changes) {
      updateExtensionState();
    }
  });

  // ============================================
  // BLACKLIST / WHITELIST
  // ============================================

  // Site-list matching on lowercased strings.
  //   "*.example.com"  matches example.com and any subdomain (a.example.com,
  //                    a.b.example.com) but not notexample.com or example.com.evil.net
  //   "example.com"    matches exactly that host
  //   other wildcards  ("mail.*.com") keep the original regex semantics
  // IDN: the popup accepts ASCII only, so patterns are entered as punycode, and
  // location.hostname is punycode too, so plain comparison is correct.
  function matchesPattern(hostname, pattern) {
    const host = String(hostname || '').toLowerCase();
    const pat = String(pattern || '').toLowerCase();
    if (!pat) return false;

    if (pat.startsWith('*.') && !pat.slice(2).includes('*')) {
      const base = pat.slice(2);
      return host === base || host.endsWith('.' + base);
    }

    if (!pat.includes('*')) {
      return host === pat;
    }

    // Remaining wildcard forms: escape regex specials (except *), then * -> .*
    const escaped = pat
      .replace(/\\/g, '\\\\')
      .replace(/[.+?^${}()|[\]]/g, '\\$&')
      .replace(/\*/g, '.*');
    try {
      return new RegExp('^' + escaped + '$').test(host);
    } catch (e) {
      return false;
    }
  }

  function isOnList(hostname) {
    const patterns = settings.blacklist || [];
    return patterns.some(pattern => matchesPattern(hostname, pattern));
  }

  function shouldRunOnCurrentSite() {
    if (!settings.extensionEnabled) return false;

    const hostname = window.location.hostname;
    const onList = isOnList(hostname);

    // Blacklist mode: run unless on list
    // Whitelist mode: run only if on list
    return settings.blacklistMode === 'blacklist' ? !onList : onList;
  }

  function updateExtensionState() {
    const shouldRun = shouldRunOnCurrentSite();

    if (shouldRun && !extensionActive) {
      extensionActive = true;
      attachEventListeners();
    } else if (!shouldRun && extensionActive) {
      extensionActive = false;
      detachEventListeners();
      cancelSelection();
    }
  }

  function checkBlacklistAndInit() {
    if (shouldRunOnCurrentSite()) {
      extensionActive = true;
      attachEventListeners();
    } else {
      extensionActive = false;
    }
  }

  // ============================================
  // MESSAGE HANDLER (keyboard shortcuts from background.js)
  // ============================================

  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'toggle-extension':
        settings.extensionEnabled = !settings.extensionEnabled;
        updateExtensionState();
        showToast(settings.extensionEnabled ? 'Snap Linkit enabled' : 'Snap Linkit disabled');
        // Persist so other tabs follow; this tab has already switched
        Promise.resolve(browserAPI.storage.sync.set({ extensionEnabled: settings.extensionEnabled }))
          .catch(() => showToast('Snap Linkit: could not save the on/off state'));
        break;

      case 'open-selected-tabs':
        if (extensionActive && state.selectedElements.size > 0) {
          const urls = getUniqueUrls();
          if (urls.length > 0) {
            openTabs(urls, false);
          }
        }
        break;
    }
  });

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================

  function getSelectableElements() {
    const selectors = [
      'a[href]',
      'input[type="checkbox"]',
      'input[type="radio"]',
      'button',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="radio"]'
    ];

    return Array.from(document.querySelectorAll(selectors.join(', '))).filter(el => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }

      // SVG <a> elements also match a[href] but carry an SVGAnimatedString href
      // the rest of this script cannot act on; leave them out of the selection
      if (el.localName === 'a' && !(el instanceof HTMLAnchorElement)) return false;

      if (el instanceof HTMLAnchorElement) {
        // Skip same-page fragment links, then anything the browser cannot open
        const raw = (el.getAttribute('href') || '').trim();
        if (!raw || raw.startsWith('#')) return false;
        if (!isOpenableUrl(el.href)) return false;
      }

      return true;
    });
  }

  function getElementRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    };
  }

  // Axis-aligned rectangle intersection (no snapping tolerance)
  function rectsIntersect(r1, r2) {
    return !(
      r1.right < r2.left ||
      r1.left > r2.right ||
      r1.bottom < r2.top ||
      r1.top > r2.bottom
    );
  }

  // Scroll-aware coordinate calculation
  // Uses scroll delta to adjust start point WITHOUT mutating state.startX/Y
  function getSelectionRect() {
    // Calculate how much the page has scrolled since drag started
    const scrollDeltaX = window.scrollX - state.startScrollX;
    const scrollDeltaY = window.scrollY - state.startScrollY;

    // Adjust the start point in viewport coordinates based on scroll delta
    // If user scrolled DOWN, the start point moves UP in viewport space
    const adjustedStartX = state.startX - scrollDeltaX;
    const adjustedStartY = state.startY - scrollDeltaY;

    const left = Math.min(adjustedStartX, state.currentX);
    const top = Math.min(adjustedStartY, state.currentY);
    const width = Math.abs(state.currentX - adjustedStartX);
    const height = Math.abs(state.currentY - adjustedStartY);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  function getUniqueUrls() {
    const urls = new Set();
    state.selectedElements.forEach(el => {
      if (el instanceof HTMLAnchorElement && isOpenableUrl(el.href)) {
        urls.add(el.href);
      }
    });
    return Array.from(urls);
  }

  function getLinkTexts() {
    const texts = [];
    state.selectedElements.forEach(el => {
      if (el instanceof HTMLAnchorElement) {
        // One line per link: collapse embedded newlines and whitespace runs
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        if (text) texts.push(text);
      }
    });
    return texts;
  }

  function getDownloadableUrls() {
    const urls = [];
    const downloadExtensions = /\.(pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|jpg|jpeg|png|gif|svg)$/i;

    state.selectedElements.forEach(el => {
      if (el instanceof HTMLAnchorElement && isOpenableUrl(el.href) && downloadExtensions.test(el.href)) {
        urls.push(el.href);
      }
    });
    return urls;
  }

  // Categorize selected elements
  function categorizeSelection() {
    const result = {
      links: [],
      checkboxes: [],
      radios: [],
      buttons: []
    };

    state.selectedElements.forEach(el => {
      if (el instanceof HTMLAnchorElement) {
        result.links.push(el);
      } else if (el.type === 'checkbox' || el.getAttribute('role') === 'checkbox') {
        result.checkboxes.push(el);
      } else if (el.type === 'radio' || el.getAttribute('role') === 'radio') {
        result.radios.push(el);
      } else {
        result.buttons.push(el);
      }
    });

    return result;
  }

  // ============================================
  // UI CREATION
  // ============================================

  // Menu icons as SVG shape lists, rendered with createElementNS (no innerHTML)
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    openTabs: [
      ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
      ['polyline', { points: '15 3 21 3 21 9' }],
      ['line', { x1: '10', y1: '14', x2: '21', y2: '3' }]
    ],
    openUnloaded: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 6v6l4 2' }]
    ],
    copyUrls: [
      ['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2', ry: '2' }],
      ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]
    ],
    copyText: [
      ['path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }],
      ['polyline', { points: '14 2 14 8 20 8' }],
      ['line', { x1: '16', y1: '13', x2: '8', y2: '13' }],
      ['line', { x1: '16', y1: '17', x2: '8', y2: '17' }]
    ],
    download: [
      ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
      ['polyline', { points: '7 10 12 15 17 10' }],
      ['line', { x1: '12', y1: '15', x2: '12', y2: '3' }]
    ]
  };

  function svgIcon(shapes) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        shape.setAttribute(name, value);
      }
      svg.appendChild(shape);
    }
    return svg;
  }

  function createLasso() {
    if (lassoEl && lassoEl.isConnected) return lassoEl;
    if (lassoEl) lassoEl.remove(); // body was replaced; rebuild
    lassoEl = document.createElement('div');
    lassoEl.className = 'snaplinkit-lasso';
    lassoEl.style.display = 'none';
    document.body.appendChild(lassoEl);
    return lassoEl;
  }

  function updateLasso() {
    if (!lassoEl) return;
    const rect = getSelectionRect();
    lassoEl.style.left = `${rect.left}px`;
    lassoEl.style.top = `${rect.top}px`;
    lassoEl.style.width = `${rect.width}px`;
    lassoEl.style.height = `${rect.height}px`;
  }

  // Show menu ONLY for links
  function showMenu(x, y) {
    hideMenu();

    const urls = getUniqueUrls();
    if (urls.length === 0) return; // No links = no menu

    const downloadUrls = getDownloadableUrls();

    menuEl = document.createElement('div');
    menuEl.className = 'snaplinkit-menu';

    // Header
    const header = document.createElement('div');
    header.className = 'snaplinkit-menu-header';
    header.append(`${urls.length} link${urls.length !== 1 ? 's' : ''} selected`);
    header.appendChild(document.createElement('br'));
    const hint = document.createElement('small');
    hint.style.opacity = '0.7';
    hint.style.fontWeight = 'normal';
    hint.textContent = 'Alt+drag to remove, Shift+drag to add more';
    header.appendChild(hint);
    menuEl.appendChild(header);

    // Menu items for links only
    const items = [
      {
        label: `Open ${urls.length} in New Tabs`,
        icon: ICONS.openTabs,
        action: () => openTabs(urls, false)
      },
      {
        label: `Open ${urls.length} Unloaded`,
        icon: ICONS.openUnloaded,
        title: 'Memory saver: tabs appear but don\'t load until clicked',
        action: () => openTabs(urls, true)
      },
      {
        label: 'Copy URLs to Clipboard',
        icon: ICONS.copyUrls,
        action: () => copyToClipboard(urls.join('\n'), 'URLs copied!')
      },
      {
        label: 'Copy Link Text',
        icon: ICONS.copyText,
        action: () => copyToClipboard(getLinkTexts().join('\n'), 'Link text copied!')
      }
    ];

    if (downloadUrls.length > 0) {
      items.push({
        label: `Download ${downloadUrls.length} File${downloadUrls.length !== 1 ? 's' : ''}`,
        icon: ICONS.download,
        action: () => downloadFiles(downloadUrls)
      });
    }

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'snaplinkit-menu-item';
      btn.appendChild(svgIcon(item.icon));
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      if (item.title) {
        btn.title = item.title;
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideMenu();
        item.action();
      });
      menuEl.appendChild(btn);
    });

    document.body.appendChild(menuEl);

    // Position menu within viewport
    const menuRect = menuEl.getBoundingClientRect();
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;

    let menuX = x;
    let menuY = y;

    if (x + menuRect.width > viewWidth - 10) {
      menuX = viewWidth - menuRect.width - 10;
    }
    if (y + menuRect.height > viewHeight - 10) {
      menuY = viewHeight - menuRect.height - 10;
    }

    menuEl.style.left = `${Math.max(10, menuX)}px`;
    menuEl.style.top = `${Math.max(10, menuY)}px`;

    setTimeout(() => {
      document.addEventListener('click', handleOutsideClick);
    }, 10);
  }

  function hideMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    document.removeEventListener('click', handleOutsideClick);
  }

  function handleOutsideClick(e) {
    if (menuEl && !menuEl.contains(e.target)) {
      hideMenu();
      // Don't clear selection on outside click - allows Alt+drag to remove items
      // Selection will be cleared when user presses Escape or starts new selection without modifier
    }
  }

  function showConfirmDialog(count, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'snaplinkit-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'snaplinkit-confirm';

    const title = document.createElement('h3');
    title.textContent = `Open ${count} tabs?`;
    const message = document.createElement('p');
    message.textContent = `You're about to open ${count} tabs at once. This might slow down your browser. Are you sure?`;
    const buttons = document.createElement('div');
    buttons.className = 'snaplinkit-confirm-buttons';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'snaplinkit-confirm-btn secondary';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'snaplinkit-confirm-btn primary';
    confirmBtn.textContent = 'Open All';
    buttons.append(cancelBtn, confirmBtn);
    dialog.append(title, message, buttons);

    document.body.appendChild(overlay);
    document.body.appendChild(dialog);

    const cleanup = () => {
      overlay.remove();
      dialog.remove();
    };

    cancelBtn.addEventListener('click', cleanup);
    confirmBtn.addEventListener('click', () => {
      cleanup();
      onConfirm();
    });
    overlay.addEventListener('click', cleanup);
  }

  function showToast(message) {
    const existing = document.querySelector('.snaplinkit-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'snaplinkit-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 2500);
  }

  // ============================================
  // ACTIONS
  // ============================================

  function openTabs(urls, discardAfterOpen = false) {
    if (urls.length > settings.maxTabsWithoutConfirm) {
      showConfirmDialog(urls.length, () => doOpenTabs(urls, discardAfterOpen));
    } else {
      doOpenTabs(urls, discardAfterOpen);
    }
  }

  // Send an action to background.js and normalise the outcome. Resolves to
  // { ok: true, ...summary } or { ok: false, error }; never rejects.
  async function sendToBackground(message) {
    try {
      const response = await browserAPI.runtime.sendMessage(message);
      if (!response) return { ok: false, error: 'no response from background script' };
      if (response.error) return { ok: false, error: response.error };
      return { ok: true, ...response };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function plural(count, noun) {
    return `${count} ${noun}${count !== 1 ? 's' : ''}`;
  }

  async function doOpenTabs(urls, discardAfterOpen = false) {
    const modeText = discardAfterOpen ? ' (unloaded)' : '';
    showToast(`Opening ${plural(urls.length, 'tab')}${modeText}...`);
    clearSelection();

    const result = await sendToBackground({
      action: 'openTabs',
      urls,
      delay: settings.tabOpenDelay,
      discardAfterOpen
    });
    if (!result.ok) {
      showToast(`Snap Linkit: could not open tabs (${result.error})`);
    } else if (result.failed > 0) {
      showToast(`Snap Linkit: ${result.failed} of ${plural(result.requested, 'tab')} could not be opened`);
    }
  }

  // Legacy copy path for when the async Clipboard API is unavailable or refuses.
  // Returns execCommand's boolean instead of assuming success.
  function legacyCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy') === true;
    } catch (e) {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  async function copyToClipboard(text, successMessage) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (e) {
      copied = legacyCopy(text);
    }

    if (copied) {
      showToast(successMessage);
      clearSelection();
    } else {
      // Keep the selection so the user can retry (e.g. via Ctrl+C)
      showToast('Snap Linkit: copy failed');
    }
  }

  async function downloadFiles(urls) {
    showToast(`Downloading ${plural(urls.length, 'file')}...`);
    clearSelection();

    const result = await sendToBackground({ action: 'downloadFiles', urls });
    if (!result.ok) {
      showToast(`Snap Linkit: could not start downloads (${result.error})`);
    } else if (result.failed > 0) {
      showToast(`Snap Linkit: ${result.failed} of ${plural(result.requested, 'file')} could not be downloaded`);
    }
  }

  // Smart toggle - inverts based on majority state
  function smartToggleCheckboxes(checkboxes) {
    if (checkboxes.length === 0) return;

    // Count how many are checked
    let checkedCount = 0;
    checkboxes.forEach(el => {
      if (el.checked) checkedCount++;
    });

    // Determine majority: if most are checked, uncheck all; otherwise check all
    const shouldCheck = checkedCount <= checkboxes.length / 2;

    checkboxes.forEach(el => {
      el.checked = shouldCheck;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });

    showToast(shouldCheck ? `Checked ${checkboxes.length} items` : `Unchecked ${checkboxes.length} items`);
    clearSelection();
  }

  // Radios: select the first one in the selection
  function smartToggleRadios(radios) {
    if (radios.length === 0) return;

    // For radios, just select the first one in the selection
    const firstRadio = radios[0];
    firstRadio.checked = true;
    firstRadio.dispatchEvent(new Event('change', { bubbles: true }));

    showToast('Radio selected');
    clearSelection();
  }

  // ============================================
  // SELECTION LOGIC
  // ============================================

  function updateSelection() {
    const selRect = getSelectionRect();
    const elements = getSelectableElements();

    const currentlyInLasso = new Set();

    elements.forEach(el => {
      const elRect = getElementRect(el);
      if (rectsIntersect(selRect, elRect)) {
        currentlyInLasso.add(el);
      }
    });

    // Apply modifier logic
    if (state.modifierMode === 'add') {
      state.selectedElements = new Set([...state.persistentSelection, ...currentlyInLasso]);
    } else if (state.modifierMode === 'remove') {
      state.selectedElements = new Set(
        [...state.persistentSelection].filter(el => !currentlyInLasso.has(el))
      );
    } else {
      state.selectedElements = currentlyInLasso;
    }

    // Update visual highlights
    document.querySelectorAll('.snaplinkit-highlighted').forEach(el => {
      if (!state.selectedElements.has(el)) {
        el.classList.remove('snaplinkit-highlighted');
      }
    });

    state.selectedElements.forEach(el => {
      el.classList.add('snaplinkit-highlighted');
    });
  }

  function clearSelection() {
    document.querySelectorAll('.snaplinkit-highlighted').forEach(el => {
      el.classList.remove('snaplinkit-highlighted');
    });
    state.selectedElements.clear();
    state.persistentSelection.clear();
  }

  // Abort any in-progress drag, drop the selection and close the menu
  function cancelSelection() {
    state.isSelecting = false;
    state.isDragging = false;
    stopAutoScroll();
    if (lassoEl) lassoEl.style.display = 'none';
    document.body.classList.remove('snaplinkit-selecting');
    clearSelection();
    hideMenu();
  }

  // ============================================
  // AUTO-SCROLL
  // ============================================

  function startAutoScroll() {
    if (state.scrollInterval) return;

    state.scrollInterval = setInterval(() => {
      if (!state.isSelecting) {
        stopAutoScroll();
        return;
      }

      let scrollX = 0;
      let scrollY = 0;

      const { currentX, currentY } = state;
      const { innerWidth, innerHeight } = window;

      // Detect if cursor is near viewport edges - uses settings
      if (currentX < settings.scrollEdgeThreshold) {
        scrollX = -settings.autoScrollSpeed;
      } else if (currentX > innerWidth - settings.scrollEdgeThreshold) {
        scrollX = settings.autoScrollSpeed;
      }

      if (currentY < settings.scrollEdgeThreshold) {
        scrollY = -settings.autoScrollSpeed;
      } else if (currentY > innerHeight - settings.scrollEdgeThreshold) {
        scrollY = settings.autoScrollSpeed;
      }

      if (scrollX !== 0 || scrollY !== 0) {
        window.scrollBy(scrollX, scrollY);
        // NO mutation of state.startX/startY - getSelectionRect() handles scroll delta
        updateLasso();
        updateSelection();
      }
    }, FRAME_INTERVAL);
  }

  function stopAutoScroll() {
    if (state.scrollInterval) {
      clearInterval(state.scrollInterval);
      state.scrollInterval = null;
    }
  }

  // ============================================
  // EVENT HANDLERS
  // ============================================

  function onMouseDown(e) {
    // Left-click clears selection (if not clicking on menu or selected elements)
    if (e.button === 0) {
      if (menuEl && !menuEl.contains(e.target)) {
        hideMenu();
        clearSelection();
      } else if (!menuEl && state.selectedElements.size > 0) {
        // Clear selection on left-click anywhere when no menu is open
        clearSelection();
      }
      return;
    }

    // Right-click (button 2) triggers selection
    if (e.button !== 2) return;
    if (e.target.closest('input, textarea, select, button, [contenteditable]')) return;

    // Close menu when starting new selection (but keep selection for modifier modes)
    if (menuEl) {
      hideMenu();
    }

    // Track potential drag start - don't activate until MIN_DRAG_DISTANCE
    state.isSelecting = true;
    state.isDragging = false; // Not dragging yet - waiting for threshold
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.startScrollX = window.scrollX;
    state.startScrollY = window.scrollY;
    state.currentX = e.clientX;
    state.currentY = e.clientY;
    state.modifierMode = e.shiftKey ? 'add' : (e.altKey ? 'remove' : null);

    // Don't block context menu yet - only block if we actually drag
    // blockNextContextMenu will be set to true in onMouseMove when drag threshold is reached
    state.blockNextContextMenu = false;
  }

  function onMouseMove(e) {
    if (!state.isSelecting) return;

    state.currentX = e.clientX;
    state.currentY = e.clientY;

    // Check if we've reached the minimum drag distance
    if (!state.isDragging) {
      const dx = state.currentX - state.startX;
      const dy = state.currentY - state.startY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < MIN_DRAG_DISTANCE) {
        return; // Not dragging yet - allow normal click behavior
      }

      // Threshold reached - NOW activate selection mode
      state.isDragging = true;
      state.blockNextContextMenu = true; // Block context menu since we're dragging

      // Modifier drags build on the existing selection; a plain drag starts fresh
      if (state.modifierMode) {
        state.persistentSelection = new Set(state.selectedElements);
      } else {
        clearSelection();
      }

      // Show lasso and activate selection
      createLasso();
      lassoEl.style.display = 'block';
      lassoEl.classList.remove('add-mode', 'remove-mode');
      if (state.modifierMode === 'add') {
        lassoEl.classList.add('add-mode');
      } else if (state.modifierMode === 'remove') {
        lassoEl.classList.add('remove-mode');
      }

      document.body.classList.add('snaplinkit-selecting');
      startAutoScroll();

      // Now prevent default to stop text selection during drag
      e.preventDefault();
    }

    updateLasso();
    updateSelection();
  }

  function onMouseUp(e) {
    if (!state.isSelecting) return;
    if (e.button !== 2) return; // Right-click release

    const wasDragging = state.isDragging;
    state.isSelecting = false;
    state.isDragging = false;
    stopAutoScroll();

    if (lassoEl) lassoEl.style.display = 'none';
    document.body.classList.remove('snaplinkit-selecting');

    // If we never reached drag threshold, this was a normal click - let it pass through
    if (!wasDragging) {
      return;
    }

    if (state.selectedElements.size === 0) {
      clearSelection();
      return;
    }

    // Categorize and handle differently
    const { links, checkboxes, radios, buttons } = categorizeSelection();

    // Priority: If ONLY checkboxes/radios (no links), instant toggle
    if (links.length === 0 && (checkboxes.length > 0 || radios.length > 0)) {
      // Instant action - no menu
      if (checkboxes.length > 0) {
        smartToggleCheckboxes(checkboxes);
      }
      if (radios.length > 0) {
        smartToggleRadios(radios);
      }
      return;
    }

    // If we have links, show the menu
    if (links.length > 0) {
      showMenu(e.clientX, e.clientY);
    } else {
      // Only buttons selected - clear
      clearSelection();
    }
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && state.selectedElements.size > 0) {
      const urls = getUniqueUrls();
      if (urls.length > 0) {
        e.preventDefault();
        copyToClipboard(urls.join('\n'), 'URLs copied!');
      }
    }

    if (e.key === 'Escape') {
      cancelSelection();
    }
  }

  // ============================================
  // EVENT LISTENER MANAGEMENT
  // ============================================

  function attachEventListeners() {
    if (listenersAttached) return;

    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('contextmenu', onContextMenu, true);

    listenersAttached = true;
  }

  function detachEventListeners() {
    if (!listenersAttached) return;

    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('dragstart', onDragStart, true);
    document.removeEventListener('contextmenu', onContextMenu, true);

    listenersAttached = false;
  }

  function onDragStart(e) {
    if (state.isSelecting) e.preventDefault();
  }

  function onContextMenu(e) {
    // Block context menu if we initiated a right-click drag
    // This flag is set in onMouseDown and persists until context menu fires
    if (state.blockNextContextMenu) {
      state.blockNextContextMenu = false;
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================
  // Whether the extension runs here depends only on location.hostname and
  // the stored settings. The hostname cannot change without a real
  // navigation (history.pushState is same-origin), and settings changes
  // arrive via storage.onChanged, so no URL watcher is needed.

  // Start by loading settings, which will then check blacklist and attach listeners
  function start() {
    // XML/SVG documents have no <body> to attach UI to
    if (!document.body) return;
    loadSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

})();
