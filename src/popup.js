/**
 * Snap Linkit - Popup Settings Controller
 * Privacy 100% Guaranteed - No data collection, no external requests
 */

(function() {
  'use strict';

  // Pure helpers live in lib/helpers.js (loaded first by popup.html)
  const { isValidPattern, blacklistBytes, whatsNewLines, whatsNewShowsShortcuts, whatsNewShows140, normalizeReleaseAction, siteRunState, toolbarBadge } = globalThis.SnapLinkitLib;

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // Defaults live in defaults.js (shared with content.js)
  // DOM element cache
  const elements = {};

  // Current settings state (fresh copy: never alias the defaults' blacklist array)
  let currentSettings = SnapLinkitDefaults();

  // Slider drags fire many input events; coalesce them so storage.sync's
  // write-rate quota is not exhausted, and flush on change / pagehide.
  let pendingSave = null;

  function scheduleSave() {
    clearTimeout(pendingSave);
    pendingSave = setTimeout(saveNow, 300);
  }

  function saveNow() {
    clearTimeout(pendingSave);
    pendingSave = null;
    saveSettings();
  }

  // Initialize on DOM ready
  document.addEventListener('DOMContentLoaded', async () => {
    cacheElements();
    await loadSettings();
    await loadActiveHost();
    bindEvents();
    updateUI();
    showVersion();
    watchHostAccess();
    checkHostAccess();
    showWhatsNew();

    // Flush a pending debounced save if the popup closes mid-drag
    window.addEventListener('pagehide', () => {
      if (pendingSave !== null) saveNow();
    });
  });

  // Keep the toggle honest if Alt+Shift+L flips the setting while the popup is open
  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('extensionEnabled' in changes) || !elements.extensionEnabled) return;
    currentSettings.extensionEnabled = changes.extensionEnabled.newValue !== false;
    elements.extensionEnabled.checked = currentSettings.extensionEnabled;
    renderSiteState();
  });

  function cacheElements() {
    // Sliders
    elements.scrollEdgeThreshold = document.getElementById('scrollEdgeThreshold');
    elements.autoScrollSpeed = document.getElementById('autoScrollSpeed');
    elements.maxTabsWithoutConfirm = document.getElementById('maxTabsWithoutConfirm');
    elements.tabOpenDelay = document.getElementById('tabOpenDelay');
    elements.checkboxSaveGap = document.getElementById('checkboxSaveGap');

    // Value displays
    elements.scrollEdgeThresholdValue = document.getElementById('scrollEdgeThresholdValue');
    elements.autoScrollSpeedValue = document.getElementById('autoScrollSpeedValue');
    elements.maxTabsWithoutConfirmValue = document.getElementById('maxTabsWithoutConfirmValue');
    elements.tabOpenDelayValue = document.getElementById('tabOpenDelayValue');
    elements.checkboxSaveGapValue = document.getElementById('checkboxSaveGapValue');

    // When I let go
    elements.releaseAction = document.getElementById('releaseAction');

    // Blacklist
    elements.blacklistMode = document.getElementById('blacklistMode');

    // On/off toggle
    elements.extensionEnabled = document.getElementById('extensionEnabled');
    elements.blacklistInput = document.getElementById('blacklistInput');
    elements.blacklistList = document.getElementById('blacklistList');
    elements.addBlacklistBtn = document.getElementById('addBlacklistBtn');

    // Actions
    elements.resetBtn = document.getElementById('resetBtn');
    elements.saveIndicator = document.getElementById('saveIndicator');
    elements.privacyLink = document.getElementById('privacyLink');

    // Host-permission banner
    elements.permissionBanner = document.getElementById('permissionBanner');
    elements.grantAccessBtn = document.getElementById('grantAccessBtn');

    // Why Snap Linkit does nothing on this tab (item 3)
    elements.siteStateBanner = document.getElementById('siteStateBanner');
    elements.siteStateText = document.getElementById('siteStateText');
    elements.siteStateFixBtn = document.getElementById('siteStateFixBtn');
    elements.siteStateEditBtn = document.getElementById('siteStateEditBtn');

    // What's new note (Info tab)
    elements.whatsNew = document.getElementById('whatsNew');
    elements.whatsNewLines = document.getElementById('whatsNewLines');
    elements.whatsNew140 = document.getElementById('whatsNew140');
    elements.whatsNewDismiss = document.getElementById('whatsNewDismiss');
  }

  // storage.sync is the single source of truth (content.js reads only it).
  async function loadSettings() {
    try {
      const stored = await browserAPI.storage.sync.get(SnapLinkitDefaults());
      currentSettings = { ...SnapLinkitDefaults(), ...stored };
    } catch (e) {
      // Storage unavailable (e.g. extension context invalidated) - use defaults
      console.warn('[Snap Linkit] Storage error:', e.message);
      currentSettings = SnapLinkitDefaults();
    }
  }

  async function saveSettings() {
    try {
      await browserAPI.storage.sync.set(currentSettings);
      showSaveIndicator();
    } catch (error) {
      console.error('[Snap Linkit] Save error:', error);
      showSaveIndicator(false);
    }
  }

  let indicatorTimer = null;

  // Transient status badge (top-right); errors show in red for longer
  function showIndicator(text, isError, durationMs) {
    const indicator = elements.saveIndicator;
    if (!indicator) return;
    indicator.textContent = text;
    indicator.classList.toggle('error', isError);
    indicator.classList.add('visible');
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => indicator.classList.remove('visible'), durationMs);
  }

  function showSaveIndicator(saved = true) {
    showIndicator(saved ? 'Saved!' : 'Save failed', !saved, saved ? 1000 : 2500);
  }

  // A link inside a browser-action popup would navigate the popup itself,
  // so open the bundled page in a tab and close the popup. Needs no
  // permission: tabs.create and runtime.getURL are always available.
  async function openPrivacyPolicy(e) {
    e.preventDefault();
    try {
      await browserAPI.tabs.create({ url: browserAPI.runtime.getURL('privacy-policy.html') });
      window.close();
    } catch (error) {
      console.error('[Snap Linkit] Could not open privacy policy:', error);
      showIndicator('Could not open the privacy policy', true, 2500);
    }
  }

  function bindEvents() {
    // Slider events - update value display on input, save on change
    const sliders = ['scrollEdgeThreshold', 'autoScrollSpeed', 'maxTabsWithoutConfirm', 'tabOpenDelay', 'checkboxSaveGap'];
    sliders.forEach(id => {
      const slider = elements[id];
      const valueDisplay = elements[`${id}Value`];
      if (slider && valueDisplay) {
        slider.addEventListener('input', (e) => {
          const value = parseInt(e.target.value, 10);
          currentSettings[id] = value;
          valueDisplay.textContent = value;
          scheduleSave();
        });
        slider.addEventListener('change', saveNow);
      }
    });

    // On/off toggle (the same setting the Alt+Shift+L command flips; global)
    if (elements.extensionEnabled) {
      elements.extensionEnabled.addEventListener('change', (e) => {
        currentSettings.extensionEnabled = e.target.checked;
        saveSettings();
        renderSiteState();
      });
    }

    // When I let go dropdown
    if (elements.releaseAction) {
      elements.releaseAction.addEventListener('change', (e) => {
        currentSettings.releaseAction = normalizeReleaseAction(e.target.value);
        saveSettings();
      });
    }

    // Blacklist mode dropdown
    if (elements.blacklistMode) {
      elements.blacklistMode.addEventListener('change', (e) => {
        currentSettings.blacklistMode = e.target.value;
        saveSettings();
        updateModeLabel();
        renderSiteState();
      });
    }

    // Add to blacklist
    if (elements.addBlacklistBtn) {
      elements.addBlacklistBtn.addEventListener('click', addToBlacklist);
    }
    if (elements.blacklistInput) {
      elements.blacklistInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addToBlacklist();
      });
    }

    // Reset button
    if (elements.resetBtn) {
      elements.resetBtn.addEventListener('click', resetToDefaults);
    }

    // Privacy policy link
    if (elements.privacyLink) {
      elements.privacyLink.addEventListener('click', openPrivacyPolicy);
    }

    // "Grant access" in the host-permission banner
    if (elements.grantAccessBtn) {
      elements.grantAccessBtn.addEventListener('click', requestHostAccess);
    }

    // The site-state banner's buttons (item 3)
    if (elements.siteStateFixBtn) {
      elements.siteStateFixBtn.addEventListener('click', fixSiteState);
    }
    if (elements.siteStateEditBtn) {
      elements.siteStateEditBtn.addEventListener('click', editSiteRules);
    }

    // "Got it" on the what's new note
    if (elements.whatsNewDismiss) {
      elements.whatsNewDismiss.addEventListener('click', dismissWhatsNew);
    }
  }

  function updateUI() {
    // Update sliders and value displays
    const sliders = ['scrollEdgeThreshold', 'autoScrollSpeed', 'maxTabsWithoutConfirm', 'tabOpenDelay', 'checkboxSaveGap'];
    sliders.forEach(id => {
      if (elements[id]) {
        elements[id].value = currentSettings[id];
      }
      if (elements[`${id}Value`]) {
        elements[`${id}Value`].textContent = currentSettings[id];
      }
    });

    // On/off toggle
    if (elements.extensionEnabled) {
      elements.extensionEnabled.checked = currentSettings.extensionEnabled !== false;
    }

    // When I let go: an unknown stored value shows as the default and is
    // written back as the default with the next save
    currentSettings.releaseAction = normalizeReleaseAction(currentSettings.releaseAction);
    if (elements.releaseAction) {
      elements.releaseAction.value = currentSettings.releaseAction;
    }

    // Update blacklist mode
    if (elements.blacklistMode) {
      elements.blacklistMode.value = currentSettings.blacklistMode;
    }
    updateModeLabel();

    // Render blacklist
    renderBlacklist();
    renderSiteState();
  }

  // ---- Host access (site permission) ----
  // Firefox lets users revoke host permissions at any time; without them the
  // content script never runs and nothing else in the UI would say why.
  // permissions.* needs no manifest entry; the origins must match
  // host_permissions in manifest.json.
  const HOST_ORIGINS = ['http://*/*', 'https://*/*'];

  function permissionsApi() {
    const api = browserAPI.permissions;
    return api && typeof api.contains === 'function' && typeof api.request === 'function' ? api : null;
  }

  async function checkHostAccess() {
    const api = permissionsApi();
    if (!api || !elements.permissionBanner) return;
    try {
      const granted = await api.contains({ origins: HOST_ORIGINS });
      elements.permissionBanner.hidden = granted === true;
    } catch (error) {
      // Cannot tell: show the banner rather than hide a possible problem
      console.error('[Snap Linkit] permissions.contains failed:', error);
      elements.permissionBanner.hidden = false;
    }
  }

  async function requestHostAccess() {
    const api = permissionsApi();
    if (!api || !elements.permissionBanner) return;
    let granted = false;
    try {
      // Called straight from the click, before any await, so the user gesture is still live
      granted = await api.request({ origins: HOST_ORIGINS });
    } catch (error) {
      console.error('[Snap Linkit] permissions.request failed:', error);
      granted = false;
    }
    if (granted === true) {
      elements.permissionBanner.hidden = true;
      // Content scripts do not inject into pages that are already loaded
      showIndicator('Access granted \u2014 reload open tabs', false, 2500);
    } else {
      elements.permissionBanner.hidden = false;
      showIndicator('Access was not granted', true, 2500);
    }
  }

  // Keep the banner in step with grants/revocations made while the popup is open
  function watchHostAccess() {
    const api = permissionsApi();
    if (!api) return;
    for (const event of [api.onAdded, api.onRemoved]) {
      if (event && typeof event.addListener === 'function') {
        event.addListener(checkHostAccess);
      }
    }
  }

  // ---- Why Snap Linkit does nothing on this tab (item 3) ----
  // Wording from issue-1/PRODUCT-ISSUE-SILENT-STATES.md. Switched off applies to
  // every tab; a site rule only to the active tab's site (http/https only: it
  // never runs elsewhere anyway). The rule is siteRunState, shared with content.js.
  let activeHost = null;

  async function loadActiveHost() {
    activeHost = null;
    try {
      const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
      const url = tab && typeof tab.url === 'string' ? new URL(tab.url) : null;
      if (url && (url.protocol === 'http:' || url.protocol === 'https:')) activeHost = url.hostname;
    } catch (error) {
      // No URL (no access to this tab): only "switched off" can be shown
      activeHost = null;
    }
  }

  function siteState() {
    return siteRunState({
      enabled: currentSettings.extensionEnabled !== false, mode: currentSettings.blacklistMode,
      patterns: currentSettings.blacklist || [], hostname: activeHost || '',
    });
  }

  function renderSiteState() {
    const banner = elements.siteStateBanner, text = elements.siteStateText;
    if (!banner || !text) return;
    const st = siteState();
    const reason = st.reason === 'off' || (activeHost && st.reason) ? st.reason : null;
    text.replaceChildren();
    if (reason === 'off') {
      text.append('Snap Linkit is switched off.');
    } else if (reason === 'blocked') {
      const code = document.createElement('code');
      code.textContent = st.rule;
      text.append('Snap Linkit is off on this site (rule: ', code, ').');
    } else if (reason === 'notListed') {
      text.append('Snap Linkit is off on this site: it isn\u2019t on your \u201cEnabled only on\u201d list.');
    }
    banner.hidden = !reason;
    banner.setAttribute('data-reason', reason || '');
    if (elements.siteStateFixBtn) {
      elements.siteStateFixBtn.hidden = !(reason === 'off' || reason === 'blocked');
      elements.siteStateFixBtn.textContent = reason === 'off' ? 'Switch on' : 'Remove rule';
    }
    if (elements.siteStateEditBtn) elements.siteStateEditBtn.hidden = !(reason === 'blocked' || reason === 'notListed');
  }

  // "Switch on" or "Remove rule". Open pages pick the change up straight away (content.js listens for it).
  function fixSiteState() {
    const st = siteState();
    if (st.reason === 'off') {
      currentSettings.extensionEnabled = true;
      if (elements.extensionEnabled) elements.extensionEnabled.checked = true;
    } else if (st.reason === 'blocked' && activeHost) {
      const i = currentSettings.blacklist.indexOf(st.rule);
      if (i < 0) return;
      currentSettings.blacklist.splice(i, 1);
      renderBlacklist();
    } else {
      return;
    }
    saveSettings();
    renderSiteState();
  }

  // "Edit rules": the Settings tab, with the cursor in the site list's input
  function editSiteRules() {
    const settingsTab = document.getElementById('tab-settings');
    if (settingsTab) settingsTab.checked = true;
    if (elements.blacklistInput && typeof elements.blacklistInput.focus === 'function') elements.blacklistInput.focus();
  }

  // ---- What's new note (1.5.0, plus the 1.4.0 lines and the 1.3.0 shortcut lines) ----
  // background.js stores whatsNew = { version, badge, shortcuts, lines140 } in
  // storage.local on an update from before 1.5.0. Opening the popup clears the
  // toolbar badge and tooltip; the note stays until "Got it". The 1.5.0 and
  // 1.4.0 lines are in popup.html; the 1.4.0 block is shown only for an update
  // from before 1.4.0 (or an older note never dismissed). The shortcut lines
  // (update from before 1.3.0) are rebuilt from the current shortcuts, so one
  // customised since is left out.
  async function clearWhatsNewBadge() {
    // Without site access the badge stays "!" (item 2: it wins over "NEW")
    const api = permissionsApi();
    let access = null;
    try {
      access = api ? (await api.contains({ origins: HOST_ORIGINS })) === true : null;
    } catch (error) {
      access = null;
    }
    const badge = toolbarBadge({ hostAccess: access, whatsNewBadge: false });
    if (badge.text) {
      await browserAPI.action.setBadgeText({ text: badge.text });
      await browserAPI.action.setBadgeBackgroundColor({ color: badge.color });
      await browserAPI.action.setBadgeTextColor({ color: badge.textColor });
      await browserAPI.action.setTitle({ title: badge.title });
      return;
    }
    await browserAPI.action.setBadgeText({ text: '' });
    // Back to the manifest's tooltip. Not null: Firefox accepts null as "reset", but
    // Chrome's action.setTitle requires a string and rejects null.
    await browserAPI.action.setTitle({ title: browserAPI.runtime.getManifest().action.default_title });
  }

  async function showWhatsNew() {
    if (!elements.whatsNew || !elements.whatsNewLines) return;
    try {
      const { whatsNew } = await browserAPI.storage.local.get('whatsNew');
      if (!whatsNew) return;
      elements.whatsNewLines.replaceChildren();
      if (elements.whatsNew140) elements.whatsNew140.hidden = !whatsNewShows140(whatsNew);
      if (whatsNewShowsShortcuts(whatsNew)) {
        const [commands, platform] = await Promise.all([
          browserAPI.commands.getAll(),
          browserAPI.runtime.getPlatformInfo(),
        ]);
        const lines = whatsNewLines(commands, platform.os === 'mac');
        // None left on its default (customised or cleared): no shortcut lines
        if (lines.length > 0) lines.unshift('New keyboard shortcuts:');
        for (const line of lines) {
          const row = document.createElement('div');
          row.textContent = line;
          elements.whatsNewLines.appendChild(row);
        }
      }
      elements.whatsNew.hidden = false;
      if (whatsNew.badge !== false) {
        await browserAPI.storage.local.set({ whatsNew: { ...whatsNew, badge: false } });
        await clearWhatsNewBadge();
      }
    } catch (error) {
      console.warn("[Snap Linkit] What's new note unavailable:", error.message);
    }
  }

  async function dismissWhatsNew() {
    elements.whatsNew.hidden = true;
    try {
      await browserAPI.storage.local.remove('whatsNew');
      await clearWhatsNewBadge();
    } catch (error) {
      console.warn("[Snap Linkit] Could not dismiss the what's new note:", error.message);
      showIndicator('Could not save', true, 3000);
    }
  }

  function showVersion() {
    const label = document.getElementById('versionLabel');
    if (!label) return;
    try {
      label.textContent = `Snap Linkit v${browserAPI.runtime.getManifest().version}`;
    } catch (e) {
      // Leave the plain name if the manifest is unavailable
    }
  }

  function updateModeLabel() {
    const label = document.getElementById('blacklistModeLabel');
    if (label) {
      label.textContent = currentSettings.blacklistMode === 'blacklist'
        ? 'Disabled on:'
        : 'Enabled only on:';
    }
  }

  function renderBlacklist() {
    if (!elements.blacklistList) return;

    const list = currentSettings.blacklist || [];
    elements.blacklistList.replaceChildren();

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'blacklist-empty';
      empty.textContent = 'No sites added';
      elements.blacklistList.appendChild(empty);
      return;
    }

    list.forEach((pattern, index) => {
      const item = document.createElement('div');
      item.className = 'blacklist-item';
      const text = document.createElement('span');
      text.className = 'pattern';
      text.textContent = pattern;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.addEventListener('click', () => removeFromBlacklist(index));
      item.append(text, removeBtn);
      elements.blacklistList.appendChild(item);
    });
  }

  const MAX_BLACKLIST_ENTRIES = 100;
  // storage.sync refuses items over 8 KB (QUOTA_BYTES_PER_ITEM). Keep the
  // serialized list well below that so a save can never be rejected.
  const MAX_BLACKLIST_BYTES = 6144;

  function addToBlacklist() {
    const input = elements.blacklistInput;
    if (!input) return;

    const pattern = input.value.trim().toLowerCase();
    if (!pattern) return;

    // Check for size limits
    if (currentSettings.blacklist.length >= MAX_BLACKLIST_ENTRIES) {
      showInputError(input, `Maximum ${MAX_BLACKLIST_ENTRIES} entries allowed`);
      return;
    }
    if (blacklistBytes([...currentSettings.blacklist, pattern]) > MAX_BLACKLIST_BYTES) {
      showInputError(input, 'Site list is full (sync storage limit)');
      return;
    }

    // Check for duplicates
    if (currentSettings.blacklist.includes(pattern)) {
      showInputError(input, 'Pattern already exists');
      return;
    }

    // Validate pattern
    const validation = isValidPattern(pattern);
    if (!validation.valid) {
      showInputError(input, validation.message);
      return;
    }

    currentSettings.blacklist.push(pattern);
    input.value = '';
    saveSettings();
    renderBlacklist();
    renderSiteState();
  }

  function showInputError(input, message) {
    input.classList.add('error');
    input.title = message;
    setTimeout(() => {
      input.classList.remove('error');
      input.title = '';
    }, 1500);
  }

  function removeFromBlacklist(index) {
    currentSettings.blacklist.splice(index, 1);
    saveSettings();
    renderBlacklist();
    renderSiteState();
  }

  async function resetToDefaults() {
    if (!confirm('Reset all settings to defaults?')) return;
    currentSettings = SnapLinkitDefaults();
    await saveSettings();
    updateUI();
  }
})();
