// ── Mobile Input Adapter ─────────────────────────────────────────────
//
// With the patched @xterm/xterm (see patches/xterm-composition-helper.patch),
// the core composition and autocomplete bugs are fixed at the source.
//
// This adapter only provides diagnostic logging to /api/debug for
// ongoing mobile input debugging. Remove once stable.

export function createMobileInputAdapter(term) {
  const textarea = term.textarea;
  if (!textarea) throw new Error('term.textarea not available');

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

  // ── Instrument triggerDataEvent ───────────────────────────────────
  const coreService = term._core.coreService;
  const origTrigger = coreService.triggerDataEvent.bind(coreService);

  coreService.triggerDataEvent = (data, wasUserInput) => {
    if (wasUserInput) {
      log('triggerDataEvent', { data: JSON.stringify(data), len: data.length });
    }
    origTrigger(data, wasUserInput);
  };

  // ── Capture composition events ────────────────────────────────────
  const parent = textarea.parentElement;

  function onCompositionStart(e) {
    log('compositionstart', {
      selStart: textarea.selectionStart,
      selEnd: textarea.selectionEnd,
      data: e.data,
      textareaValue: textarea.value.substring(0, 60),
    });
  }

  function onCompositionEnd(e) {
    log('compositionend', {
      data: e.data?.substring(0, 60),
      textareaValue: textarea.value.substring(0, 60),
    });
  }

  parent.addEventListener('compositionstart', onCompositionStart, { capture: true });
  parent.addEventListener('compositionend', onCompositionEnd, { capture: true });

  return {
    destroy() {
      parent.removeEventListener('compositionstart', onCompositionStart, { capture: true });
      parent.removeEventListener('compositionend', onCompositionEnd, { capture: true });
      coreService.triggerDataEvent = origTrigger;
      flushLog();
    }
  };
}
