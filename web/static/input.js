// ── Mobile Input Adapter ─────────────────────────────────────────────
// Minimal interception layer for mobile autocomplete/autocorrect.
//
// xterm.js handles normal typing and composition (CJK/Gboard) fine.
// The ONLY thing we fix: insertReplacementText events (autocomplete)
// which replace already-sent characters and garble the terminal.
//
// Approach: track what xterm.js sends in a shadow buffer. When we see
// an autocomplete replacement, preventDefault it and send only the diff.

export function createMobileInputAdapter(term, send) {
  const textarea = term.textarea;
  if (!textarea) throw new Error('term.textarea not available — call after term.open()');

  let sent = '';

  function onBeforeInput(e) {
    if (e.inputType === 'insertReplacementText') {
      // Autocomplete/autocorrect: keyboard wants to replace partial text.
      // xterm.js already sent the partial chars. Compute diff and patch.
      e.preventDefault();

      const replacement = e.data || '';

      // Find common prefix
      let common = 0;
      while (common < sent.length && common < replacement.length &&
             sent[common] === replacement[common]) {
        common++;
      }

      // Delete divergent chars we already sent
      const toDelete = sent.length - common;
      for (let i = 0; i < toDelete; i++) send('\x7f');

      // Send new suffix
      const toSend = replacement.slice(common);
      if (toSend) send(toSend);

      sent = replacement;
      return;
    }

    // For normal typing, just track what will be sent
    if (e.inputType === 'insertText' && e.data) {
      sent += e.data;
    } else if (e.inputType === 'deleteContentBackward') {
      sent = sent.slice(0, -1);
    }
  }

  // Reset shadow on line-terminating keys
  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === 'Return' ||
        e.key === 'Escape' || e.key === 'Tab' ||
        (e.ctrlKey && e.key === 'c') ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      sent = '';
    }
  }

  textarea.addEventListener('beforeinput', onBeforeInput, { capture: true });
  textarea.addEventListener('keydown', onKeyDown, { capture: true });

  return {
    getSent: () => sent,
    resetSent: () => { sent = ''; },
    destroy() {
      textarea.removeEventListener('beforeinput', onBeforeInput, { capture: true });
      textarea.removeEventListener('keydown', onKeyDown, { capture: true });
    }
  };
}
