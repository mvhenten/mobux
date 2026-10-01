// A local dev server for test/proxy.spec.cjs: an HTML page with a relative
// stylesheet and script, a root-absolute redirect, and a WebSocket echo at
// `ws`. The WebSocket server is hand-written so the fixture needs no package.

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>proxy fixture</title>
<link rel="stylesheet" href="style.css">
<h1>proxied from a local port</h1>
<p id="echo">waiting</p>
<script src="app.js"></script>
`;

const STYLE = "body { background: rgb(4, 5, 6); color: white; }\n";

const SCRIPT = `const url = new URL("ws", location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(url);
socket.onopen = () => socket.send("ping");
socket.onmessage = (event) => {
  document.getElementById("echo").textContent = event.data;
};
socket.onerror = () => {
  document.getElementById("echo").textContent = "socket error";
};
`;

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function textFrame(text) {
  const payload = Buffer.from(text);
  const head =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

// One complete client frame off the front of `buffer`, or null.
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function upgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!req.url.startsWith("/ws") || !key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + MAGIC)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let frame = readFrame(buffer); frame; frame = readFrame(buffer)) {
      buffer = frame.rest;
      if (frame.opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (frame.opcode === 0x1) {
        socket.write(textFrame(`echo: ${frame.payload.toString()}`));
      }
    }
  });
  socket.on("error", () => socket.destroy());
}

export function startUpstream(port) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://upstream").pathname;
    const send = (type, body) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (path === "/") return send("text/html; charset=utf-8", PAGE);
    if (path === "/style.css") return send("text/css", STYLE);
    if (path === "/app.js") return send("text/javascript", SCRIPT);
    if (path === "/redirect") {
      res.writeHead(302, { location: "/" });
      return res.end();
    }
    if (path === "/headers") {
      return send("application/json", JSON.stringify(req.headers));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", upgrade);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}
