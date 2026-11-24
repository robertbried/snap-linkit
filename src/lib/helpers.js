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

  // Custom-styled checkboxes hide the real <input> (opacity 0,
  // display none, visibility hidden or a 0x0 box) and draw the box on a
  // <label> (issue #1). Given the input's state and its labels' states, return
  // the indexes of the labels that stand in for it: the visible, non-empty
  // ones. [] means the input is used as itself (it shows, or no label shows).
  //   input   { hidden, rect: { width, height } }   hidden = isStyleHidden(style)
  //   labels  [{ hidden, rect: { width, height } }]
  function proxyLabelIndexes(input, labels) {
    const shows = (s) => !s.hidden && s.rect.width > 0 && s.rect.height > 0;
    if (shows(input)) return [];
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
  // With an anchor, the start moves with the pressed element, so content above
  // it that changes height mid-drag can't move it. Without one (a press in a
  // fixed or sticky element, or on a 0x0 box), the start is the press point
  // moved by the scroll since, as before brief 3. An anchor without a box is a
  // caller error: the content script finds the element again or cancels first.
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

  // ---- Test builds only: one diagnostic console line per drag (brief 4) ----
  // Why a drag's protection (brief 3's anchor) was off. One list, shared with
  // the code that decides it, so later briefs reuse the same names.
  const DRAG_OFF_REASONS = Object.freeze({
    fixedOrSticky: 'fixed-or-sticky', // the pressed element is inside a fixed or sticky element
    noBox: 'no-box',                  // the pressed element has a 0x0 box
    noElement: 'no-element',          // no element under the pointer
    threw: 'threw',                   // choosing the anchor threw (a drag from that press is cancelled: end=start-failed)
  });
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
  //         selected, boxes, links, first, last, updates, slowest, scrollPause }
  function dragDiagLine(r) {
    const fail = (what) => { throw new Error(`dragDiagLine: bad ${what}`); };
    const count = (v) => Number.isInteger(v) && v >= 0;
    const ms = (v) => Number.isFinite(v) && v >= 0;
    if (!Number.isInteger(r.n) || r.n < 1) fail('n');
    if (!DRAG_ENDS.includes(r.end)) fail('end');
    const offs = Object.values(DRAG_OFF_REASONS);
    if (r.protection !== 'on' && !(typeof r.protection === 'string' && r.protection.startsWith('off:') &&
        offs.includes(r.protection.slice(4)))) fail('protection');
    if (!DRAG_ANCHOR_KINDS.includes(r.anchor)) fail('anchor');
    if (!DRAG_KEY_KINDS.includes(r.key)) fail('key');
    if (!(r.refind === 'none' || r.refind === 'cancelled' || /^found:[1-9][0-9]*$/.test(String(r.refind)))) fail('refind');
    for (const k of ['selected', 'boxes', 'links', 'updates']) if (!count(r[k])) fail(k);
    for (const k of ['slowest', 'scrollPause']) if (!ms(r[k])) fail(k);
    return `[Snap Linkit] drag ${r.n}: end=${r.end} protection=${r.protection} anchor=${r.anchor} key=${r.key} ` +
      `refind=${r.refind} pressed=${dragDiagName(r.pressed)} moved=${dragDiagPx(r.moved)} gap=${dragDiagPx(r.gap)} ` +
      `selected=${r.selected} boxes=${r.boxes} links=${r.links} first=${dragDiagName(r.first)} last=${dragDiagName(r.last)} ` +
      `updates=${r.updates} slowest=${Math.round(r.slowest)}ms scrollPause=${Math.round(r.scrollPause)}ms`;
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
    return reason === 'busy'
      ? `Another Snap Linkit dialog is open. Close it and drag again. ${nothing}`
      : `Stopped: Snap Linkit couldn't open its confirm dialog. ${nothing}`;
  }

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
    dragPageChangedMessage,
    dragStartFailedMessage,
    DRAG_OFF_REASONS,
    DRAG_ENDS,
    dragDiagName,
    dragDiagPx,
    dragDiagLine,
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
    faultMatches,
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
