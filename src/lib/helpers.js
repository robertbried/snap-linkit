/**
 * Snap Linkit - pure helpers shared by content.js, background.js and popup.js.
 *
 * Classic script: it is listed before those files in manifest.json and
 * popup.html and exposes globalThis.SnapLinkitLib. Nothing here touches the
 * DOM, the WebExtension API or extension state, so the same file is also
 * loadable with require() by the unit tests in test/.
 */
(function () {
  'use strict';

  // Only http(s) URLs can be opened by tabs.create or fetched by
  // downloads.download; javascript:, data:, blob:, file:, about: and
  // friends are rejected by the browser. Checked on the resolved URL so
  // case and whitespace variants of an href attribute are covered.
  const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);
  function isOpenableUrl(url) {
    try {
      return typeof url === 'string' && OPENABLE_PROTOCOLS.has(new URL(url).protocol);
    } catch (e) {
      return false;
    }
  }

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

  // Validate a site-list entry (already trimmed and lowercased by the popup).
  // Valid: domain.com, *.domain.com, sub.domain.com, *.co.uk
  // Invalid: empty, just symbols, no alphanumeric, too short
  function isValidPattern(pattern) {
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

  // Serialized size of the site list, the quantity storage.sync limits per item
  function blacklistBytes(list) {
    return new TextEncoder().encode(JSON.stringify(list)).length;
  }

  // A computed style that draws nothing: display none, visibility hidden or
  // opacity 0 (the visibility test getSelectableElements has always used)
  function isStyleHidden(style) {
    return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
  }

  // Custom-styled checkboxes hide the real <input> (opacity 0, visibility
  // hidden or a 0x0 box) and draw the box on a <label> (issue #1). Given the
  // input's state and its labels' states, return the indexes of the labels
  // that stand in for it: the visible, non-empty ones. [] means the input is
  // used as itself (it shows, or no label stands in for it).
  // An input with display: none gets no stand-ins (ultrareview 1, #3): that is
  // how CSS-only toggles hide theirs (drawers, search buttons, collapsible nav
  // sections, spoilers: a hidden checkbox driven by a visible <label for>), and
  // a drag over their labels must not click them. Fandom's tracking boxes are
  // opacity 0 and 0x0, not display none, so they keep their stand-ins.
  //   input   { hidden, displayNone, rect: { width, height } }
  //           hidden = isStyleHidden(style), displayNone = style.display === 'none'
  //   labels  [{ hidden, rect: { width, height } }]
  function proxyLabelIndexes(input, labels) {
    const shows = (s) => !s.hidden && s.rect.width > 0 && s.rect.height > 0;
    if (shows(input) || input.displayNone === true) return [];
    const out = [];
    labels.forEach((label, i) => { if (shows(label)) out.push(i); });
    return out;
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

  // Scroll-aware selection rectangle in viewport coordinates.
  //   start   { x, y, scrollX, scrollY }  pointer and page scroll when the drag began
  //   current { x, y }                    pointer now
  //   scroll  { x, y }                    page scroll now
  // The start point is shifted by the scroll delta instead of being mutated:
  // if the user scrolled down, the start point moves up in viewport space.
  function selectionRect(start, current, scroll) {
    return rectFromPoints(dragStartPoint(null, null, scroll, start), current);
  }

  // The rectangle between two viewport points, either way round.
  function rectFromPoints(a, b) {
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const height = Math.abs(b.y - a.y);
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  // Where the drag started, in viewport px now (brief 3).
  //   anchor  { offX, offY } or null   the pointer's offset inside the pressed element
  //   rect    the pressed element's box now (null only when there is no anchor)
  //   scroll  { x, y }                 page scroll now
  //   start   { x, y, scrollX, scrollY } pointer and page scroll at the press
  // With an anchor, the start moves with the pressed element (or, since brief
  // 5b, the element found under the press point when the pressed one is fixed,
  // sticky or 0x0), so content above it that changes height mid-drag can't move
  // it. Without one (nothing usable under the point but <html>/<body>, or no
  // element at all), the start is the press point moved by the scroll since, as
  // before brief 3. An anchor without a box is a caller error: the content
  // script finds the element again or cancels first.
  function dragStartPoint(anchor, rect, scroll, start) {
    if (!anchor) {
      return { x: start.x - (scroll.x - start.scrollX), y: start.y - (scroll.y - start.scrollY) };
    }
    if (!rect) throw new Error('dragStartPoint: the pressed element has no box (find it again or cancel first)');
    return { x: rect.left + anchor.offX, y: rect.top + anchor.offY };
  }

  // The one element of a list, or null for none or several (finding the
  // pressed element again: only an unambiguous match counts).
  function uniqueMatch(list) {
    return list && list.length === 1 ? list[0] : null;
  }

  // Brief 5b: the anchor for a press whose own element can't be one (inside a
  // fixed or sticky element, or 0x0). Candidates come in order (the element
  // pressed, then everything under the press point, top to bottom); for each,
  // its mapped element (tracking label or link) is tried first, then the
  // candidate itself. The first usable one wins. The chain stops at the first
  // stop candidate (<html> or <body>, which would protect nothing): null, and the
  // caller keeps the old maths. `candidates` may be lazy; nothing after the
  // winner is read.
  function firstUsableAnchor(candidates, { isStop, map, usable }) {
    for (const c of candidates) {
      if (isStop(c)) return null;
      const m = map(c);
      if (usable(m)) return m;
      if (m !== c && usable(c)) return c;
    }
    return null;
  }

  // Shown (until clicked) when the pressed element left the page mid-drag and
  // can't be found again: the drag is cancelled, nothing is done.
  function dragPageChangedMessage() {
    return 'The page changed under the drag; drag again.';
  }

  // Shown (until clicked) when the drag's start couldn't be set up at the
  // press (choosing its anchor threw) and the press became a drag: the drag is
  // cancelled, nothing is done (brief 5).
  function dragStartFailedMessage() {
    return "Snap Linkit couldn't start this selection; drag again.";
  }

  // Why a drag's protection (brief 3's anchor) was off. One list, shared with
  // the code that decides it, so later briefs reuse the same names.
  // "off:<reason>": no anchor. "on:<reason>" (brief 5b): the pressed element
  // couldn't be the anchor for that reason, and one was found under the press
  // point instead.
  const DRAG_OFF_REASONS = Object.freeze({
    fixedOrSticky: 'fixed-or-sticky', // the pressed element is inside a fixed or sticky element (off: nothing usable under it either)
    noBox: 'no-box',                  // the pressed element has a 0x0 box (off: nothing usable under it either)
    noElement: 'no-element',          // no element under the pointer (unreachable from real input; the smoke harness takes it)
    threw: 'threw',                   // choosing the anchor threw (a drag from that press is cancelled: end=start-failed)
  });

  // @test-only-begin (store builds leave out everything to the matching end: build.mjs stripTestOnly)
  // ---- Test builds only: one diagnostic console line per drag (brief 4) ----
  // How a drag ended (start-failed: the anchor couldn't be chosen at the press, brief 5)
  const DRAG_ENDS = Object.freeze(['release', 'esc', 'page-changed', 'switched-off', 'replaced', 'start-failed']);
  const DRAG_ANCHOR_KINDS = Object.freeze(['label', 'link', 'element', 'none']);
  const DRAG_KEY_KINDS = Object.freeze(['row', 'id', 'link', 'none']);

  // A name in the line: quoted, " becomes ', whitespace collapsed, cut at 40 characters with an ellipsis.
  // Only a Fandom row name or "tag.firstclass" is ever passed in (never link text, URLs or other IDs).
  function dragDiagName(s) {
    if (s === null || s === undefined) return '""';
    let v = String(s).replace(/"/g, "'").replace(/\s+/g, ' ').trim();
    if (v.length > 40) v = v.slice(0, 40) + '\u2026';
    return `"${v}"`;
  }

  // Signed whole CSS px ("+350px", "-350px", "0px"), or "n/a" when unknown
  function dragDiagPx(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
    const r = Math.round(v);
    return r > 0 ? `+${r}px` : r < 0 ? `${r}px` : '0px';
  }

  // The drag line. Throws on a value outside the documented sets (the caller
  // reports that as "drag line failed"; it never reaches the drag itself).
  //   r = { n, end, protection, anchor, key, refind, pressed, moved, gap,
  //         selected, boxes, links, first, last, updates, slowest, scrollPause,
  //         rebuilds }   rebuilds (brief 7): times the drag's element cache was
  //                      rebuilt after a page change (0 = the page didn't change)
  function dragDiagLine(r) {
    const fail = (what) => { throw new Error(`dragDiagLine: bad ${what}`); };
    const count = (v) => Number.isInteger(v) && v >= 0;
    const ms = (v) => Number.isFinite(v) && v >= 0;
    if (!Number.isInteger(r.n) || r.n < 1) fail('n');
    if (!DRAG_ENDS.includes(r.end)) fail('end');
    const offs = Object.values(DRAG_OFF_REASONS);
    const reasoned = (p, prefix) => typeof p === 'string' && p.startsWith(prefix) && offs.includes(p.slice(prefix.length));
    if (r.protection !== 'on' && !reasoned(r.protection, 'off:') && !reasoned(r.protection, 'on:')) fail('protection');
    if (!DRAG_ANCHOR_KINDS.includes(r.anchor)) fail('anchor');
    if (!DRAG_KEY_KINDS.includes(r.key)) fail('key');
    if (!(r.refind === 'none' || r.refind === 'cancelled' || /^found:[1-9][0-9]*$/.test(String(r.refind)))) fail('refind');
    for (const k of ['selected', 'boxes', 'links', 'updates', 'rebuilds']) if (!count(r[k])) fail(k);
    for (const k of ['slowest', 'scrollPause']) if (!ms(r[k])) fail(k);
    // Later fields, each written only when the caller passes it (the content
    // script passes all of them), in this fixed order after rebuilds
    let extra = '';
    for (const [k, allowed] of DRAG_EXTRAS) {
      if (r[k] === undefined) continue;
      if (allowed === 'count' ? !count(r[k]) : !allowed.includes(r[k])) fail(k);
      extra += ` ${k}=${r[k]}`;
    }
    return `[Snap Linkit] drag ${r.n}: end=${r.end} protection=${r.protection} anchor=${r.anchor} key=${r.key} ` +
      `refind=${r.refind} pressed=${dragDiagName(r.pressed)} moved=${dragDiagPx(r.moved)} gap=${dragDiagPx(r.gap)} ` +
      `selected=${r.selected} boxes=${r.boxes} links=${r.links} first=${dragDiagName(r.first)} last=${dragDiagName(r.last)} ` +
      `updates=${r.updates} slowest=${Math.round(r.slowest)}ms scrollPause=${Math.round(r.scrollPause)}ms rebuilds=${r.rebuilds}` + extra;
  }

  // The drag line's later fields, in order: [name, 'count' or the allowed values].
  //   follows: updates made because the page scrolled under the held drag (A1)
  //   lock: "tracking" when the drag selects only Fandom tracking boxes (B)
  //   fixedOut: elements left out because they sit in a fixed container the drag wasn't pressed in (C)
  //   topSpeed: the fastest auto-scroll rate this drag reached, CSS px per second (A2)
  //   carried: "last-seen" when the pressed element was lost for good and the
  //            drag carried on from where it was last seen; "no" otherwise (it
  //            stayed, was found again, the drag had none, or it was cancelled:
  //            end=page-changed refind=cancelled) (ultrareview 1, #1)
  const DRAG_EXTRAS = Object.freeze([
    ['follows', 'count'],
    ['lock', ['tracking', 'none']],
    ['fixedOut', 'count'],
    ['topSpeed', 'count'],
    ['carried', ['no', 'last-seen']],
  ].map(Object.freeze));
  // @test-only-end

  // The checkbox save delay setting (item 6, the popup slider): a whole number
  // of ms from 0 to 2000; out-of-range values are clamped. Anything else
  // (missing, not a number) falls back to the default the caller passes, and
  // if that is no good either, to 150 ms: the wait is never NaN (which would
  // not wait at all).
  const SAVE_GAP_MAX_MS = 2000;
  const SAVE_GAP_DEFAULT_MS = 150;
  function saveGapMs(value, fallback) {
    const ms = (x) => {
      const v = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
      return Number.isFinite(v) ? Math.min(SAVE_GAP_MAX_MS, Math.max(0, Math.round(v))) : null;
    };
    const a = ms(value);
    if (a !== null) return a;
    const b = ms(fallback);
    return b !== null ? b : SAVE_GAP_DEFAULT_MS;
  }

  // The pressed element is gone for good mid-drag (removed, or 0x0, and not
  // found again uniquely). What happens to the drag (ultrareview 1, #1):
  //   'cancel'   a drag locked to Fandom tracking boxes (B's lock): a start no
  //              longer tied to the pressed row could save the wrong boxes, so
  //              the drag ends with "The page changed under the drag";
  //   'carry-on' any other drag: it carries on from where the pressed element
  //              was last seen. Virtualised feeds remove rows that scroll away
  //              and hover-only buttons hide; the box keeps showing what a
  //              release would act on.
  //   { trackLock }   trackLock = the drag is locked to tracking boxes
  function anchorLostOutcome(f) {
    return f && f.trackLock === true ? 'cancel' : 'carry-on';
  }

  // At release, for a drag that carried on after losing its pressed element:
  // its start is no longer tied to what was pressed, so it may not save Fandom
  // tracking boxes (ultrareview 1, #1, the gap left by anchorLostOutcome).
  //   'refuse'  it carried on and its release would toggle tracking boxes (it
  //             holds tracking boxes and no links): nothing is clicked, and
  //             "The page changed under the drag; drag again." is shown
  //   'act'     anything else (a release with links opens them and leaves the
  //             boxes alone, as always)
  //   { carried, links, trackedBoxes }   carried: the drag carried on; links,
  //                                      trackedBoxes: counts in the selection
  function releaseAfterCarryOn(f) {
    return f && f.carried === true && !(f.links > 0) && f.trackedBoxes > 0 ? 'refuse' : 'act';
  }

  // C: may an element inside a position: fixed container be selected? Plain
  // facts: { inFixed: it sits inside a fixed container, pressedInside: the
  // drag was pressed inside that same container }. Fixed headers, side bars
  // and pop-ups stay put while the page scrolls, so a long drag's box comes to
  // cover them without the user meaning to; a drag made inside one still
  // selects its own links. Sticky elements are not affected.
  function fixedContainerAllows(f) {
    return !f || f.inFixed !== true || f.pressedInside === true;
  }

  // B: does a drag pressed here select only Fandom tracking boxes? Plain facts
  // about the element pressed: { isTrackedBox: it is the box itself,
  // labelsTrackedBox: it sits in a label of a tracking box, cellHasTrackedBox:
  // the table cell around it holds a tracking box }. A press anywhere in a
  // tracking cell counts (the label, the box, the cell's wrapper or padding),
  // so a drag down a tracking column can't pick up links, page chrome or other
  // checkboxes when the pointer drifts. The drag's anchor is chosen as before.
  function trackingLock(f) {
    return Boolean(f) && (f.isTrackedBox === true || f.labelsTrackedBox === true || f.cellHasTrackedBox === true);
  }

  // Brief 7b: one auto-scroll step. 'instant', so a page that asks for smooth
  // scrolling (Fandom: html { scroll-behavior: smooth }) doesn't turn each
  // step into an animation the next step cuts short; on other pages it's what
  // window.scrollBy(x, y) already does. Pass the result to window.scrollBy.
  function autoScrollStep(left, top) {
    return { left, top, behavior: 'instant' };
  }

  // ---- A2: the page follows the drag ----
  // The edge zone in CSS px: the edge setting is the zone at 100% zoom on a
  // display scaled 150% (Windows laptops); where page pixels are smaller on
  // screen (zoomed out, or a display scaled less) the zone grows to keep its
  // size on screen. Never smaller than the setting in CSS px (today's zone).
  function autoScrollZone(setting, dpr) {
    const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    return setting * Math.max(1, 1.5 / d);
  }

  // Auto-scroll rate along one axis, in CSS px per second, signed (negative =
  // up or left). pos: the pointer's client coordinate (outside the window it
  // can be below 0 or above size); size: the visible window on that axis;
  // zone: autoScrollZone; edgeSpeed: the speed at the window edge, today's
  // speed (the speed setting's px per 16 ms frame), never slower there.
  // Inside the zone the rate grows with depth, from a creep at the zone's
  // inner border to edgeSpeed at the edge; past the edge it keeps growing,
  // to AUTO_SCROLL_CAP times edgeSpeed one more zone further out.
  const AUTO_SCROLL_CREEP = 0.15;
  const AUTO_SCROLL_CAP = 3;
  function autoScrollRate(pos, size, zone, edgeSpeed) {
    if (!(zone > 0) || !(edgeSpeed > 0)) return 0;
    let depth;
    let sign;
    if (pos < zone) { depth = zone - pos; sign = -1; }
    else if (pos > size - zone) { depth = pos - (size - zone); sign = 1; }
    else return 0;
    if (depth <= zone) return sign * edgeSpeed * (AUTO_SCROLL_CREEP + (1 - AUTO_SCROLL_CREEP) * (depth / zone) * (depth / zone));
    return sign * edgeSpeed * Math.min(AUTO_SCROLL_CAP, 1 + (AUTO_SCROLL_CAP - 1) * (depth - zone) / zone);
  }

  // Whole pixels to scroll this tick at `rate` px/s over dtMs, carrying the
  // fraction to the next tick (so slow rates still move): { px, carry }
  function autoScrollDelta(rate, dtMs, carry) {
    const total = rate * dtMs / 1000 + (carry || 0);
    const px = Math.trunc(total);
    return { px, carry: total - px };
  }

  // The pointer end of the selection box, held inside the visible window, so
  // nothing the user can't see is selected (the start stays on the pressed row
  // even after it has scrolled away)
  function clampToArea(point, area) {
    return { x: Math.min(Math.max(point.x, 0), area.width), y: Math.min(Math.max(point.y, 0), area.height) };
  }

  // The live count on the selection box: what a release would act on. Links
  // win (the caller counts them once per address); otherwise checkboxes, then
  // radio buttons. '' = nothing a release would act on: the label hides.
  //   { links, boxes, radios }
  function liveCountText(c) {
    if (c.links > 0) return plural(c.links, 'link');
    if (c.boxes > 0) return `${c.boxes} ${c.boxes === 1 ? 'box' : 'boxes'}`;
    if (c.radios > 0) return plural(c.radios, 'radio button');
    return '';
  }

  // A1: does the page need a new update because it scrolled? Plain facts:
  // last / now: the window's scroll position { x, y } at the last update and
  // now; inner: a scrolling box inside the page scrolled since the last
  // update. An auto-scroll step updates on its own, so its scroll is already
  // seen when the frame comes.
  function dragFollowNeeded(last, now, inner) {
    if (inner === true) return true;
    if (!last || !now) return true;
    return last.x !== now.x || last.y !== now.y;
  }

  // ---- Brief 7: the drag's element cache (pure parts) ----

  // Is this element selectable? Today's rules, as plain facts so they're
  // testable without a DOM (the content script reads the facts):
  //   { hidden, hasProxyLabels, isSvgLink, isLink, rawHref, openable }
  // hidden: isStyleHidden of its computed style; hasProxyLabels: a hidden
  // checkbox shows through a visible label (read only when hidden); isSvgLink:
  // an SVG <a> (its href can't be acted on); rawHref / openable: a link's href
  // attribute and isOpenableUrl of its resolved href.
  function selectableVerdict(f) {
    if (f.hidden) return f.hasProxyLabels === true;
    if (f.isSvgLink) return false;
    if (f.isLink) {
      const raw = String(f.rawHref || '').trim();
      if (!raw || raw.startsWith('#')) return false; // same-page fragment links
      if (!f.openable) return false;
    }
    return true;
  }

  // Each control's labels, from [label, control] pairs in document order (the
  // inverse of label.control, which is what control.labels returns, per the
  // HTML spec). One pass over the page's labels instead of one document search
  // per checkbox.
  function labelMapFrom(pairs) {
    const map = new Map();
    for (const [label, control] of pairs) {
      if (!control) continue;
      if (!map.has(control)) map.set(control, []);
      map.get(control).push(label);
    }
    return map;
  }

  // Does an element touch the selection box: its own box, or (for a checkbox)
  // one of its labels' boxes? Everything selected touches it, so only these
  // elements need the full selectable check. labelRects() is called only when
  // the own box doesn't touch.
  function touchesSelection(selRect, ownRect, labelRects) {
    if (rectsIntersect(selRect, ownRect)) return true;
    return labelRects().some((r) => rectsIntersect(selRect, r));
  }

  // Do two class attribute values differ only in snaplinkit-* classes (Snap
  // Linkit's own highlight and state classes)?
  function onlyOwnClassChange(oldValue, newValue) {
    const a = new Set(String(oldValue || '').split(/\s+/).filter(Boolean));
    const b = new Set(String(newValue || '').split(/\s+/).filter(Boolean));
    for (const x of a) if (!b.has(x) && !x.startsWith('snaplinkit-')) return false;
    for (const x of b) if (!a.has(x) && !x.startsWith('snaplinkit-')) return false;
    return true;
  }

  // Does a page change make the drag's element cache stale? Plain facts about
  // one MutationRecord: { type, inUi, nodesAllUi, attributeName, oldValue,
  // newValue }. inUi: the change is inside Snap Linkit's UI; nodesAllUi: every
  // added and removed node is Snap Linkit's UI (the lasso, menu, toast or
  // confirm). Snap Linkit's own changes never count; anything not understood
  // does (a stale cache costs one rebuild, never a wrong selection).
  function pageChangeMarksStale(r) {
    if (r.inUi) return false;
    if (r.type === 'childList') return r.nodesAllUi !== true;
    if (r.type === 'attributes' && r.attributeName === 'class') return !onlyOwnClassChange(r.oldValue, r.newValue);
    return true;
  }

  // Links that the "Download N Files" action offers (by URL suffix)
  const DOWNLOAD_EXTENSIONS = /\.(pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|jpg|jpeg|png|gif|svg)$/i;
  function isDownloadableUrl(url) {
    return typeof url === 'string' && DOWNLOAD_EXTENSIONS.test(url);
  }

  // Checkbox majority rule: if half or fewer are checked, check all; otherwise uncheck all
  function majorityShouldCheck(checkedCount, total) {
    return checkedCount <= total / 2;
  }

  // Place one axis of the action menu inside the visible area.
  //   start   pointer coordinate (where the menu would start)
  //   size    the menu's natural size on this axis
  //   space   visible size of the viewport on this axis (scrollbars excluded)
  //   margin  gap to keep from both edges
  // Returns { pos, max }: pos is the menu's start coordinate; max is null when
  // the menu fits, otherwise the size to cap it at (it then scrolls inside).
  // - Fits with `margin` on both sides: at the pointer, moved back by the
  //   overflow, never closer than `margin` to the start edge (the menu's
  //   placement before P2-3).
  // - Fits only with less: the margins shrink (centred), so the whole menu
  //   stays visible without scrolling.
  // - Larger than the space: capped to space - 2 * margin, pinned at margin.
  function fitMenuAxis(start, size, space, margin) {
    const avail = Math.max(0, space - 2 * margin);
    if (size > space) return { pos: margin, max: avail };
    if (size > avail) return { pos: (space - size) / 2, max: null };
    let pos = start;
    if (pos + size > space - margin) pos = space - margin - size;
    return { pos: Math.max(margin, pos), max: null };
  }

  // Clamp one axis of a menu the user is dragging so it stays inside the
  // visible area, with the same rule as fitMenuAxis: `margin` from both edges
  // when there is room for it, otherwise the margin shrinks (down to 0).
  //   pos    wanted start coordinate   size   menu size on this axis
  //   space  visible size of the viewport on this axis
  function clampMenuAxis(pos, size, space, margin) {
    const m = Math.max(0, Math.min(margin, (space - size) / 2));
    return Math.min(Math.max(pos, m), Math.max(m, space - size - m));
  }

  // "When I let go": what a plain release over links does. Ctrl at release
  // and add/remove drags (dragModifierMode) always show the menu, whatever
  // this says.
  const RELEASE_ACTIONS = Object.freeze(['open', 'openUnloaded', 'copyUrls', 'menu']);
  // A stored value that is not one of RELEASE_ACTIONS (missing, older or
  // hand-edited) counts as the default, 'open'.
  function normalizeReleaseAction(value) {
    return RELEASE_ACTIONS.includes(value) ? value : 'open';
  }

  // How a right-drag edits the selection, from the modifier keys held as it
  // starts (a mousedown event, or any { ctrlKey, shiftKey, altKey }):
  //   'add'     Ctrl (advertised since P2-9), or Shift (the old key, kept
  //             working but no longer advertised: Firefox always shows its
  //             own context menu after a Shift+right-click, and pages cannot
  //             cancel it)
  //   'remove'  Alt
  //   null      none of these: a fresh selection
  // Shift and Alt win over Ctrl, so every combination that worked before
  // P2-9 (Shift+Alt = add, Ctrl+Alt = remove) does the same thing now.
  function dragModifierMode(keys) {
    if (!keys) return null;
    if (keys.shiftKey) return 'add';
    if (keys.altKey) return 'remove';
    return keys.ctrlKey ? 'add' : null;
  }

  function plural(count, noun) {
    return `${count} ${noun}${count !== 1 ? 's' : ''}`;
  }

  // ---- Careful saving for Fandom's progress-tracking checkboxes (brief 2) ----
  // Fandom saves each tracking checkbox on its own `change` event, with no
  // queue and no limit. Snap Linkit therefore clicks these boxes one at a
  // time and reads the result back from the box (BRIEF-2-DESIGN-v2.md).

  // Fandom's own selector (CHECKBOX_SELECTOR in ext.fandom.TableProgressTracking.js,
  // July 2026) and the table its script looks inside. Recognised on any host.
  const TRACKED_CHECKBOX_SELECTOR = 'input[type="checkbox"][data-tpt-row-id][data-table-id]';
  const TRACKED_TABLE_SELECTOR = 'table[data-tpt-id]';

  // Is this a Fandom tracking checkbox? Plain facts about the element, so the
  // rule is testable without a DOM:
  //   { tagName, type, hasRowId, hasTableId, inTrackedTable }
  // hasRowId / hasTableId: the data-tpt-row-id / data-table-id attributes are
  // present (any value, as in the selector); inTrackedTable: it sits inside
  // table[data-tpt-id]. Telepedia's markup (data-row-id) is not covered.
  function isTrackedCheckbox(info) {
    return Boolean(info) &&
      String(info.tagName || '').toLowerCase() === 'input' &&
      String(info.type || '').toLowerCase() === 'checkbox' &&
      info.hasRowId === true && info.hasTableId === true && info.inTrackedTable === true;
  }

  // What a tracking checkbox shows straight after el.click(), in the same task
  // (Fandom sets `disabled` and `is-saving` before its first await):
  //   'saving'       checked = target, is-saving       a save is in flight
  //   'refused'      checked != target, no is-saving   the page cancelled the click (signed out)
  //   'unconfirmed'  checked = target, no is-saving    changed, but no save started
  //   'unexpected'   checked != target, is-saving      treated as a failed save
  function afterClickOutcome({ checked, target, saving }) {
    const changed = checked === target;
    if (saving) return changed ? 'saving' : 'unexpected';
    return changed ? 'unconfirmed' : 'refused';
  }

  // Notes after a checkbox message, only when not zero, in this order:
  // not accepted, failed, already, disabled skipped.
  function checkboxNotes(c) {
    const v = c.target ? 'checked' : 'unchecked';
    const notes = [];
    if (c.refused > 0) notes.push(`${c.refused} not accepted by the page`);
    if (c.failed > 0) notes.push(`${c.failed} failed`);
    if (c.already > 0) notes.push(`${c.already} already ${v}`);
    if (c.disabled > 0) notes.push(`${c.disabled} disabled skipped`);
    return notes.length > 0 ? ` (${notes.join(', ')})` : '';
  }

  // Ordinary (non-Fandom) checkboxes: honest counts, no waiting, no stopping.
  //   c = { target, m, k, n, refused, failed, already, disabled }
  //   m selected; k needed changing (m - already - disabled); n changed
  function ordinaryCheckboxMessage(c) {
    const verb = c.target ? 'Checked' : 'Unchecked';
    const notes = checkboxNotes(c);
    if (c.k === 0) return `${verb} 0 of ${plural(c.m, 'item')}${notes}`;
    if (c.n === c.k) return `${verb} ${plural(c.n, 'item')}${notes}`;
    return `${verb} ${c.n} of ${plural(c.k, 'item')}${notes}`;
  }

  // Tracked checkboxes (careful mode). Wording: BRIEF-2-DESIGN-v2.md section 4.
  //   c = { kind, target, m, k, n, i, rest, already, disabled, timeoutSec }
  //   kind: 'done' | 'esc' | 'failed' | 'timeout' | 'refusedFirst' |
  //         'refusedLater' | 'unconfirmed' | 'tableChanged' | 'error'
  // The already/disabled notes follow the "saved" count they qualify.
  function carefulCheckboxMessage(c) {
    const verb = c.target ? 'Checked' : 'Unchecked';
    const v = verb.toLowerCase();
    const notes = checkboxNotes({ target: c.target, already: c.already, disabled: c.disabled });
    const saved = `${c.n} ${v} and saved${notes}`;
    switch (c.kind) {
      case 'done':
        if (c.k === 0 && c.n === 0) return `${verb} 0 of ${plural(c.m, 'item')}${notes}`;
        return `${verb} and saved ${plural(c.n, 'item')}${notes}.`;
      case 'esc':
        return `Stopped: ${v} and saved ${c.n} of ${plural(c.k, 'item')}${notes}. ${c.rest} not tried.`;
      case 'failed':
        return `Stopped: the page couldn't save item ${c.i} of ${c.k}. ${saved}; ${c.rest} not tried. Try again later.`;
      case 'timeout':
        return `Stopped: item ${c.i} of ${c.k} was still saving after ${c.timeoutSec} seconds. ` +
          `It may still save; reload to check. ${saved}; ${c.rest} not tried.`;
      case 'refusedFirst':
        return `This page didn't accept the change (0 of ${c.k} changed); you may need to sign in.` +
          (notes ? ` ${notes.trim()}` : '');
      case 'refusedLater':
        return `Stopped: the page didn't accept item ${c.i} of ${c.k}; you may need to sign in. ${saved}.`;
      case 'unconfirmed':
        return `Stopped: item ${c.i} changed, but Snap Linkit couldn't confirm it was saved. Reload to check. ${saved}.`;
      case 'tableChanged':
        return `Stopped: the table changed while saving. ${saved}; ${c.rest} not tried.`;
      case 'error':
        // Not in the design's table: an exception inside Snap Linkit itself
        return `Stopped: Snap Linkit hit an error at item ${c.i} of ${c.k}. ${saved}; ${c.rest} not tried.`;
      default:
        throw new Error(`carefulCheckboxMessage: unknown kind "${c.kind}"`);
    }
  }

  // Progress line while a careful run is going (stays on screen).
  function carefulProgressMessage(i, k, ignoredDrag) {
    return `Saving ${i} of ${k}… Press Esc to stop.` +
      (ignoredDrag ? ' A new drag was ignored while saving.' : '');
  }

  // "about 20 seconds", "about 1 minute", "about 3 minutes"
  function formatDurationEstimate(ms) {
    const secs = Math.max(0, Number(ms) || 0) / 1000;
    const fives = Math.max(5, Math.round(secs / 5) * 5);
    if (fives < 60) return `about ${fives} seconds`;
    return `about ${plural(Math.max(1, Math.round(secs / 60)), 'minute')}`;
  }

  // Confirm shown before a careful run above the threshold. The design writes
  // "{verb} {k} items?" / "{verb} All" with {verb} = Checked/Unchecked; read as
  // the imperative here ("Check 40 items?", "Check All"), like "Open 25 tabs?".
  //   perItemMs: gap + assumed save time per box
  function carefulConfirmText(target, k, perItemMs) {
    const verb = target ? 'Check' : 'Uncheck';
    return {
      title: `${verb} ${plural(k, 'item')}?`,
      message: `Snap Linkit will save them one at a time. This takes ${formatDurationEstimate(k * perItemMs)}.`,
      confirmLabel: `${verb} All`,
    };
  }

  // ---- Brief 2b: no silent or wrong message when something around a careful run fails ----

  // Ordinary checkboxes whose result could not be read. They were clicked, so
  // the message must not say that nothing changed. No trailing period: in a
  // mixed drag it leads the careful message, as ordinaryCheckboxMessage does.
  function ordinaryUnreadMessage() {
    return 'Snap Linkit clicked the checkboxes, but couldn\'t check the result';
  }

  // Last-resort message after a fault around a careful run, by how far it got:
  //   'before'   the run never started: nothing was clicked
  //   'running'  the run itself failed and left no counts
  //   'after'    the run finished with counts c; showing its message failed
  // k: the boxes that needed saving.
  function carefulFallbackMessage(stage, c, k) {
    if (stage === 'before') {
      return `Stopped: Snap Linkit hit an error before saving. Nothing was changed (0 of ${plural(k, 'item')}).`;
    }
    if (stage === 'after' && c && Number.isFinite(c.n) && Number.isFinite(c.k)) {
      const v = c.target ? 'checked' : 'unchecked';
      return `Snap Linkit hit an error showing the result: ${c.n} of ${plural(c.k, 'item')} ${v} and saved. Reload to check.`;
    }
    return 'Stopped: Snap Linkit hit an error while saving. Reload to check what was saved.';
  }

  // The confirm before a big careful run could not be shown, so nothing was
  // saved: 'busy' (another Snap Linkit dialog is open) or 'failed'.
  function carefulNotStartedMessage(reason, k) {
    const nothing = `Nothing was saved (0 of ${plural(k, 'item')}).`;
    if (reason === 'saving') return `An earlier save is still running. Wait until it finishes, or reload the page, then drag again. ${nothing}`;
    return reason === 'busy'
      ? `Another Snap Linkit dialog is open. Close it and drag again. ${nothing}`
      : `Stopped: Snap Linkit couldn't open its confirm dialog. ${nothing}`;
  }

  // @test-only-begin
  // Lab builds only (build.mjs --faults): does the fault list spec, e.g.
  // "report,progress@3", name this point? "name" always matches; "name@N"
  // only when n === N. Anything that is not a non-empty string matches nothing.
  function faultMatches(spec, name, n) {
    if (typeof spec !== 'string' || spec.trim() === '') return false;
    return spec.split(',').some((entry) => {
      const [fname, at, extra] = entry.trim().split('@');
      if (extra !== undefined || fname !== name) return false;
      return at === undefined || (at !== '' && Number(at) === n);
    });
  }
  // @test-only-end

  // Characters the downloads API rejects in a filename: backslash, slash,
  // colon, star, question mark, quote, angle brackets, pipe, and the ASCII
  // control range (built from char codes so this file stays free of them).
  const FILENAME_UNSAFE = new RegExp(
    '[\\\\/:*?"<>|' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']',
    'g'
  );

  // Derive a download filename from the URL path: last path segment,
  // percent-decoded, with unsafe characters replaced and leading dots
  // stripped. Falls back to "download" for paths ending in "/".
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
      .replace(FILENAME_UNSAFE, '_')
      .replace(/^\.+/, '')
      .trim();
    return cleaned || 'download';
  }

  // ---- "What's new" notice (1.4.0: letting go acts at once) ----
  // WHATS_NEW_VERSION: an update from any version before it gets the note.
  // People updating from before 1.3.0 also get the 1.3.0 shortcut lines: the
  // version that changed the defaults, and the new defaults. A command
  // whose current shortcut still equals its entry here is one the user saw
  // change; a customised or cleared shortcut did not change for them.
  const WHATS_NEW_VERSION = '1.4.0';
  const WHATS_NEW_SHORTCUTS_VERSION = '1.3.0';
  const WHATS_NEW_SHORTCUTS = Object.freeze([
    Object.freeze({ name: 'toggle-extension', label: 'Turn Snap Linkit on or off', shortcut: 'Alt+Shift+L' }),
    Object.freeze({ name: 'open-selected-tabs', label: 'Open selected links', shortcut: 'Alt+Shift+Comma' }),
  ]);

  // Dotted numeric version compare: true when a is older than b
  // ("1.2.1" < "1.3.0"). Missing or non-numeric parts count as 0.
  function isVersionBefore(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  // runtime.onInstalled details -> offer the notice? Only an update from a
  // version before 1.4.0. Installs, browser updates and reloads of the same
  // version are excluded; temporary loads are deliberately not.
  function shouldOfferWhatsNew(details) {
    return Boolean(details) && details.reason === 'update' &&
      typeof details.previousVersion === 'string' &&
      isVersionBefore(details.previousVersion, WHATS_NEW_VERSION);
  }

  // "Alt+Shift+Comma" -> "Alt + Shift + Comma"; on macOS Alt is the Option
  // key and Ctrl means Command (MDN manifest.json/commands).
  const MAC_KEY_NAMES = { Alt: 'Option', Ctrl: 'Command', MacCtrl: 'Control' };
  function formatShortcut(shortcut, isMac) {
    return String(shortcut).split('+')
      .map((part) => (isMac && MAC_KEY_NAMES[part]) || (part === 'MacCtrl' ? 'Control' : part))
      .join(' + ');
  }

  // storage.local "whatsNew" record for an update from previousVersion.
  // shortcuts: also show the 1.3.0 shortcut lines, for an update from before
  // 1.3.0 or when a 1.3.0 note was still waiting for "Got it" (pending).
  function whatsNewRecord(previousVersion, pending) {
    return {
      version: WHATS_NEW_VERSION,
      badge: true,
      shortcuts: isVersionBefore(previousVersion, WHATS_NEW_SHORTCUTS_VERSION) || whatsNewShowsShortcuts(pending),
    };
  }

  // Does a stored record ask for the shortcut lines? A 1.3.0 record (written
  // by 1.3.0, no shortcuts field) was a shortcut note, so it does.
  function whatsNewShowsShortcuts(record) {
    return Boolean(record) && (record.shortcuts === true || record.version === WHATS_NEW_SHORTCUTS_VERSION);
  }

  // commands.getAll() result -> note lines, one per command still on its new
  // default. Empty when the user customised or cleared both.
  function whatsNewLines(commands, isMac) {
    const current = new Map((Array.isArray(commands) ? commands : []).map((c) => [c && c.name, c && c.shortcut]));
    return WHATS_NEW_SHORTCUTS
      .filter((s) => current.get(s.name) === s.shortcut)
      .map((s) => `${s.label}: ${formatShortcut(s.shortcut, isMac)}`);
  }

  globalThis.SnapLinkitLib = Object.freeze({
    OPENABLE_PROTOCOLS,
    isOpenableUrl,
    matchesPattern,
    isValidPattern,
    blacklistBytes,
    rectsIntersect,
    isStyleHidden,
    proxyLabelIndexes,
    selectionRect,
    rectFromPoints,
    dragStartPoint,
    uniqueMatch,
    firstUsableAnchor,
    dragPageChangedMessage,
    dragStartFailedMessage,
    DRAG_OFF_REASONS,
    DRAG_ENDS, // @test-only
    dragDiagName, // @test-only
    dragDiagPx, // @test-only
    dragDiagLine, // @test-only
    DRAG_EXTRAS, // @test-only
    anchorLostOutcome,
    saveGapMs,
    SAVE_GAP_MAX_MS,
    SAVE_GAP_DEFAULT_MS,
    releaseAfterCarryOn,
    dragFollowNeeded,
    autoScrollStep,
    autoScrollZone,
    AUTO_SCROLL_CREEP,
    AUTO_SCROLL_CAP,
    autoScrollRate,
    autoScrollDelta,
    clampToArea,
    liveCountText,
    trackingLock,
    fixedContainerAllows,
    selectableVerdict,
    labelMapFrom,
    touchesSelection,
    onlyOwnClassChange,
    pageChangeMarksStale,
    DOWNLOAD_EXTENSIONS,
    isDownloadableUrl,
    majorityShouldCheck,
    fitMenuAxis,
    clampMenuAxis,
    RELEASE_ACTIONS,
    normalizeReleaseAction,
    dragModifierMode,
    plural,
    TRACKED_CHECKBOX_SELECTOR,
    TRACKED_TABLE_SELECTOR,
    isTrackedCheckbox,
    afterClickOutcome,
    ordinaryCheckboxMessage,
    carefulCheckboxMessage,
    carefulProgressMessage,
    formatDurationEstimate,
    carefulConfirmText,
    ordinaryUnreadMessage,
    carefulFallbackMessage,
    carefulNotStartedMessage,
    faultMatches, // @test-only
    filenameFromUrl,
    WHATS_NEW_VERSION,
    WHATS_NEW_SHORTCUTS,
    isVersionBefore,
    shouldOfferWhatsNew,
    whatsNewRecord,
    whatsNewShowsShortcuts,
    formatShortcut,
    whatsNewLines,
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = globalThis.SnapLinkitLib;
  }
})();
