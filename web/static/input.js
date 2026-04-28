// ── Mobile Input Adapter ─────────────────────────────────────────────
//
// Fixes two bugs in xterm.js 5.x on mobile:
//
// 1. AUTOCOMPLETE: Mobile keyboards use composition (not insertReplacementText)
//    for autocomplete. They select ALL textarea content via compositionstart,
//    then replace it. xterm.js's _finalizeComposition computes a wrong
//    substring offset, sending garbled partial text.
//
// 2. TEXTAREA CLEAR: Our patched _handleAnyTextareaChanges fires after
//    xterm.js clears the textarea on Enter, computing a massive backspace
//    diff against the now-empty textarea.
//
// Fix: detect composition-based autocomplete (compositionstart with a
// selection) and handle it ourselves with a proper diff, blocking xterm.js.
// Also guard against empty-textarea diffs.

export function createMobileInputAdapter(term) {
  const textarea = term.textarea;
  if (!textarea) throw new Error('term.textarea not available');

  const helper = term._core._compositionHelper;
  const coreService = term._core.coreService;
  if (!helper) return { destroy() {} };

  // ── Block gate on triggerDataEvent ────────────────────────────────
  // ── Debug logging ─────────────────────────────────────────────────
  let eventLog = [];
  let flushTimer = null;

  function log(type, detail) {
    eventLog.push({ t: performance.now().toFixed(1), type, ...detail });
    if (!flushTimer) flushTimer = setTimeout(flushLog, 500);
  }

  function flushLog() {
    flushTimer = null;
    if (!eventLog.length) return;
    const batch = eventLog;
    eventLog = [];
    fetch('/api/debug', { method: 'POST', body: JSON.stringify(batch, null, 2) }).catch(() => {});
  }

  // ── Block gate on triggerDataEvent ────────────────────────────────
  const origTrigger = coreService.triggerDataEvent.bind(coreService);
  let blocked = false;

  coreService.triggerDataEvent = (data, wasUserInput) => {
    if (wasUserInput) log('triggerDataEvent', { data: JSON.stringify(data), len: data.length, blocked });
    if (blocked) return;
    origTrigger(data, wasUserInput);
  };

  // ── Autocomplete detection ────────────────────────────────────────
  // When the keyboard starts a composition with text SELECTED (not just
  // cursor at a point), it's doing autocomplete — selecting existing
  // text to replace it.
  let autocompleteState = null; // { oldValue, selStart, selEnd }

  function onCompositionStart(e) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    log('compositionstart', {
      selStart: start, selEnd: end,
      data: e.data,
      textareaValue: textarea.value.substring(0, 60),
    });

    if (start !== end) {
      autocompleteState = {
        oldValue: textarea.value,
        selStart: start,
        selEnd: end,
      };
    } else {
      autocompleteState = null;
    }
  }

  function onCompositionEnd(e) {
    log('compositionend', {
      data: e.data?.substring(0, 60),
      textareaValue: textarea.value.substring(0, 60),
      isAutocomplete: !!autocompleteState,
    });

    if (!autocompleteState) return; // Normal composition, let xterm.js handle

    const oldValue = autocompleteState.oldValue;
    const newValue = textarea.value;
    autocompleteState = null;

    if (oldValue === newValue) return;

    // Proper character-level diff
    let common = 0;
    while (common < oldValue.length && common < newValue.length &&
           oldValue[common] === newValue[common]) {
      common++;
    }

    const toDelete = oldValue.length - common;
    const toInsert = newValue.substring(common);

    let data = '';
    for (let i = 0; i < toDelete; i++) data += '\x7f';
    data += toInsert;

    // Block xterm.js's _finalizeComposition setTimeout(0) from sending
    // wrong data. 50ms outlasts the timer.
    blocked = true;
    setTimeout(() => { blocked = false; }, 50);

    // Send correct diff ourselves
    log('autocomplete:send', { toDelete, toInsert: toInsert.substring(0, 40), common });
    if (data) origTrigger(data, true);
  }

  // ── Fix _handleAnyTextareaChanges ─────────────────────────────────
  // Patch with proper diff AND guard against textarea-cleared-to-empty.
  helper._handleAnyTextareaChanges = function () {
    if (this._textareaChangeTimer) return;

    const oldValue = textarea.value;

    this._textareaChangeTimer = window.setTimeout(() => {
      this._textareaChangeTimer = undefined;
      if (this._isComposing) return;

      const newValue = textarea.value;
      if (newValue === oldValue) return;

      // Guard: if textarea was cleared to empty, xterm.js did it
      // programmatically (on Enter, blur, etc.) — not user input.
      if (newValue === '') {
        log('_handleChanges:skip-empty', { oldValue: oldValue.substring(0, 40) });
        return;
      }

      // Proper character-level diff
      let common = 0;
      while (common < oldValue.length && common < newValue.length &&
             oldValue[common] === newValue[common]) {
        common++;
      }

      const toDelete = oldValue.length - common;
      const toInsert = newValue.substring(common);

      let data = '';
      for (let i = 0; i < toDelete; i++) data += '\x7f';
      data += toInsert;

      this._dataAlreadySent = toInsert;

      if (data) {
        coreService.triggerDataEvent(data, true);
      }
    }, 0);
  };

  // Register on parent in capture phase (fires before xterm.js)
  const parent = textarea.parentElement;
  parent.addEventListener('compositionstart', onCompositionStart, { capture: true });
  parent.addEventListener('compositionend', onCompositionEnd, { capture: true });

  return {
    destroy() {
      parent.removeEventListener('compositionstart', onCompositionStart, { capture: true });
      parent.removeEventListener('compositionend', onCompositionEnd, { capture: true });
      coreService.triggerDataEvent = origTrigger;
    }
  };
}
