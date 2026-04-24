const session = window.MOBUX_SESSION;
const termEl = document.getElementById("terminal");
const term = new Terminal({
  cursorBlink: true,
  fontSize: 15,
  convertEol: true,
  theme: { background: "#0f1115" },
});
term.open(termEl);

const wsProto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${wsProto}://${location.host}/ws/${encodeURIComponent(session)}`);
ws.binaryType = "arraybuffer";

ws.onopen = () => {
  term.writeln("\x1b[32m[connected]\x1b[0m");
  sendResize();
};

ws.onmessage = async (ev) => {
  if (typeof ev.data === "string") {
    term.write(ev.data);
    return;
  }

  if (ev.data instanceof ArrayBuffer) {
    term.write(new Uint8Array(ev.data));
    return;
  }

  // Some browsers may still deliver Blob.
  if (ev.data instanceof Blob) {
    const buf = await ev.data.arrayBuffer();
    term.write(new Uint8Array(buf));
  }
};

ws.onclose = () => term.writeln("\r\n\x1b[31m[disconnected]\x1b[0m");
ws.onerror = () => term.writeln("\r\n\x1b[31m[connection error]\x1b[0m");

term.onData((d) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(d);
});

function sendResize() {
  const cols = Math.max(20, Math.floor(window.innerWidth / 9));
  const rows = Math.max(10, Math.floor((window.innerHeight - 60) / 18));
  term.resize(cols, rows);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}
window.addEventListener("resize", sendResize);
setTimeout(sendResize, 100);

async function sendVoiceText(text) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(session)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await res.text());
}

const micBtn = document.getElementById("micBtn");
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function manualSendFallback() {
  const text = prompt("Speech recognition unavailable. Type command to send:");
  if (!text || !text.trim()) return;
  sendVoiceText(text.trim()).catch((e) => alert(`Send failed: ${e.message}`));
}

if (!SR) {
  micBtn.title = "SpeechRecognition not available in this browser. Click for text fallback.";
  micBtn.addEventListener("click", manualSendFallback);
  term.writeln("\r\n\x1b[33m[speech unavailable in this browser; mic button uses typed fallback]\x1b[0m");
} else {
  const rec = new SR();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.continuous = false;

  let listening = false;

  rec.onstart = () => {
    listening = true;
    micBtn.textContent = "🎙️ Listening...";
  };

  rec.onend = () => {
    listening = false;
    micBtn.textContent = "🎤 Talk";
  };

  rec.onerror = (e) => {
    const details = [
      `error=${e.error}`,
      `secureContext=${window.isSecureContext}`,
      `protocol=${location.protocol}`,
      `host=${location.host}`,
    ].join(", ");
    term.writeln(`\r\n\x1b[31m[speech error: ${details}]\x1b[0m`);

    if (e.error === "not-allowed") {
      alert(
        "Microphone permission denied or blocked. On many browsers, speech/mic only works on HTTPS (or localhost)."
      );
    } else if (e.error === "service-not-allowed") {
      alert("Speech service not allowed in this browser/profile.");
    } else {
      alert(`Speech error: ${e.error}`);
    }
  };

  rec.onresult = async (event) => {
    const text = event.results?.[0]?.[0]?.transcript?.trim();
    if (!text) return;
    term.writeln(`\r\n\x1b[36m[voice] ${text}\x1b[0m`);
    try {
      await sendVoiceText(text);
    } catch (e) {
      alert(`Send failed: ${e.message}`);
    }
  };

  micBtn.addEventListener("click", (ev) => {
    // Shift+click always opens typed fallback.
    // Useful when mic permissions/HTTPS are not available.
    if (ev.shiftKey) {
      manualSendFallback();
      return;
    }
    if (listening) return;
    try {
      rec.start();
    } catch (e) {
      // InvalidStateError etc.
      term.writeln(`\r\n\x1b[31m[speech start failed: ${e.message}]\x1b[0m`);
      manualSendFallback();
    }
  });
}
