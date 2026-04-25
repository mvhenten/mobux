// ── Mobile Input Adapter ─────────────────────────────────────────────
// Intercepts input on xterm.js's hidden textarea to handle mobile
// keyboard autocomplete/autocorrect properly.
//
// Problem: xterm.js sends each keystroke immediately to the PTY.
// Mobile keyboards replace partial text on autocomplete, causing
// garbled output (backspaces + replacement fight with already-sent chars).
//
// Solution: Track what we've sent in a shadow buffer. On replacement
// events, compute the diff and send only what's needed.
//
// Event classification via beforeinput.inputType:
//   insertText             → direct keystroke, send immediately
//   insertReplacementText  → autocomplete, diff against shadow buffer
//   insertCompositionText  → mid-composition, buffer until compositionend
//   deleteContentBackward  → backspace; context-dependent
//
// Usage:
//   const adapter = createMobileInputAdapter(term, sendToWs);
//   adapter.destroy();

export function createMobileInputAdapter(term, send) {
  const textarea = term.textarea;
  if (!textarea) throw new Error('term.textarea not available — call after term.open()');

  // Shadow buffer: tracks what we've already sent to the PTY
  let sent = '';
  let composing = false;
  let suppressNextInput = false;

  // Detach xterm.js's default onData handler — we'll handle sending ourselves
  // We intercept at the beforeinput/input level on the textarea
  const origOnData = [];

  function sendText(text) {
    if (text) send(text);
  }

  function sendBackspaces(n) {
    for (let i = 0; i < n; i++) send('\x7f');
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd() {
    composing = false;
    // The final composed text will arrive via the input event.
    // We handle it there.
  }

  function onBeforeInput(e) {
    const { inputType, data } = e;

    switch (inputType) {
      case 'insertReplacementText': {
        // Autocomplete/autocorrect: keyboard replaced partial text.
        // data = the replacement string (e.g. "hello")
        // sent = what we already sent (e.g. "hel")
        e.preventDefault();
        suppressNextInput = true;

        const replacement = data || '';

        // Find common prefix between sent and replacement
        let common = 0;
        while (common < sent.length && common < replacement.length &&
               sent[common] === replacement[common]) {
          common++;
        }

        // Delete chars after the common prefix that we already sent
        const toDelete = sent.length - common;
        sendBackspaces(toDelete);

        // Send the remainder of the replacement
        const toSend = replacement.slice(common);
        sendText(toSend);

        // Update shadow buffer
        sent = replacement;
        return;
      }

      case 'insertCompositionText': {
        // Mid-composition (Android Gboard keeps everything in composition).
        // Don't send anything yet — wait for compositionend.
        return;
      }

      case 'deleteContentBackward': {
        if (composing) {
          // Backspace during composition — let the keyboard manage it,
          // we haven't sent the composed text yet.
          return;
        }
        // Real backspace — send it and update shadow buffer.
        // Don't prevent default: let xterm.js also handle it for cursor.
        sent = sent.slice(0, -1);
        return;
      }

      case 'insertText': {
        // Direct keystroke — let it through, xterm.js sends via onData.
        // Just track it in our shadow buffer.
        if (data) sent += data;
        return;
      }

      // insertLineBreak (Enter), insertParagraph, etc.
      default:
        // Reset shadow buffer on Enter or other structural input
        if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
          sent = '';
        }
        return;
    }
  }

  function onInput(e) {
    if (suppressNextInput) {
      // We already handled this in beforeinput (insertReplacementText).
      // Prevent xterm.js from double-processing.
      e.stopImmediatePropagation();
      suppressNextInput = false;
      return;
    }

    if (composing) {
      // Still composing — don't let xterm.js send partial text.
      // Exception: compositionend fires before the final input event
      // on some browsers. Check if composition just ended.
      return;
    }
  }

  function onCompositionEndInput() {
    // After compositionend, the final text appears in textarea.value.
    // On Android, the entire word is the composition result.
    // Send the diff between what we sent and the final composed text.
    //
    // We use a microtask to run after the input event fires.
    queueMicrotask(() => {
      if (composing) return; // another composition started

      const textareaValue = textarea.value;
      if (!textareaValue) return;

      // Find what's new compared to what we've sent
      let common = 0;
      while (common < sent.length && common < textareaValue.length &&
             sent[common] === textareaValue[common]) {
        common++;
      }

      const toDelete = sent.length - common;
      sendBackspaces(toDelete);

      const toSend = textareaValue.slice(common);
      sendText(toSend);

      sent = textareaValue;
    });
  }

  // Reset shadow buffer on special keys that reset the line
  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === 'Return') {
      sent = '';
    } else if (e.key === 'Escape' || (e.ctrlKey && e.key === 'c')) {
      sent = '';
    } else if (e.key === 'Tab') {
      // Tab completion changes the line — reset shadow
      sent = '';
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
               e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
               e.key === 'Home' || e.key === 'End') {
      // Cursor movement invalidates our shadow position tracking
      sent = '';
    }
  }

  // Attach listeners — beforeinput must be first to intercept before xterm.js
  textarea.addEventListener('beforeinput', onBeforeInput, { capture: true });
  textarea.addEventListener('input', onInput, { capture: true });
  textarea.addEventListener('compositionstart', onCompositionStart, { capture: true });
  textarea.addEventListener('compositionend', onCompositionEnd, { capture: true });
  textarea.addEventListener('compositionend', onCompositionEndInput, { capture: false });
  textarea.addEventListener('keydown', onKeyDown, { capture: true });

  return {
    // Expose for testing
    getSent: () => sent,
    resetSent: () => { sent = ''; },

    destroy() {
      textarea.removeEventListener('beforeinput', onBeforeInput, { capture: true });
      textarea.removeEventListener('input', onInput, { capture: true });
      textarea.removeEventListener('compositionstart', onCompositionStart, { capture: true });
      textarea.removeEventListener('compositionend', onCompositionEnd, { capture: true });
      textarea.removeEventListener('compositionend', onCompositionEndInput, { capture: false });
      textarea.removeEventListener('keydown', onKeyDown, { capture: true });
    }
  };
}
