/**
 * Snap Linkit - Content Script
 * Privacy 100% Guaranteed - No data collection, no external requests
 */

(function() {
  'use strict';

  // Pure helpers live in lib/helpers.js (loaded first by the manifest)
  const {
    isOpenableUrl, matchesPattern, rectsIntersect, rectFromPoints, dragStartPoint,
    uniqueMatch, firstUsableAnchor, dragPageChangedMessage, dragStartFailedMessage, DRAG_OFF_REASONS, TRACKED_CHECKBOX_SELECTOR,
    dragDiagLine, // @test-only
    saveLogLine, // @test-only
    dragFollowNeeded, trackingLock, fixedContainerAllows, anchorLostOutcome, releaseAfterCarryOn, saveGapMs, siteRunState,
    autoScrollStep, autoScrollZone, autoScrollRate, autoScrollDelta, clampToArea, liveCountText,
    isDownloadableUrl, majorityShouldCheck, plural, fitMenuAxis, clampMenuAxis,
    normalizeReleaseAction, dragModifierMode, isStyleHidden, proxyLabelIndexes,
    TRACKED_TABLE_SELECTOR, isTrackedCheckbox, afterClickOutcome, ordinaryCheckboxMessage,
    selectableVerdict, labelMapFrom, touchesSelection, pageChangeMarksStale,
    carefulCheckboxMessage, carefulProgressMessage, carefulConfirmText,
    ordinaryUnreadMessage, carefulFallbackMessage, carefulNotStartedMessage,
    faultMatches, // @test-only
  } = globalThis.SnapLinkitLib;

  // ============================================
  // SETTINGS
  // ============================================
  // Defaults live in defaults.js (shared with popup.js)
  // Mutable settings object - starts with defaults, hydrated async
  let settings = SnapLinkitDefaults();

  // Hardcoded (not configurable - frame timing)
  const FRAME_INTERVAL = 16;
  const MIN_DRAG_DISTANCE = 5; // Pixels to drag before activating selection (allows normal clicks)
  const MENU_MARGIN = 10;      // Gap the action menu keeps from the window edges when it fits

  // Careful saving of Fandom's tracking checkboxes (brief 2).
  // PROVISIONAL: every value below is a placeholder until Rob's measurement
  // (design decision 15). Not to ship as defaults without it.
  // The wait after each confirmed save is the popup's "Delay Between Saves" (settings.checkboxSaveGap, item 6)
  const CHECKBOX_SAVE_TIMEOUT_MS = 10000; // PROVISIONAL: T_box, the longest wait for one save
  const CHECKBOX_CONFIRM_ABOVE = 30;      // PROVISIONAL: ask first when more boxes than this need saving
  const CHECKBOX_SAVE_ESTIMATE_MS = 300;  // PROVISIONAL: assumed time of one save, used only for the confirm's estimate
  const SAVING_CLASS = 'is-saving';       // Fandom's class while a box is saving
  // @test-only-begin (store builds leave out everything to the matching end, and every
  // line marked "@test-only": build.mjs stripTestOnly; item 4, big run 2)
  // Test-build console lines: one per Fandom checkbox save (Rob's measurement)
  // and one per drag (brief 4's diagnostics). Test build only:
  // `node build.mjs --test` switches it on in the packaged copy; src/ keeps it off.
  const SAVE_LOG = false;
  // Failure injection for the brief 2b lab tests. Lab builds only:
  // `node build.mjs --faults` switches it on in the packaged copy; src/ and
  // Rob's test zips keep it off; store zips don't contain it at all.
  const FAULTS = false;
  // @test-only-end

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
    anchor: null,        // { el, offX, offY, key, root }: the element pressed (brief 3); null = old maths
    pressFailed: false,  // choosing the anchor threw at the press: a drag from it is cancelled (brief 5)
    trackLock: false,    // pressed in a Fandom tracking cell: the drag selects only tracking boxes (B)
    pressEl: null,       // the element pressed (not brief 5b's fallback anchor): the fixed-container rule (C)
    lastSeen: null,      // { x, y }: the start's page position at the last update while it had an anchor; after the
                         // pressed element is lost for good, the drag carries on from here (ultrareview 1, #1)
    carried: false,      // this drag carried on after losing its pressed element: its release may not save
                         // tracking boxes (releaseAfterCarryOn). Set in refreshDragAnchor, reset at the press only.
  };

  // Extension active state (can be disabled via blacklist)
  let extensionActive = false;
  let listenersAttached = false;

  // ============================================
  // DOM ELEMENTS
  // ============================================
  let lassoEl = null;
  let lassoCount = null; // the live count on the box (its child)
  let menuEl = null;
  let confirmDialog = null; // { el, cancel } while the "Open N tabs?" confirm is showing
  let menuDrag = null;      // { offsetX, offsetY, width, height, moved } while the menu is being dragged

  // ============================================
  // BROWSER API
  // ============================================
  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

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

  // On or off here, from the toggle and the site rules: the same rule the popup
  // uses to say why (siteRunState, item 3)
  function shouldRunOnCurrentSite() {
    return siteRunState({
      enabled: settings.extensionEnabled, mode: settings.blacklistMode,
      patterns: settings.blacklist || [], hostname: window.location.hostname,
    }).runs;
  }

  function updateExtensionState() {
    const shouldRun = shouldRunOnCurrentSite();

    if (shouldRun && !extensionActive) {
      extensionActive = true;
      attachEventListeners();
    } else if (!shouldRun && extensionActive) {
      extensionActive = false;
      // An open confirm ("Open N tabs?", "Check N items?") goes as if cancelled:
      // nothing it offered may start while Snap Linkit is off (ultrareview 2, #3)
      if (confirmShowing()) confirmDialog.cancel();
      if (carefulRun) carefulRun.stop = true; // Escape no longer reaches us; stop before the next click
      detachEventListeners();
      cancelSelection('switched-off');
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

  // Everything a drag can select
  const SELECTABLE_SELECTOR = [
    'a[href]',
    'input[type="checkbox"]',
    'input[type="radio"]',
    'button',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="radio"]'
  ].join(', ');

  // Is this element selectable? The one place the rules are applied (pure
  // rules: selectableVerdict): a hidden element only when it is a checkbox
  // showing through a visible label; no SVG links; no same-page fragment links
  // or links the browser can't open. Used during a drag for elements that touch
  // the selection box, and again at release.
  function isSelectableElement(el) {
    const hidden = isStyleHidden(window.getComputedStyle(el));
    const isLink = el instanceof HTMLAnchorElement;
    return selectableVerdict({
      hidden,
      hasProxyLabels: hidden ? proxyLabels(el).length > 0 : false,
      isSvgLink: el.localName === 'a' && !isLink,
      isLink,
      rawHref: isLink ? el.getAttribute('href') : null,
      openable: isLink ? isOpenableUrl(el.href) : false,
    });
  }

  // Labels that stand in for a custom-styled (hidden) checkbox, so it is
  // hit-tested and highlighted through them (issue #1). The input itself is
  // still what gets clicked. Radios are left out on purpose: hidden radios
  // drive CSS-only tabs and star ratings. So is a hidden checkbox that declares
  // another role, such as MediaWiki's table-of-contents toggle (role="button").
  // [] for every other element.
  // During a drag every element is asked several times (check, hit test,
  // highlight) and each answer reads computed styles and boxes, so the answers
  // are kept for the drag (brief 7: dragCache.proxies, cleared when the page
  // changes).
  let proxyCache = null;
  function proxyLabels(el) {
    if (proxyCache && proxyCache.has(el)) return proxyCache.get(el);
    const labels = findProxyLabels(el);
    if (proxyCache) proxyCache.set(el, labels);
    return labels;
  }

  function findProxyLabels(el) {
    if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return [];
    const role = el.getAttribute('role');
    if (role && role !== 'checkbox' && role !== 'switch') return [];
    const labels = labelsOf(el);
    if (labels.length === 0) return [];
    const stateOf = node => {
      const style = window.getComputedStyle(node);
      return { hidden: isStyleHidden(style), displayNone: style.display === 'none', rect: node.getBoundingClientRect() };
    };
    return proxyLabelIndexes(stateOf(el), labels.map(stateOf)).map(i => labels[i]);
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

  // Selection rectangle in viewport px. Its start is tied to the element the
  // drag was pressed on (brief 3), so content above it that changes height
  // mid-drag (an ad, lazy content) can't move the start; without an anchor it
  // is the press point moved by the scroll since (pure core: dragStartPoint).
  function getSelectionRect() {
    const a = state.anchor;
    const scroll = { x: window.scrollX, y: window.scrollY };
    // No anchor: the press moved by the scroll, or, once the pressed element
    // was lost for good, where it was last seen (also a page position)
    const fallback = state.lastSeen
      ? { x: state.lastSeen.x, y: state.lastSeen.y, scrollX: 0, scrollY: 0 }
      : { x: state.startX, y: state.startY, scrollX: state.startScrollX, scrollY: state.startScrollY };
    const start = dragStartPoint(
      a ? { offX: a.offX, offY: a.offY } : null,
      a ? anchorBox(a.el) : null,
      scroll,
      fallback
    );
    if (a) state.lastSeen = { x: start.x + scroll.x, y: start.y + scroll.y };
    if (SAVE_LOG && dragDiag) dragDiag.lastStartPageY = start.y + scroll.y; // @test-only: test builds: the drag line's gap
    // A2: the pointer end stays inside the visible window (nothing unseen is selected)
    return rectFromPoints(start, clampToArea({ x: state.currentX, y: state.currentY }, visibleArea()));
  }

  // ---- The drag's element cache (brief 7) ----
  // Re-checking every link and input on every update made long drags slow on
  // big pages (item 16). Per drag, the candidates are found once, each one's
  // selectable verdict is worked out only when it first touches the selection
  // box, and labels come from one map. Boxes are still read on every update, so
  // layout shifts are followed. Any page change (nodes added or removed; class,
  // style, hidden, type, href or role changed) or a resize marks the cache
  // stale and the next update rebuilds it; Snap Linkit's own changes don't
  // count. Released when the drag ends, however it ends.
  const UI_SELECTOR = '.snaplinkit-lasso, .snaplinkit-menu, .snaplinkit-toast, .snaplinkit-confirm-overlay, .snaplinkit-confirm';
  let dragCache = null; // { list, verdicts, proxies, labelMap, stale, rebuilds, observer, onResize }

  function isOwnUi(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!el && typeof el.closest === 'function' && !!el.closest(UI_SELECTOR);
  }

  function startDragCache() {
    endDragCache();
    const c = { list: null, verdicts: new Map(), proxies: new Map(), labelMap: null, stale: false, rebuilds: 0, observer: null, onResize: null };
    c.observer = new MutationObserver((records) => {
      if (c.stale) return;
      for (const r of records) {
        const nodes = [...(r.addedNodes || []), ...(r.removedNodes || [])];
        const facts = {
          type: r.type, attributeName: r.attributeName, oldValue: r.oldValue,
          newValue: r.type === 'attributes' && r.target && typeof r.target.getAttribute === 'function' ? r.target.getAttribute(r.attributeName) : null,
          inUi: isOwnUi(r.target),
          nodesAllUi: nodes.length > 0 && nodes.every(isOwnUi),
        };
        if (pageChangeMarksStale(facts)) { c.stale = true; return; }
      }
    });
    c.observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'type', 'href', 'role'],
    });
    c.onResize = () => { c.stale = true; };
    window.addEventListener('resize', c.onResize);
    dragCache = c;
  }

  function endDragCache() {
    if (!dragCache) return;
    dragCache.observer.disconnect();
    window.removeEventListener('resize', dragCache.onResize);
    dragCache = null;
  }

  // An element's labels: from the drag's label map (one pass over the page's
  // labels), else the browser's own lookup
  function labelsOf(el) {
    if (!dragCache) return Array.from(el.labels || []);
    if (!dragCache.labelMap) {
      dragCache.labelMap = labelMapFrom(Array.from(document.querySelectorAll('label'), (l) => [l, l.control]));
    }
    return dragCache.labelMap.get(el) || [];
  }

  // ---- The drag's anchor (brief 3) ----

  // An element node (nodeType 1: the same test in every frame and world)
  function isElementNode(n) {
    return !!n && n.nodeType === 1 && typeof n.getBoundingClientRect === 'function';
  }

  // The element's box, or null when it has left the page or has no box (0x0)
  function anchorBox(el) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 ? null : r;
  }

  // The next node up from n, crossing out of a shadow root to its host; null
  // at the top. The one walk for C's fixed container (nearestFixed,
  // isInsideComposed) and 5b's fixed-or-sticky anchor rule (inFixedOrSticky).
  function composedParent(n) {
    return n.parentElement || (typeof n.getRootNode === 'function' && n.getRootNode().host) || null;
  }

  // Inside a position: fixed or sticky element (crossing shadow roots)? Such an
  // element stays put while the page scrolls, so a start tied to it would move
  // with the window: the anchor is looked for under it instead (brief 5b).
  function inFixedOrSticky(el) {
    for (let n = el; isElementNode(n); n = composedParent(n)) {
      const pos = window.getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  function linkText(a) {
    return a.textContent.replace(/\s+/g, ' ').trim();
  }

  // How to find the same element again if the page replaces it: a Fandom
  // tracking label by its box's table and row, else an id, else a link by its
  // href and text. null = no trustworthy key.
  function anchorKey(el) {
    if (el.localName === 'label' && el.control && isTrackedBox(el.control)) {
      return { kind: 'tracked', tableId: el.control.getAttribute('data-table-id'), rowId: el.control.getAttribute('data-tpt-row-id') };
    }
    if (el.id) return { kind: 'id', id: el.id };
    if (el instanceof HTMLAnchorElement) return { kind: 'link', href: el.href, text: linkText(el) };
    return null;
  }

  // The one element matching the key (connected, with a box), or null for
  // none or several
  function refindAnchor(key, root) {
    if (!key || !root || typeof root.querySelectorAll !== 'function') return null;
    let found = null;
    if (key.kind === 'tracked') {
      const box = uniqueMatch(Array.from(root.querySelectorAll('input[type="checkbox"][data-table-id][data-tpt-row-id]'))
        .filter(i => i.getAttribute('data-table-id') === key.tableId && i.getAttribute('data-tpt-row-id') === key.rowId && isTrackedBox(i)));
      found = box ? uniqueMatch(Array.from(box.labels || []).filter(l => anchorBox(l))) : null;
    } else if (key.kind === 'id') {
      found = uniqueMatch(Array.from(root.querySelectorAll('#' + CSS.escape(key.id))));
    } else if (key.kind === 'link') {
      found = uniqueMatch(Array.from(root.querySelectorAll('a[href]'))
        .filter(a => a instanceof HTMLAnchorElement && a.href === key.href && linkText(a) === key.text));
    }
    return found && anchorBox(found) ? found : null;
  }

  // The element a drag is tied to for an element pressed (or found under the
  // press point): its Fandom tracking label, else the link it sits in, else the
  // element itself. The one place this mapping lives (brief 6 adds its step here).
  function mapToAnchorElement(el) {
    const label = el.closest('label');
    if (label && label.control && isTrackedBox(label.control)) return label;
    return el.closest('a[href]') || el;
  }

  // Every element under a point, top to bottom, including those inside open
  // shadow roots: document.elementsFromPoint only gives a shadow root's host,
  // so each open root is asked too and its elements go just before the host.
  // Closed roots stay their host.
  function elementsUnderPoint(x, y) {
    const out = [];
    const walk = (root) => {
      if (typeof root.elementsFromPoint !== 'function') return;
      for (const n of root.elementsFromPoint(x, y)) {
        if (out.includes(n)) continue;
        if (root !== document && n.getRootNode() !== root) continue; // outside this root: the outer walk has it
        if (n.shadowRoot && n.shadowRoot !== root) walk(n.shadowRoot);
        out.push(n);
      }
    };
    walk(document);
    return out;
  }

  // At the press: the element pressed (the real one inside an open shadow
  // root), mapped to its tracking label or link, and the pointer's offset inside
  // it. If that element is inside a fixed or sticky element, or has no box
  // (0x0), the anchor is the first usable element under the press point instead
  // (brief 5b: the element pressed itself, then document.elementsFromPoint, top
  // to bottom; see firstUsableAnchor), so the start is the same as before and
  // still follows layout shifts. Snap Linkit's own UI never qualifies: all of it
  // is position: fixed (pinned by a unit test). null keeps the old maths:
  // nothing usable above <html>/<body>, or no element at all.
  function pickDragAnchor(e) {
    const hit = pressedElement(e);
    if (!hit || typeof hit.closest !== 'function') return diagPick(null, DRAG_OFF_REASONS.noElement, hit, e);
    faultPoint('anchor'); // @test-only: lab builds: choosing the anchor throws (the drag line's "off:threw")
    const pressed = mapToAnchorElement(hit);
    const reason = inFixedOrSticky(pressed) ? DRAG_OFF_REASONS.fixedOrSticky
      : !anchorBox(pressed) ? DRAG_OFF_REASONS.noBox : null;
    let el = pressed;
    if (reason) {
      // Only now is the point asked (normal presses cost nothing extra), and
      // lazily: the element pressed itself may already do
      const candidates = (function* () { yield hit; yield* elementsUnderPoint(e.clientX, e.clientY); })();
      el = firstUsableAnchor(candidates, {
        isStop: (n) => !isElementNode(n) || n === document.documentElement || n === document.body,
        map: mapToAnchorElement,
        usable: (n) => !inFixedOrSticky(n) && !!anchorBox(n),
      });
      if (!el) return diagPick(null, reason, pressed, e);
    }
    const r = anchorBox(el);
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : document;
    return diagPick({ el, offX: e.clientX - r.left, offY: e.clientY - r.top, key: anchorKey(el), root }, reason, pressed, e);
  }

  // The element a press landed on: the real one inside an open shadow root,
  // else the event's target; null when there is no element
  function pressedElement(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.find(isElementNode) || (isElementNode(e.target) ? e.target : null);
  }

  // B: was the drag pressed in a Fandom tracking cell (the box, its label, or
  // anywhere else in the cell, such as its wrapper's padding)? Decided from
  // the element pressed; the anchor is chosen as before (brief 6 is deferred).
  function pressInTrackingCell(el) {
    if (!isElementNode(el) || typeof el.closest !== 'function') return false;
    const label = el.closest('label');
    const cell = el.closest('td');
    return trackingLock({
      isTrackedBox: isTrackedBox(el),
      labelsTrackedBox: Boolean(label && label.control && isTrackedBox(label.control)),
      cellHasTrackedBox: Boolean(cell) && Boolean(trackedBoxOfCell(cell)),
    });
  }

  // The tracking box whose own cell this is (its nearest <td>), or null. A cell
  // that only wraps a whole tracking table (a page laid out in a table) is not
  // a tracking cell.
  function trackedBoxOfCell(cell) {
    return Array.from(cell.querySelectorAll(TRACKED_CHECKBOX_SELECTOR)).find((b) => isTrackedBox(b) && b.closest('td') === cell) || null;
  }

  // C: the nearest position: fixed element around el (crossing shadow roots), or null
  function nearestFixed(el) {
    for (let n = el; isElementNode(n); n = composedParent(n)) {
      if (window.getComputedStyle(n).position === 'fixed') return n;
    }
    return null;
  }

  // Is el inside container (crossing shadow roots)?
  function isInsideComposed(container, el) {
    for (let n = el; n; n = composedParent(n)) {
      if (n === container) return true;
    }
    return false;
  }

  // C: an element in a fixed container is selectable only when the drag was
  // pressed inside that same container (judged from the element pressed)
  function fixedRuleAllows(el) {
    const box = nearestFixed(el);
    const ok = fixedContainerAllows({ inFixed: Boolean(box), pressedInside: Boolean(box) && isElementNode(state.pressEl) && isInsideComposed(box, state.pressEl) });
    if (!ok && SAVE_LOG && dragDiag) dragDiag.fixedOut.add(el); // @test-only
    return ok;
  }

  // The drag's candidates: everything selectable, or only Fandom's tracking
  // boxes on a drag pressed in a tracking cell (B). Normal pages are unchanged.
  function candidateList() {
    if (state.trackLock) return Array.from(document.querySelectorAll(TRACKED_CHECKBOX_SELECTOR)).filter(isTrackedBox);
    return Array.from(document.querySelectorAll(SELECTABLE_SELECTOR));
  }

  // Before each update: is the pressed element still there? If the page
  // replaced it, find it again by its key; when that isn't possible, cancel
  // the drag and say so on screen (nothing is clicked, opened or saved; the
  // browser menu stays blocked on the release). false = cancelled.
  // Would this release toggle tracking boxes after the drag carried on?
  function carriedReleaseRefused() {
    if (!state.carried) return false;
    let links = 0;
    let trackedBoxes = 0;
    for (const el of state.selectedElements) {
      if (el instanceof HTMLAnchorElement) links++;
      else if (isTrackedBox(el)) trackedBoxes++;
    }
    return releaseAfterCarryOn({ carried: state.carried, links, trackedBoxes }) === 'refuse';
  }

  function refreshDragAnchor() {
    const a = state.anchor;
    if (!a || anchorBox(a.el)) return true;
    const found = refindAnchor(a.key, a.root);
    if (found) {
      a.el = found;
      if (SAVE_LOG && dragDiag) dragDiag.refinds++; // @test-only
      return true;
    }
    // Gone for good. A drag locked to tracking boxes is cancelled (it could
    // save the wrong boxes); any other drag carries on from where the pressed
    // element was last seen (state.lastSeen, kept by getSelectionRect)
    if (anchorLostOutcome({ trackLock: state.trackLock }) === 'carry-on') {
      state.anchor = null;
      state.carried = true;
      if (SAVE_LOG && dragDiag) dragDiag.carried = true; // @test-only
      return true;
    }
    if (SAVE_LOG && dragDiag) dragDiag.refindCancelled = true; // @test-only
    cancelSelection('page-changed');
    showToastOrLog(dragPageChangedMessage(), { sticky: true });
    return false;
  }

  // @test-only-begin
  // ---- Test builds only (SAVE_LOG): one diagnostic console line per drag (brief 4) ----
  // A record is made at the press, filled in as the drag goes and written once
  // when a drag that passed the 5 px threshold ends (release, Esc, page changed,
  // switched off, or replaced by a new press). Nothing here runs or prints in the
  // store build. No boxes are read during the drag: one read at the press, one
  // at the end. It never throws into the drag: a failure is reported as
  // "[Snap Linkit] drag line failed: ...".
  let dragDiag = null;
  let dragDiagCount = 0;

  function diagFailed(error) {
    console.error(`[Snap Linkit] drag line failed: ${error && error.message ? error.message : String(error)}`);
  }

  // The tracking box an element stands for (the box, or its label), else null
  function diagTrackedBox(el) {
    if (el instanceof HTMLInputElement && isTrackedBox(el)) return el;
    if (el.localName === 'label' && el.control && isTrackedBox(el.control)) return el.control;
    return null;
  }

  // An element's name in the line: the Fandom row name, else "tag.firstclass"
  // (never link text, URLs or other IDs: decision Q8 and its brief 4 exception)
  function diagName(el) {
    if (!isElementNode(el)) return null;
    const box = diagTrackedBox(el);
    if (box) return box.getAttribute('data-tpt-row-id');
    // Snap Linkit's own classes (snaplinkit-highlighted, ...) are not the page's
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).find((c) => c && !c.startsWith('snaplinkit-'));
    return el.localName + (cls ? '.' + cls : '');
  }

  // The pressed row. A press elsewhere in a tracking cell (its wrapper or
  // padding) is named after the cell's box. Diagnostic only: the anchor stays
  // the element pressed (changing that is brief 6).
  function diagPressedName(el) {
    if (!isElementNode(el) || diagTrackedBox(el) || typeof el.closest !== 'function') return diagName(el);
    const cell = el.closest('td');
    const box = cell ? trackedBoxOfCell(cell) : null;
    return box ? box.getAttribute('data-tpt-row-id') : diagName(el);
  }

  function diagPlace(rec, el, clientY) {
    const r = el.getBoundingClientRect();
    rec.el = el;
    rec.pressPageY = r.top + window.scrollY;
    rec.offY = clientY - r.top;
  }

  // At the press, before the anchor is chosen. The record starts as "off:threw"
  // and diagPick overwrites that when pickDragAnchor returns; onMouseDown's
  // catch records a throw through diagPick too, so the marker is only a backstop.
  function diagPress(e) {
    try {
      if (dragDiag && dragDiag.started) diagWrite('replaced');
      const el = isElementNode(e.target) ? e.target : null;
      dragDiag = { started: false, protection: 'off:' + DRAG_OFF_REASONS.threw, anchor: 'none', key: 'none',
        refinds: 0, refindCancelled: false, el: null, pressed: el ? diagPressedName(el) : null, pressPageY: null,
        offY: null, updates: 0, slowest: 0, scrollPause: 0, lastScrollUpdate: null, lastStartPageY: null, follows: 0, fixedOut: new Set(), topSpeed: 0, carried: false };
      if (el) diagPlace(dragDiag, el, e.clientY);
    } catch (error) {
      dragDiag = null;
      diagFailed(error);
    }
  }
  // @test-only-end

  // pickDragAnchor's result, passed through unchanged. In test builds the drag
  // record notes which return it was: "on", "on:<reason>" (an anchor found under
  // the press point because the pressed element couldn't be one) or
  // "off:<reason>". `pressed` names the element pressed; moved and gap are
  // measured on the anchor (without one, on the element pressed).
  function diagPick(anchor, reason, pressed, e) {
    // @test-only-begin
    if (SAVE_LOG && dragDiag) {
      try {
        const rec = dragDiag;
        rec.protection = anchor ? (reason ? 'on:' + reason : 'on') : 'off:' + reason;
        rec.anchor = !anchor ? 'none' : anchor.el.localName === 'label' ? 'label'
          : anchor.el instanceof HTMLAnchorElement ? 'link' : 'element';
        const keys = { tracked: 'row', id: 'id', link: 'link' };
        if (anchor && anchor.key && !(anchor.key.kind in keys)) throw new Error(`unknown key kind "${anchor.key.kind}"`);
        rec.key = anchor && anchor.key ? keys[anchor.key.kind] : 'none';
        if (isElementNode(pressed)) rec.pressed = diagPressedName(pressed);
        const ref = anchor ? anchor.el : pressed;
        if (isElementNode(ref)) diagPlace(rec, ref, e.clientY);
      } catch (error) {
        dragDiag = null;
        diagFailed(error);
      }
    }
    // @test-only-end
    return anchor;
  }

  // @test-only-begin
  function diagUpdated(t0) {
    dragDiag.updates++;
    dragDiag.slowest = Math.max(dragDiag.slowest, performance.now() - t0);
  }

  // Auto-scroll updates only: the longest wait between two in a row
  function diagScrollUpdate() {
    const now = performance.now();
    if (dragDiag.lastScrollUpdate !== null) dragDiag.scrollPause = Math.max(dragDiag.scrollPause, now - dragDiag.lastScrollUpdate);
    dragDiag.lastScrollUpdate = now;
  }

  // Write the drag's line, once. `end`: release, esc, page-changed,
  // switched-off, replaced or start-failed.
  function diagWrite(end) {
    const rec = dragDiag;
    dragDiag = null;
    if (!rec) return;
    try {
      // The start's gap from the pressed point, in page coordinates: the
      // pressed element (or the element brief 3 found again) now
      const a = state.anchor;
      const ref = a ? a.el : rec.el;
      const offY = a ? a.offY : rec.offY;
      let moved = null;
      let gap = null;
      if (isElementNode(ref) && ref.isConnected && rec.pressPageY !== null && offY !== null) {
        const r = ref.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          const nowPageY = r.top + window.scrollY;
          moved = nowPageY - rec.pressPageY;
          if (rec.lastStartPageY !== null) gap = rec.lastStartPageY - (nowPageY + offY);
        }
      }
      const sel = inPageOrder(Array.from(state.selectedElements));
      let boxes = 0;
      let links = 0;
      for (const el of sel) {
        if (el instanceof HTMLAnchorElement) links++;
        else if (el.type === 'checkbox' || el.getAttribute('role') === 'checkbox') boxes++;
      }
      dragDiagCount++;
      console.log(dragDiagLine({
        n: dragDiagCount, end, protection: rec.protection, anchor: rec.anchor, key: rec.key,
        refind: rec.refindCancelled ? 'cancelled' : rec.refinds > 0 ? `found:${rec.refinds}` : 'none',
        pressed: rec.pressed, moved, gap, selected: sel.length, boxes, links,
        first: sel.length ? diagName(sel[0]) : null, last: sel.length ? diagName(sel[sel.length - 1]) : null,
        updates: rec.updates, slowest: rec.slowest, scrollPause: rec.scrollPause,
        rebuilds: dragCache ? dragCache.rebuilds : 0,
        follows: rec.follows,
        lock: state.trackLock ? 'tracking' : 'none',
        fixedOut: rec.fixedOut.size,
        topSpeed: rec.topSpeed,
        carried: rec.carried ? 'last-seen' : 'no',
      }));
    } catch (error) {
      diagFailed(error);
    }
  }
  // @test-only-end

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

    state.selectedElements.forEach(el => {
      if (el instanceof HTMLAnchorElement && isOpenableUrl(el.href) && isDownloadableUrl(el.href)) {
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
    // Feather "link" (chain), drawn in the header
    link: [
      ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
      ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]
    ],
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

  // Header chain icon: the link shape stroked with a violet-to-pink gradient
  // (falls back to a flat magenta if the gradient reference cannot resolve).
  function chainIcon() {
    const svg = svgIcon(ICONS.link);
    svg.setAttribute('class', 'snaplinkit-menu-header-icon');
    svg.setAttribute('stroke', 'url(#snaplinkit-link-gradient) #d53ef6');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const defs = document.createElementNS(SVG_NS, 'defs');
    const gradient = document.createElementNS(SVG_NS, 'linearGradient');
    gradient.setAttribute('id', 'snaplinkit-link-gradient');
    for (const [name, value] of Object.entries({ x1: '0', y1: '1', x2: '1', y2: '0' })) {
      gradient.setAttribute(name, value);
    }
    for (const [offset, color] of [['0', '#b239db'], ['0.5', '#d53ef6'], ['1', '#f05cfb']]) {
      const stop = document.createElementNS(SVG_NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', color);
      gradient.appendChild(stop);
    }
    defs.appendChild(gradient);
    svg.insertBefore(defs, svg.firstChild);
    return svg;
  }

  function createLasso() {
    if (lassoEl && lassoEl.isConnected) return lassoEl;
    if (lassoEl) lassoEl.remove(); // body was replaced; rebuild
    lassoEl = document.createElement('div');
    lassoEl.className = 'snaplinkit-lasso';
    lassoEl.style.display = 'none';
    lassoCount = document.createElement('div');
    lassoCount.className = 'snaplinkit-count';
    // Styled here rather than in styles.css (the package's stylesheet stays the
    // released 1.4.0 one): the menu's colours, a small neon pill
    lassoCount.style.cssText = 'position: absolute; bottom: 4px; right: 4px; padding: 0.15em 0.6em; background: #130e22; color: #f4e8ff; ' +
      'border: 1.5px solid #8418b1; border-radius: 0.7em; box-shadow: 0 0 6px rgba(198, 7, 241, 0.55); ' +
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; line-height: 1.3; " +
      'white-space: nowrap; pointer-events: none; display: none;';
    lassoEl.appendChild(lassoCount);
    document.body.appendChild(lassoEl);
    return lassoEl;
  }

  // The live count: what a release would act on (links once per address, or
  // boxes), in the box's corner at the pointer. Its text keeps its size on
  // screen when the page is zoomed out (like the auto-scroll zone). Written
  // only when it changes.
  function updateLiveCount(rect) {
    if (!lassoCount) return;
    const { links, checkboxes, radios } = categorizeSelection();
    // Links: counted once per address (what a release would open); none
    // openable = '' (the count hides), as for no selection
    const text = links.length > 0
      ? liveCountText({ links: getUniqueUrls().length, boxes: 0, radios: 0 })
      : liveCountText({ links: 0, boxes: checkboxes.length, radios: radios.length });
    if (lassoCount.textContent !== text) lassoCount.textContent = text;
    const display = text ? '' : 'none';
    if (lassoCount.style.display !== display) lassoCount.style.display = display;
    const dpr = typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const size = `${Math.round(12 * Math.max(1, 1.5 / dpr))}px`;
    if (lassoCount.style.fontSize !== size) lassoCount.style.fontSize = size;
    if (rect) {
      // The corner at the pointer: top when dragging up, left when dragging left
      const p = clampToArea({ x: state.currentX, y: state.currentY }, visibleArea());
      const top = p.y < rect.top + rect.height / 2;
      const left = p.x < rect.left + rect.width / 2;
      const corner = (top ? 'top' : 'bottom') + '-' + (left ? 'left' : 'right');
      if (lassoCount.getAttribute('data-corner') !== corner) {
        lassoCount.setAttribute('data-corner', corner);
        lassoCount.style.top = top ? '4px' : 'auto';
        lassoCount.style.bottom = top ? 'auto' : '4px';
        lassoCount.style.left = left ? '4px' : 'auto';
        lassoCount.style.right = left ? 'auto' : '4px';
      }
    }
  }

  function updateLasso() {
    if (!lassoEl) return;
    const rect = getSelectionRect();
    lassoEl.style.left = `${rect.left}px`;
    lassoEl.style.top = `${rect.top}px`;
    lassoEl.style.width = `${rect.width}px`;
    lassoEl.style.height = `${rect.height}px`;
    lassoRect = rect;
  }
  let lassoRect = null; // the box as last drawn (the live count's corner)

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
    header.appendChild(chainIcon());
    const headerText = document.createElement('div');
    headerText.className = 'snaplinkit-menu-header-text';
    const title = document.createElement('div');
    title.className = 'snaplinkit-menu-title';
    title.textContent = `${urls.length} link${urls.length !== 1 ? 's' : ''} selected`;
    const hint = document.createElement('div');
    hint.className = 'snaplinkit-menu-hint';
    hint.textContent = 'Alt+drag to remove, Ctrl+drag to add more';
    headerText.append(title, hint);
    header.appendChild(headerText);
    header.addEventListener('mousedown', startMenuDrag);
    // A click on the header does nothing, and like the item clicks it stays
    // inside the menu (the page does not see it)
    header.addEventListener('click', (e) => e.stopPropagation());
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
        label: 'Copy Links',
        icon: ICONS.copyUrls,
        action: () => copyToClipboard(urls.join('\n'), 'Links copied!')
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

    // Keep the whole menu inside the visible area (fitMenuAxis in
    // lib/helpers.js). Width first, since a narrower menu can wrap and grow
    // taller; then height; then the final left from the final width (an
    // inner scrollbar can make it wider).
    const view = visibleArea();
    const widthFit = fitMenuAxis(x, menuEl.getBoundingClientRect().width, view.width, MENU_MARGIN);
    if (widthFit.max !== null) {
      menuEl.style.minWidth = '0';
      menuEl.style.maxWidth = `${widthFit.max}px`;
    }
    const heightFit = fitMenuAxis(y, menuEl.getBoundingClientRect().height, view.height, MENU_MARGIN);
    if (heightFit.max !== null) {
      // Taller than the window: cap it and let it scroll inside itself
      menuEl.style.maxHeight = `${heightFit.max}px`;
      menuEl.style.overflowY = 'auto';
      menuEl.style.overscrollBehavior = 'contain';
    }
    const leftFit = fitMenuAxis(x, menuEl.getBoundingClientRect().width, view.width, MENU_MARGIN);

    menuEl.style.left = `${leftFit.pos}px`;
    menuEl.style.top = `${heightFit.pos}px`;

    setTimeout(() => {
      document.addEventListener('click', handleOutsideClick);
    }, 10);
  }

  // The viewport a position:fixed element can use, without classic
  // (always-visible) scrollbars: innerWidth/innerHeight include them. The
  // root element reports it in standards mode, <body> in quirks mode.
  function visibleArea() {
    const root = document.compatMode === 'BackCompat' ? document.body : document.documentElement;
    const w = root ? root.clientWidth : 0;
    const h = root ? root.clientHeight : 0;
    return {
      width: w > 0 ? Math.min(w, window.innerWidth) : window.innerWidth,
      height: h > 0 ? Math.min(h, window.innerHeight) : window.innerHeight
    };
  }

  // ---- Moving the menu: left-drag on its header ----
  // The menu follows the pointer and is clamped to the visible area on every
  // move (clampMenuAxis, same margins as the placement above). The drag never
  // closes the menu or touches the selection; the click that ends a drag is
  // swallowed so it cannot count as an outside click. A click without movement
  // does nothing. The position is not remembered: every new menu is placed at
  // the pointer again.
  function startMenuDrag(e) {
    if (e.button !== 0 || !menuEl) return;
    e.preventDefault(); // no text selection, no focus change
    const rect = menuEl.getBoundingClientRect();
    menuDrag = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      moved: false
    };
    menuEl.classList.add('snaplinkit-menu-dragging');
    document.body.classList.add('snaplinkit-menu-moving');
    document.addEventListener('mousemove', onMenuDragMove, true);
    document.addEventListener('mouseup', endMenuDrag, true);
  }

  function onMenuDragMove(e) {
    if (!menuDrag || !menuEl) return;
    // Button released outside the window: the mouseup never arrived
    if ((e.buttons & 1) === 0) {
      endMenuDrag();
      return;
    }
    e.preventDefault();
    const view = visibleArea();
    const left = clampMenuAxis(e.clientX - menuDrag.offsetX, menuDrag.width, view.width, MENU_MARGIN);
    const top = clampMenuAxis(e.clientY - menuDrag.offsetY, menuDrag.height, view.height, MENU_MARGIN);
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
    menuDrag.moved = true;
  }

  function endMenuDrag(e) {
    if (!menuDrag) return;
    const moved = menuDrag.moved;
    menuDrag = null;
    document.removeEventListener('mousemove', onMenuDragMove, true);
    document.removeEventListener('mouseup', endMenuDrag, true);
    document.body.classList.remove('snaplinkit-menu-moving');
    if (menuEl) menuEl.classList.remove('snaplinkit-menu-dragging');
    if (moved && e) {
      // The click that follows this mouseup may land outside the menu (the
      // pointer can pass the clamped edge); it must not close the menu or
      // reach the page as a click.
      window.addEventListener('click', swallowClick, true);
      setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
    }
  }

  function swallowClick(e) {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', swallowClick, true);
  }

  function hideMenu() {
    endMenuDrag();
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

  // text: { title, message, confirmLabel }. onCancel runs for every way of
  // cancelling (Cancel, a click on the backdrop, Escape).
  function showConfirmDialog(text, onConfirm, onCancel) {
    // One confirm at a time: a second request while it shows (e.g. the
    // shortcut pressed again) is ignored, so Open All cannot run twice.
    if (confirmShowing()) return false;
    if (faultActive('confirmBusy')) return false; // @test-only: lab builds
    faultPoint('confirm'); // @test-only
    // The menu acts on the same selection; close it so it cannot be clicked
    // while the confirm is up (it would otherwise sit above the backdrop).
    hideMenu();

    const overlay = document.createElement('div');
    overlay.className = 'snaplinkit-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'snaplinkit-confirm';

    const title = document.createElement('h3');
    title.textContent = text.title;
    // Items 11 + 14: the "already" count and the first → last row, when given
    let detail = null;
    if (text.detail) {
      detail = document.createElement('p');
      detail.className = 'snaplinkit-confirm-detail';
      detail.textContent = text.detail;
    }
    const message = document.createElement('p');
    message.textContent = text.message;
    const buttons = document.createElement('div');
    buttons.className = 'snaplinkit-confirm-buttons';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'snaplinkit-confirm-btn secondary';
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'snaplinkit-confirm-btn primary';
    confirmBtn.textContent = text.confirmLabel;
    buttons.append(cancelBtn, confirmBtn);
    dialog.append(...[title, detail, message, buttons].filter(Boolean));

    const root = uiRoot();
    root.appendChild(overlay);
    root.appendChild(dialog);

    const previousFocus = document.activeElement;
    const cleanup = () => {
      overlay.remove();
      dialog.remove();
      confirmDialog = null;
      if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    };
    const cancel = () => {
      cleanup();
      if (onCancel) onCancel();
    };
    confirmDialog = { el: dialog, cancel }; // Escape (onKeyDown) cancels through this

    cancelBtn.addEventListener('click', cancel);
    confirmBtn.addEventListener('click', () => {
      cleanup();
      // Switched off while it showed (the switch-off closes it, so this is a
      // second guard): the click counts as Cancel and nothing starts
      if (!extensionActive) {
        if (onCancel) onCancel();
        return;
      }
      onConfirm();
    });
    overlay.addEventListener('click', cancel);

    // Focus the safe choice: Enter or Space right after the dialog appears
    // cancels instead of opening every tab.
    cancelBtn.focus({ preventScroll: true });
    return true;
  }

  function tabsConfirmText(count) {
    return {
      title: `Open ${count} tabs?`,
      message: `You're about to open ${count} tabs at once. This might slow down your browser. Are you sure?`,
      confirmLabel: 'Open All'
    };
  }

  // False once the page itself has removed the dialog (e.g. replaced <body>),
  // so a lost dialog cannot block new selections or confirms for good.
  function confirmShowing() {
    if (confirmDialog && !confirmDialog.el.isConnected) confirmDialog = null;
    return confirmDialog !== null;
  }

  // One toast at a time. A plain toast goes after 2.5 s. A sticky one (careful
  // run progress, every "Stopped" message) stays until it is clicked, Escape
  // is pressed, or another toast replaces it; a sticky toast that is already
  // showing is updated in place, so progress does not flicker.
  const STICKY_ATTR = 'data-snaplinkit-sticky';

  // Where Snap Linkit's messages and dialogs go: <body>, or the root element
  // on a page without one (null only if the document has no element at all)
  function uiRoot() {
    return document.body || document.documentElement;
  }

  // @test-only-begin
  // Lab builds only (FAULTS): true when the page names this point in
  // <html data-snaplinkit-fault="...">, so the brief 2b tests can make a step
  // fail on purpose. Always false in every other build.
  function faultActive(name, n) {
    if (!FAULTS) return false;
    const root = document.documentElement;
    return Boolean(root) && faultMatches(root.getAttribute('data-snaplinkit-fault'), name, n);
  }

  function faultPoint(name, n) {
    if (faultActive(name, n)) throw new Error(`Snap Linkit: injected fault "${name}"`);
  }
  // @test-only-end

  // showToast for results that must not be lost: if the message cannot be
  // shown at all, it goes to the console with its details. Never throws.
  function showToastOrLog(message, opts, details) {
    try {
      showToast(message, opts);
      return true;
    } catch (error) {
      console.error(`[Snap Linkit] Could not show this message: ${message}`, details === undefined ? '' : details, error);
      return false;
    }
  }

  // progress: a "Saving i of k" update (test builds log every other message)
  function showToast(message, { sticky = false, progress = false } = {}) {
    // Item 10a (big run 2): the final message also goes to the console in test
    // builds, so it can be kept as evidence after it closes (2.5 s on success)
    if (SAVE_LOG && !progress) console.log(`[Snap Linkit] message: ${message}`); // @test-only
    const existing = document.querySelector('.snaplinkit-toast');
    if (sticky && existing && existing.isConnected && existing.getAttribute(STICKY_ATTR) === '1') {
      existing.textContent = message;
      return;
    }
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'snaplinkit-toast';
    toast.textContent = message;
    if (sticky) {
      toast.setAttribute(STICKY_ATTR, '1');
      toast.title = 'Click or press Esc to close';
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => toast.remove());
    }
    uiRoot().appendChild(toast);

    if (!sticky) setTimeout(() => toast.remove(), 2500);
  }

  // Close a sticky toast (Escape); true if there was one
  function dismissStickyToast() {
    const existing = document.querySelector('.snaplinkit-toast');
    if (existing && existing.getAttribute(STICKY_ATTR) === '1') {
      existing.remove();
      return true;
    }
    return false;
  }

  // ============================================
  // ACTIONS
  // ============================================

  function openTabs(urls, discardAfterOpen = false) {
    if (urls.length > settings.maxTabsWithoutConfirm) {
      showConfirmDialog(tabsConfirmText(urls.length), () => doOpenTabs(urls, discardAfterOpen));
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

  // ---- Checkbox / radio toggling ----
  // Elements are flipped with a native click() rather than by setting .checked
  // and dispatching a synthetic change event: frameworks only update their own
  // state for real clicks (React listens to click, Vue/Angular to input), and
  // ARIA widgets (role="checkbox"/"radio") flip aria-checked in their own click
  // handlers. Only elements whose state differs from the target are clicked.

  function isChecked(el) {
    return el instanceof HTMLInputElement
      ? el.checked === true
      : el.getAttribute('aria-checked') === 'true';
  }

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  // Click every element whose state differs from `target`. A click() that
  // throws is logged and counted; the loop continues with the next element.
  function clickToState(elements, target) {
    const result = { clicked: 0, skipped: 0, failed: 0 };
    for (const el of elements) {
      if (isDisabled(el)) {
        result.skipped++;
        continue;
      }
      if (isChecked(el) === target) continue;
      try {
        el.click();
        result.clicked++;
      } catch (error) {
        result.failed++;
        console.warn('[Snap Linkit] Could not toggle element:', el, error);
      }
    }
    return result;
  }

  // Fandom progress-tracking checkbox (lib/helpers.js isTrackedCheckbox)
  function isTrackedBox(el) {
    return el instanceof HTMLInputElement && isTrackedCheckbox({
      tagName: el.localName,
      type: el.type,
      hasRowId: el.hasAttribute('data-tpt-row-id'),
      hasTableId: el.hasAttribute('data-table-id'),
      inTrackedTable: Boolean(el.closest(TRACKED_TABLE_SELECTOR))
    });
  }

  // Document order (a Ctrl+drag selection lists earlier drags first)
  function inPageOrder(elements) {
    return elements.slice().sort((a, b) => {
      if (a === b || typeof a.compareDocumentPosition !== 'function') return 0;
      return a.compareDocumentPosition(b) & 4 ? -1 : 1; // 4 = DOCUMENT_POSITION_FOLLOWING
    });
  }

  // One animation frame (and the task after it), or 100 ms when frames do not
  // run (background tab)
  function afterNextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(finish, 0));
      }
      setTimeout(finish, 100);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Ordinary checkboxes: clicked straight away as before, then read once after
  // the whole loop plus one animation frame (widgets that update just after
  // the click event are still counted), so the message counts real changes.
  async function toggleOrdinaryCheckboxes(elements, target) {
    const c = { target, m: elements.length, k: 0, n: 0, refused: 0, failed: 0, already: 0, disabled: 0 };
    const clicked = [];
    for (const el of elements) {
      if (isDisabled(el)) { c.disabled++; continue; }
      if (isChecked(el) === target) { c.already++; continue; }
      c.k++;
      try {
        el.click();
        clicked.push(el);
      } catch (error) {
        c.failed++;
        console.warn('[Snap Linkit] Could not toggle element:', el, error);
      }
    }
    if (clicked.length > 0) await afterNextFrame();
    for (const el of clicked) {
      if (isChecked(el) === target) c.n++;
      else c.refused++;
    }
    faultPoint('ordinary'); // @test-only: lab builds: the result cannot be read, after the boxes were clicked
    return c;
  }

  // ---- Careful mode: Fandom tracking checkboxes, one save at a time ----
  // BRIEF-2-DESIGN-v2.md sections 1-4. Click one box, read it in the same
  // task, wait for Fandom's is-saving to clear (MutationObserver plus a
  // time-out), check the result, wait the gap, next. Stop at the first failed
  // save, time-out, refused click, unconfirmed save or table change. Never
  // retry. Only one save is ever in flight.

  let carefulRun = null; // { stop, ignoredDrag, i, k } while a run is going

  function showCarefulProgress(run) {
    faultPoint('progress', run.i); // @test-only: lab builds: a fault inside the run, before item i is clicked
    showToast(carefulProgressMessage(run.i, run.k, run.ignoredDrag), { sticky: true, progress: true });
  }

  // Is any Fandom tracking box on the page still saving (an earlier save,
  // possibly one that timed out)?
  function trackedSaveInFlight() {
    return Array.from(document.querySelectorAll(TRACKED_CHECKBOX_SELECTOR)).some((b) => isTrackedBox(b) && b.classList.contains(SAVING_CLASS));
  }

  // Resolves 'done' once is-saving is gone, or 'timeout'. A result arriving
  // after the time-out is ignored: the observer is disconnected by then.
  function waitForSave(el, timeoutMs) {
    return new Promise((resolve) => {
      if (!el.classList.contains(SAVING_CLASS)) {
        resolve('done');
        return;
      }
      let timer = null;
      const observer = new MutationObserver(() => {
        if (!el.classList.contains(SAVING_CLASS)) finish('done');
      });
      const finish = (result) => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      };
      observer.observe(el, { attributes: true, attributeFilter: ['class', 'disabled'] });
      timer = setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  // The "Delay Between Saves" setting, read at each wait so a change in the
  // popup applies to the next save; a bad stored value falls back to the default
  function currentSaveGapMs() {
    return saveGapMs(settings.checkboxSaveGap, SnapLinkitDefaults().checkboxSaveGap);
  }

  // @test-only-begin
  function logSave(i, k, status, t0, el) {
    if (!SAVE_LOG) return;
    console.log(saveLogLine(i, k, status, performance.now() - t0, el ? el.getAttribute('data-tpt-row-id') : null));
  }
  // @test-only-end

  // queue: the tracked boxes that need changing, in page order.
  // pre: { m, already, disabled } counted at release. Resolves to the counts
  // and the final message; never rejects.
  async function runCarefulSaves(queue, target, pre) {
    const k = queue.length;
    const run = { stop: false, ignoredDrag: false, i: 0, k };
    carefulRun = run;
    const c = { target, m: pre.m, k, n: 0, i: 0, rest: 0, already: pre.already, disabled: pre.disabled,
      timeoutSec: CHECKBOX_SAVE_TIMEOUT_MS / 1000, kind: 'done' };
    let processed = 0; // queue positions dealt with (saved, skipped, or where the run stopped)
    let clicks = 0;
    let clickedAt = 0; // the queue position last clicked
    const stopAt = (kind, i) => { c.kind = kind; c.i = i; processed = i; };
    try {
      for (let idx = 0; idx < k; idx++) {
        const el = queue[idx];
        const i = idx + 1;
        if (run.stop) { c.kind = 'esc'; break; }
        // Check the box again just before clicking: earlier saves took time
        if (!el.isConnected) { stopAt('tableChanged', i); break; }
        if (isDisabled(el)) { c.disabled++; processed = i; continue; }
        if (isChecked(el) === target) { c.already++; processed = i; continue; }

        run.i = i;
        showCarefulProgress(run);
        const t0 = performance.now(); // @test-only
        try {
          el.click();
          clickedAt = i;
        } catch (error) {
          console.warn('[Snap Linkit] Could not toggle element:', el, error);
          logSave(i, k, 'failed (click threw)', t0, el); // @test-only
          stopAt('failed', i);
          break;
        }
        clicks++;
        const outcome = afterClickOutcome({
          checked: isChecked(el), target, saving: el.classList.contains(SAVING_CLASS)
        });
        if (outcome !== 'saving') {
          logSave(i, k, outcome, t0, el); // @test-only
          stopAt(outcome === 'refused' ? (clicks === 1 ? 'refusedFirst' : 'refusedLater')
            : outcome === 'unconfirmed' ? 'unconfirmed' : 'failed', i);
          break;
        }
        const wait = await waitForSave(el, CHECKBOX_SAVE_TIMEOUT_MS);
        if (wait === 'timeout') {
          logSave(i, k, 'timeout', t0, el); // @test-only
          stopAt(el.isConnected ? 'timeout' : 'tableChanged', i);
          break;
        }
        if (isChecked(el) !== target) {
          logSave(i, k, 'failed', t0, el); // @test-only
          stopAt('failed', i);
          break;
        }
        if (isDisabled(el)) {
          logSave(i, k, 'unconfirmed (still disabled)', t0, el); // @test-only
          stopAt('unconfirmed', i);
          break;
        }
        c.n++;
        processed = i;
        logSave(i, k, 'ok', t0, el); // @test-only
        if (i < k) await sleep(currentSaveGapMs());
      }
    } catch (error) {
      // A fault in Snap Linkit itself: say so rather than report a result
      console.error('[Snap Linkit] Careful save run failed:', error);
      // The item the fault hit: the one clicked last if its save never
      // finished, otherwise the next one, which was never clicked and so
      // still counts as "not tried"
      const done = processed;
      const clickedCurrent = clickedAt > done;
      stopAt('error', clickedCurrent ? clickedAt : Math.min(done + 1, Math.max(k, 1)));
      if (!clickedCurrent) processed = done;
    } finally {
      if (carefulRun === run) carefulRun = null;
    }
    c.rest = k - processed;
    return c;
  }

  // Smart toggle - inverts based on majority state. Fandom's tracking boxes
  // are saved carefully, one at a time; every other checkbox as before.
  function smartToggleCheckboxes(checkboxes) {
    if (checkboxes.length === 0) return;

    // Determine majority: if most are checked, uncheck all; otherwise check all
    const checkedCount = checkboxes.filter(isChecked).length;
    const target = majorityShouldCheck(checkedCount, checkboxes.length);

    const tracked = inPageOrder(checkboxes.filter(isTrackedBox));
    const ordinary = checkboxes.filter((el) => !tracked.includes(el));

    // Ordinary boxes: straight away, as before
    const ordinaryDone = ordinary.length > 0 ? toggleOrdinaryCheckboxes(ordinary, target) : null;
    if (tracked.length === 0) {
      clearSelection();
      showOrdinaryResult(ordinaryDone);
      return;
    }

    const pre = { m: tracked.length, already: 0, disabled: 0 };
    const queue = [];
    for (const el of tracked) {
      if (isDisabled(el)) pre.disabled++;
      else if (isChecked(el) === target) pre.already++;
      else queue.push(el);
    }

    // One save at a time, also after a time-out: a box whose save timed out may
    // still be saving (Fandom's is-saving class), and a new run would put a
    // second save in flight. While any tracking box on the page is saving, no
    // run starts and nothing is clicked; the message says so (ultrareview #4).
    if (queue.length > 0 && trackedSaveInFlight()) {
      reportNotStarted('saving', queue.length, ordinaryDone);
      clearSelection();
      return;
    }

    // A careful run, then its message. `progress.stage` says how far it got,
    // so a fault anywhere around the run is reported for what it is
    // (reportCarefulFault) instead of only reaching the console.
    const start = () => {
      const progress = { stage: 'before', c: null };
      return (async () => {
        faultPoint('beforeRun'); // @test-only: lab builds: a fault before the run (as if clearSelection threw)
        clearSelection();
        progress.stage = 'running';
        progress.c = await runCarefulSaves(queue, target, pre);
        progress.stage = 'after';
        // A mixed selection: the ordinary result leads. It is read on its own
        // (never rejects), so the careful result shows whatever happens to it.
        const ord = ordinaryDone ? await ordinaryResult(ordinaryDone) : null;
        const lead = ord ? `${ord.text}. ` : '';
        faultPoint('report'); // @test-only: lab builds: showing the final message fails
        // Every message but plain success stays until dismissed (so does one
        // whose ordinary part could not be read)
        showToast(lead + carefulCheckboxMessage(progress.c),
          { sticky: progress.c.kind !== 'done' || Boolean(ord && !ord.ok) });
      })().catch((error) => {
        console.error('[Snap Linkit] Could not report the checkbox result:', error);
        return reportCarefulFault(progress, queue.length, ordinaryDone);
      }).catch((error) => {
        // reportCarefulFault never rejects; kept so no path is left unhandled
        console.error('[Snap Linkit] Could not report the checkbox fault:', error);
      });
    };

    if (queue.length > CHECKBOX_CONFIRM_ABOVE) {
      let shown;
      try {
        shown = showConfirmDialog(
          carefulConfirmText(target, queue.length, currentSaveGapMs() + CHECKBOX_SAVE_ESTIMATE_MS, {
            already: pre.already,
            first: queue[0].getAttribute('data-tpt-row-id'),
            last: queue[queue.length - 1].getAttribute('data-tpt-row-id'),
          }),
          start,
          () => {
            // Cancel clicks nothing (ordinary boxes were already done)
            clearSelection();
            if (ordinaryDone) showOrdinaryResult(ordinaryDone);
          }
        );
      } catch (error) {
        console.error('[Snap Linkit] Could not open the confirm dialog:', error);
        removeConfirmLeftovers();
        shown = 'failed';
      }
      if (shown !== true) {
        // No dialog, so no run: say so (with the ordinary result in a mixed drag)
        reportNotStarted(shown === false ? 'busy' : 'failed', queue.length, ordinaryDone);
        clearSelection();
      }
      return;
    }
    start();
  }

  // The ordinary boxes' result as a message. Never rejects: if the result
  // cannot be read, the message says the boxes were clicked but not checked.
  async function ordinaryResult(ordinaryDone) {
    try {
      return { text: ordinaryCheckboxMessage(await ordinaryDone), ok: true };
    } catch (error) {
      console.error('[Snap Linkit] Could not check the checkbox result:', error);
      return { text: ordinaryUnreadMessage(), ok: false };
    }
  }

  // Ordinary boxes only: their message (sticky if it could not be read)
  function showOrdinaryResult(ordinaryDone) {
    ordinaryResult(ordinaryDone)
      .then((r) => showToastOrLog(r.text, { sticky: !r.ok }))
      .catch((error) => console.error('[Snap Linkit] Could not report the checkbox result:', error));
  }

  // Last resort after a fault around a careful run. The message says how far
  // the run got, and it replaces the progress line (a sticky toast is updated
  // in place), so "Saving i of k…" cannot stay on screen. If even this cannot
  // be shown, the progress line is removed and the counts go to the console.
  async function reportCarefulFault(progress, k, ordinaryDone) {
    const lead = ordinaryDone ? `${(await ordinaryResult(ordinaryDone)).text}. ` : '';
    const text = lead + carefulFallbackMessage(progress.stage, progress.c, k);
    try {
      faultPoint('fallback'); // @test-only: lab builds: even the fallback message fails
      showToast(text, { sticky: true });
    } catch (error) {
      try { dismissStickyToast(); } catch (_) { /* nowhere left to show anything */ }
      console.error(`[Snap Linkit] Could not show the checkbox result: ${text}`,
        { stage: progress.stage, counts: progress.c }, error);
    }
  }

  // The confirm before a big careful run could not be shown: nothing was saved
  function reportNotStarted(reason, k, ordinaryDone) {
    const careful = carefulNotStartedMessage(reason, k);
    const text = ordinaryDone
      ? ordinaryResult(ordinaryDone).then((r) => `${r.text}. ${careful}`)
      : Promise.resolve(careful);
    text.then((t) => showToastOrLog(t, { sticky: true }, { reason, k }))
      .catch((error) => console.error('[Snap Linkit] Could not report the checkbox result:', error));
  }

  // A confirm that failed half-way must not leave its backdrop over the page
  function removeConfirmLeftovers() {
    try {
      document.querySelectorAll('.snaplinkit-confirm-overlay, .snaplinkit-confirm').forEach((el) => el.remove());
    } catch (_) { /* nothing to clean up */ }
    confirmDialog = null;
  }

  // Radios: select the first one in the selection
  function smartToggleRadios(radios) {
    if (radios.length === 0) return;

    const result = clickToState([radios[0]], true);
    let message = 'Radio selected';
    if (result.skipped > 0) message = 'Radio is disabled, not changed';
    else if (result.failed > 0) message = 'Radio could not be selected';
    showToast(message);
    clearSelection();
  }

  // ============================================
  // SELECTION LOGIC
  // ============================================

  function updateSelection() {
    const t0 = SAVE_LOG ? performance.now() : 0; // @test-only
    if (!dragCache) startDragCache(); // started at the 5 px threshold; on demand otherwise
    if (dragCache.stale) {
      if (dragCache.list) dragCache.rebuilds++;
      dragCache.list = null;
      dragCache.verdicts = new Map();
      dragCache.proxies = new Map();
      dragCache.labelMap = null;
      dragCache.stale = false;
    }
    proxyCache = dragCache.proxies;
    try {
      applySelection();
    } finally {
      proxyCache = null;
      if (SAVE_LOG && dragDiag) diagUpdated(t0); // @test-only: test builds: the drag line's updates and slowest
    }
  }

  function applySelection() {
    const selRect = getSelectionRect();
    const c = dragCache;
    if (!c.list) c.list = candidateList();

    const currentlyInLasso = new Set();

    for (const el of c.list) {
      // Boxes first: only an element that touches the selection box (itself, or
      // a checkbox through one of its labels) needs the full check, kept for the
      // drag
      const labelRects = () => (el instanceof HTMLInputElement && el.type === 'checkbox' ? labelsOf(el).map(getElementRect) : []);
      if (!touchesSelection(selRect, getElementRect(el), labelRects)) continue;
      if (!c.verdicts.has(el)) c.verdicts.set(el, isSelectableElement(el) && fixedRuleAllows(el));
      if (!c.verdicts.get(el)) continue;
      const proxies = proxyLabels(el);
      const rects = proxies.length > 0 ? proxies.map(getElementRect) : [getElementRect(el)];
      if (rects.some(r => rectsIntersect(selRect, r))) {
        currentlyInLasso.add(el);
      }
    }
    c.inLasso = currentlyInLasso;

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

    // Update visual highlights: the element itself, or the labels standing in
    // for a hidden checkbox (an opacity-0 input shows no outline)
    const highlighted = new Set();
    state.selectedElements.forEach(el => {
      const proxies = proxyLabels(el);
      (proxies.length > 0 ? proxies : [el]).forEach(target => highlighted.add(target));
    });

    document.querySelectorAll('.snaplinkit-highlighted').forEach(el => {
      if (!highlighted.has(el)) {
        el.classList.remove('snaplinkit-highlighted');
      }
    });

    highlighted.forEach(el => {
      el.classList.add('snaplinkit-highlighted');
    });
  }

  // At release (brief 7): the selection was built with verdicts kept for the
  // drag, so check each selected element again with the full rules, fresh, and
  // drop any that no longer qualify (and its highlight). Nothing hidden at
  // release is acted on. A menu left open afterwards isn't re-checked at click
  // time, as before.
  function recheckSelectionAtRelease() {
    if (dragCache) { dragCache.proxies = new Map(); dragCache.labelMap = null; }
    proxyCache = dragCache ? dragCache.proxies : null;
    try {
      const inLasso = dragCache && dragCache.inLasso ? dragCache.inLasso : new Set();
      for (const el of Array.from(state.selectedElements)) {
        // C applies to what this drag's box holds; an earlier Ctrl drag's
        // elements keep their own press's verdict. An element the page has
        // removed since (an earlier Ctrl/Alt drag's link) is not there to act
        // on: it leaves the selection (item 22)
        if (el.isConnected && isSelectableElement(el) && (!inLasso.has(el) || fixedRuleAllows(el))) continue;
        state.selectedElements.delete(el);
        el.classList.remove('snaplinkit-highlighted');
        labelsOf(el).forEach((l) => l.classList.remove('snaplinkit-highlighted'));
      }
    } finally {
      proxyCache = null;
    }
  }

  // Every path that acts on or drops the selection ends here, so the menu
  // closes with it: a menu left open would still hold the old link list and
  // act on it again (e.g. after Alt+Shift+Comma or Ctrl+C).
  function clearSelection() {
    hideMenu();
    document.querySelectorAll('.snaplinkit-highlighted').forEach(el => {
      el.classList.remove('snaplinkit-highlighted');
    });
    state.selectedElements.clear();
    state.persistentSelection.clear();
  }

  // Abort any in-progress drag, drop the selection and close the menu
  // `end` says why, for the test-build drag line: esc, page-changed, switched-off or start-failed
  function cancelSelection(end) {
    if (SAVE_LOG && dragDiag && dragDiag.started) diagWrite(end); // @test-only
    endDragCache();
    state.isSelecting = false;
    state.isDragging = false;
    state.anchor = null;
    state.lastSeen = null;
    stopAutoScroll();
    stopDragFollow();
    if (lassoEl) lassoEl.style.display = 'none';
    document.body.classList.remove('snaplinkit-selecting');
    clearSelection();
    hideMenu();
  }

  // ============================================
  // FOLLOWING SCROLLS DURING A DRAG (A1)
  // ============================================
  // The page can scroll under a held drag with the pointer still: the mouse
  // wheel, the keyboard, the page's own scripts, a scrolling box inside the
  // page. Every scroll asks for one update in the next frame (at most one per
  // frame, whatever asked; an auto-scroll step updates on its own). Each update
  // refreshes the brief 3 anchor first. A release applies a pending update
  // first, so it acts on what is under the box now. The listener and any
  // pending frame go when the drag ends, however it ends.
  let dragFollow = null; // { onScroll, frame, timer, inner, last: { x, y } } while a drag is active

  function startDragFollow() {
    stopDragFollow();
    const f = { onScroll: null, frame: null, timer: null, inner: false, last: { x: window.scrollX, y: window.scrollY } };
    f.onScroll = (e) => {
      // The page's own scroll is fired at the document; any other target is a
      // scrolling box inside the page, which moves its contents but not the
      // window's scroll position
      const t = e && e.target;
      if (t && t !== document && t !== document.documentElement && t !== document.scrollingElement) f.inner = true;
      scheduleDragFollow();
    };
    window.addEventListener('scroll', f.onScroll, { capture: true, passive: true });
    dragFollow = f;
  }

  function cancelDragFollowFrame(f) {
    if (f.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(f.frame);
    if (f.timer !== null) clearTimeout(f.timer);
    f.frame = null;
    f.timer = null;
  }

  function stopDragFollow() {
    if (!dragFollow) return;
    cancelDragFollowFrame(dragFollow);
    window.removeEventListener('scroll', dragFollow.onScroll, { capture: true });
    dragFollow = null;
  }

  // At most one pending update: the next animation frame, or a frame's time
  // where frames don't run
  function scheduleDragFollow() {
    const f = dragFollow;
    if (!f || f.frame !== null || f.timer !== null) return;
    if (typeof requestAnimationFrame === 'function') f.frame = requestAnimationFrame(runDragFollow);
    else f.timer = setTimeout(runDragFollow, FRAME_INTERVAL);
  }

  function runDragFollow() {
    const f = dragFollow;
    if (!f) return;
    f.frame = null;
    f.timer = null;
    if (!state.isDragging) return;
    if (!dragFollowNeeded(f.last, { x: window.scrollX, y: window.scrollY }, f.inner)) return;
    if (SAVE_LOG && dragDiag) dragDiag.follows++; // @test-only
    dragUpdate();
  }

  // At release: whatever a pending frame would have applied, now, including a
  // scroll whose event hasn't fired yet (its position is already current)
  function flushDragFollow() {
    const f = dragFollow;
    if (!f || !state.isDragging) return;
    cancelDragFollowFrame(f);
    if (!dragFollowNeeded(f.last, { x: window.scrollX, y: window.scrollY }, f.inner)) return;
    if (SAVE_LOG && dragDiag) dragDiag.follows++; // @test-only
    dragUpdate();
  }

  // One update of the box and the selection, the anchor first (refreshing it
  // can cancel the drag: false)
  function dragUpdate() {
    if (!refreshDragAnchor()) return false;
    updateLassoAndSelection();
    return true;
  }

  function updateLassoAndSelection() {
    updateLasso();
    updateSelection();
    updateLiveCount(lassoRect);
    if (dragFollow) {
      dragFollow.last = { x: window.scrollX, y: window.scrollY };
      dragFollow.inner = false;
    }
  }

  // ============================================
  // AUTO-SCROLL
  // ============================================

  // A2: the page follows the drag. In the edge zone (sized on screen, see
  // autoScrollZone) the page scrolls faster the deeper the pointer is, and
  // faster still past the window edge (autoScrollRate); at the edge it is never
  // slower than before. Rates are per second, so a busy page doesn't slow the
  // scroll; each step is instant (brief 7b), even where the page asks for
  // smooth scrolling.
  function startAutoScroll() {
    if (state.scrollInterval) return;
    let last = performance.now();
    const carry = { x: 0, y: 0 };

    state.scrollInterval = setInterval(() => {
      if (!state.isSelecting) {
        stopAutoScroll();
        return;
      }

      const now = performance.now();
      const dt = Math.min(50, Math.max(0, now - last)); // a late tick doesn't jump the page
      last = now;
      const area = visibleArea();
      const zone = autoScrollZone(settings.scrollEdgeThreshold, window.devicePixelRatio);
      const edgeSpeed = settings.autoScrollSpeed * 1000 / FRAME_INTERVAL; // the setting is px per 16 ms frame
      const rx = autoScrollRate(state.currentX, area.width, zone, edgeSpeed);
      const ry = autoScrollRate(state.currentY, area.height, zone, edgeSpeed);
      const sx = autoScrollDelta(rx, dt, rx ? carry.x : 0);
      const sy = autoScrollDelta(ry, dt, ry ? carry.y : 0);
      carry.x = sx.carry;
      carry.y = sy.carry;

      if (sx.px !== 0 || sy.px !== 0) {
        window.scrollBy(autoScrollStep(sx.px, sy.px)); // instant, even where the page asks for smooth scrolling (brief 7b)
        if (SAVE_LOG && dragDiag) dragDiag.topSpeed = Math.max(dragDiag.topSpeed, Math.round(Math.max(Math.abs(rx), Math.abs(ry)))); // @test-only
        // NO mutation of state.startX/startY - getSelectionRect() follows the
        // pressed element (or the scroll delta when there is no anchor)
        if (!refreshDragAnchor()) return;
        if (SAVE_LOG && dragDiag) diagScrollUpdate(); // @test-only
        updateLassoAndSelection();
      // @test-only-begin
      } else if (!rx && !ry && SAVE_LOG && dragDiag) {
        dragDiag.lastScrollUpdate = null; // the pointer left the edge zone: the next stretch starts fresh
      // @test-only-end
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
    // No new selection (and so no new menu) while the confirm is up
    if (confirmShowing()) return;
    if (e.target.closest('input, textarea, select, button, [contenteditable]')) return;

    // Close menu when starting new selection (but keep selection for modifier modes)
    if (menuEl) {
      hideMenu();
    }

    // Choose the drag's anchor (brief 3) before anything marks the drag as
    // started, so a failure can't leave a half-started drag (brief 5). A
    // failure is reported in the console and marks the press: if it becomes a
    // drag, onMouseMove cancels it and says so; a plain right-click stays one.
    if (SAVE_LOG) diagPress(e); // @test-only: test builds: the drag line's record ("off:threw" until pickDragAnchor returns)
    endDragCache(); // a press with no release in between ends the previous drag's cache (after its line)
    stopDragFollow(); // ... and its scroll listener (A1)
    let anchor = null;
    let pressFailed = false;
    let trackLock = false;
    let pressEl = null;
    try {
      anchor = pickDragAnchor(e);
      pressEl = pressedElement(e);
      trackLock = pressInTrackingCell(pressEl);
    } catch (error) {
      pressFailed = true;
      console.error(`[Snap Linkit] Could not start the selection: ${error && error.message ? error.message : String(error)}`, error);
      diagPick(null, DRAG_OFF_REASONS.threw, null, e); // @test-only: test builds: the drag line's "off:threw"
    }

    // Track potential drag start - don't activate until MIN_DRAG_DISTANCE.
    // Every piece of press state is set on both paths, so nothing from the
    // previous drag survives this press.
    state.isSelecting = true;
    state.isDragging = false; // Not dragging yet - waiting for threshold
    state.pressFailed = pressFailed;
    state.anchor = anchor;
    state.lastSeen = null;
    state.carried = false;
    state.trackLock = trackLock;
    state.pressEl = pressEl;
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.startScrollX = window.scrollX;
    state.startScrollY = window.scrollY;
    state.currentX = e.clientX;
    state.currentY = e.clientY;
    // Ctrl (or, unadvertised, Shift) = add, Alt = remove: see dragModifierMode
    state.modifierMode = dragModifierMode(e);

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
      if (SAVE_LOG && dragDiag) dragDiag.started = true; // @test-only: test builds: this drag gets a line
      state.blockNextContextMenu = true; // Block context menu since we're dragging

      // The anchor couldn't be chosen at the press (brief 5): cancel the drag
      // and say so (nothing is clicked, opened or saved; the browser menu stays
      // blocked on this release). The selection is dropped first, as Esc drops
      // it, so the test-build line shows what the drag left: nothing.
      if (state.pressFailed) {
        clearSelection();
        cancelSelection('start-failed');
        showToastOrLog(dragStartFailedMessage(), { sticky: true });
        return;
      }

      startDragCache(); // brief 7: candidates and verdicts for this drag

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
      startDragFollow(); // A1: the selection follows any scroll from here on

      // Now prevent default to stop text selection during drag
      e.preventDefault();
    }

    dragUpdate();
  }

  function onMouseUp(e) {
    if (!state.isSelecting) return;
    if (e.button !== 2) return; // Right-click release

    const wasDragging = state.isDragging;
    if (wasDragging) {
      // A1: a scroll the last update hasn't seen yet is applied first, so the
      // release acts on what is under the box now. Refreshing the anchor can
      // cancel the drag (the pressed element left the page): nothing to act on.
      flushDragFollow();
      if (!state.isSelecting) return;
      recheckSelectionAtRelease(); // before the line, so selected= is what's acted on
      // A drag that carried on may not save tracking boxes: nothing is clicked
      // (the line says end=page-changed carried=last-seen). A save run already
      // going keeps its own "new drag ignored" message instead.
      if (!carefulRun && carriedReleaseRefused()) {
        cancelSelection('page-changed');
        showToastOrLog(dragPageChangedMessage(), { sticky: true });
        return;
      }
    }
    if (SAVE_LOG && wasDragging && dragDiag && dragDiag.started) diagWrite('release'); // @test-only
    endDragCache();
    state.isSelecting = false;
    state.isDragging = false;
    state.anchor = null;
    state.lastSeen = null;
    stopAutoScroll();
    stopDragFollow();

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
      // A checkbox drag while a careful save run is going is ignored (not
      // queued); the progress message says so
      if (carefulRun && checkboxes.length > 0) {
        carefulRun.ignoredDrag = true;
        showCarefulProgress(carefulRun);
        clearSelection();
        return;
      }
      // Instant action - no menu
      if (checkboxes.length > 0) {
        smartToggleCheckboxes(checkboxes);
      }
      if (radios.length > 0) {
        smartToggleRadios(radios);
      }
      return;
    }

    // Links: a plain drag does what "When I let go" says (releaseAction),
    // through the same calls as the menu's items, so the Confirm-at dialog
    // still applies to both Open choices. The menu appears instead when Ctrl
    // is held at release, or after an add (Ctrl or Shift held as the drag
    // starts) or remove (Alt) drag, which build a selection up over several
    // drags. Checkboxes or buttons in a mixed selection are left alone, as
    // before.
    if (links.length > 0) {
      if (e.ctrlKey || state.modifierMode) {
        showMenu(e.clientX, e.clientY);
      } else {
        const urls = getUniqueUrls();
        if (urls.length === 0) {
          clearSelection();
        } else {
          switch (normalizeReleaseAction(settings.releaseAction)) {
            case 'openUnloaded':
              openTabs(urls, true);
              break;
            case 'copyUrls':
              copyToClipboard(urls.join('\n'), 'Links copied!');
              break;
            case 'menu':
              showMenu(e.clientX, e.clientY);
              break;
            default: // 'open'
              openTabs(urls, false);
          }
        }
      }
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
        copyToClipboard(urls.join('\n'), 'Links copied!');
      }
    }

    if (e.key === 'Escape') {
      // With the confirm showing, Escape means Cancel and nothing more:
      // the selection stays, and the page does not see the key.
      if (confirmShowing()) {
        e.preventDefault();
        e.stopPropagation();
        confirmDialog.cancel();
        return;
      }
      // During a careful save run, Escape stops it before the next click (a
      // save already in flight is waited for and reported)
      if (carefulRun) {
        carefulRun.stop = true;
        cancelSelection('esc');
        return;
      }
      // Otherwise it closes a "Stopped" message that is still showing
      dismissStickyToast();
      cancelSelection('esc');
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
