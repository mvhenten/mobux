// TUIs such as Claude Code read a fast multi-character burst as a paste and
// swallow a trailing Enter, so Enter goes out as its own keypress after a gap.
export const SUBMIT_ENTER_DELAY_MS = 50;

export function submitLine(send, text) {
  send(text);
  setTimeout(() => send('\r'), SUBMIT_ENTER_DELAY_MS);
}
