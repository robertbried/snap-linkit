/**
 * Snap Linkit - Popup Settings Controller
 * Privacy 100% Guaranteed - No data collection, no external requests
 */

(function() {
  'use strict';

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
    bindEvents();
    updateUI();
    showVersion();

    // Flush a pending debounced save if the popup closes mid-drag
    window.addEventListener('pagehide', () => {
      if (pendingSave !== null) saveNow();
    });
  });

  function cacheElements() {
    // Sliders
    elements.scrollEdgeThreshold = document.getElementById('scrollEdgeThreshold');
    elements.autoScrollSpeed = document.getElementById('autoScrollSpeed');
    elements.maxTabsWithoutConfirm = document.getElementById('maxTabsWithoutConfirm');
    elements.tabOpenDelay = document.getElementById('tabOpenDelay');

    // Value displays
    elements.scrollEdgeThresholdValue = document.getElementById('scrollEdgeThresholdValue');
    elements.autoScrollSpeedValue = document.getElementById('autoScrollSpeedValue');
    elements.maxTabsWithoutConfirmValue = document.getElementById('maxTabsWithoutConfirmValue');
    elements.tabOpenDelayValue = document.getElementById('tabOpenDelayValue');

    // Blacklist
    elements.blacklistMode = document.getElementById('blacklistMode');
    elements.blacklistInput = document.getElementById('blacklistInput');
    elements.blacklistList = document.getElementById('blacklistList');
    elements.addBlacklistBtn = document.getElementById('addBlacklistBtn');

    // Actions
    elements.resetBtn = document.getElementById('resetBtn');
    elements.saveIndicator = document.getElementById('saveIndicator');
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

  let saveIndicatorTimer = null;

  function showSaveIndicator(saved = true) {
    const indicator = elements.saveIndicator;
    if (!indicator) return;
    indicator.textContent = saved ? 'Saved!' : 'Save failed';
    indicator.classList.toggle('error', !saved);
    indicator.classList.add('visible');
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => indicator.classList.remove('visible'), saved ? 1000 : 2500);
  }

  function bindEvents() {
    // Slider events - update value display on input, save on change
    const sliders = ['scrollEdgeThreshold', 'autoScrollSpeed', 'maxTabsWithoutConfirm', 'tabOpenDelay'];
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

    // Blacklist mode dropdown
    if (elements.blacklistMode) {
      elements.blacklistMode.addEventListener('change', (e) => {
        currentSettings.blacklistMode = e.target.value;
        saveSettings();
        updateModeLabel();
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
  }

  function updateUI() {
    // Update sliders and value displays
    const sliders = ['scrollEdgeThreshold', 'autoScrollSpeed', 'maxTabsWithoutConfirm', 'tabOpenDelay'];
    sliders.forEach(id => {
      if (elements[id]) {
        elements[id].value = currentSettings[id];
      }
      if (elements[`${id}Value`]) {
        elements[`${id}Value`].textContent = currentSettings[id];
      }
    });

    // Update blacklist mode
    if (elements.blacklistMode) {
      elements.blacklistMode.value = currentSettings.blacklistMode;
    }
    updateModeLabel();

    // Render blacklist
    renderBlacklist();
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

  function blacklistBytes(list) {
    return new TextEncoder().encode(JSON.stringify(list)).length;
  }

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
  }

  function showInputError(input, message) {
    input.classList.add('error');
    input.title = message;
    setTimeout(() => {
      input.classList.remove('error');
      input.title = '';
    }, 1500);
  }

  function isValidPattern(pattern) {
    // Validate domain patterns for blacklist/whitelist
    // Valid: domain.com, *.domain.com, sub.domain.com, *.co.uk
    // Invalid: empty, just symbols, no alphanumeric, too short

    if (!pattern || pattern.length < 3) {
      return { valid: false, message: 'Pattern too short (min 3 chars)' };
    }

    if (pattern.length > 253) {
      return { valid: false, message: 'Pattern too long (max 253 chars)' };
    }

    // Must contain at least one alphanumeric character
    if (!/[a-z0-9]/.test(pattern)) {
      return { valid: false, message: 'Must contain letters or numbers' };
    }

    // Only allow valid domain characters plus wildcards
    if (/[^a-z0-9.*-]/.test(pattern)) {
      return { valid: false, message: 'Invalid characters (use a-z, 0-9, ., -, *)' };
    }

    // Must have at least one dot (domain separator)
    if (!pattern.includes('.')) {
      return { valid: false, message: 'Must include a dot (e.g., *.example.com)' };
    }

    // Reject patterns that are only dots and asterisks
    if (/^[.*]+$/.test(pattern)) {
      return { valid: false, message: 'Must include domain name' };
    }

    // Reject consecutive dots
    if (/\.\./.test(pattern)) {
      return { valid: false, message: 'Invalid: consecutive dots' };
    }

    return { valid: true };
  }

  function removeFromBlacklist(index) {
    currentSettings.blacklist.splice(index, 1);
    saveSettings();
    renderBlacklist();
  }

  async function resetToDefaults() {
    if (!confirm('Reset all settings to defaults?')) return;
    currentSettings = SnapLinkitDefaults();
    await saveSettings();
    updateUI();
  }
})();
