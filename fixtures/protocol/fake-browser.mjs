#!/usr/bin/env node
/** Test-only fake owned process; no installed browser or external network. */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { Socket } from "node:net";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const chromeProfile = args.find(value => value.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
const profile = chromeProfile ?? args[args.indexOf("--profile") + 1];
const config = JSON.parse(readFileSync(path.join(profile, "fake-config.json"), "utf8"));
const record = (event, values = {}) => appendFileSync(path.join(profile, "fake-events.jsonl"), JSON.stringify({ event, time: Date.now(), pid: process.pid, ...values }) + "\n");
record("spawn");
process.on("SIGTERM", () => { record("signal", { signal: "SIGTERM" }); process.exit(0); });
const version = { product: "Chrome/fixture", userAgent: "fixture Chrome/1", protocolVersion: "1.3" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

function command(message, reply) {
  record("command", { method: message.method });
  if (message.method === "Browser.getVersion") {
    if (config.mode === "drop-version") return;
    if (config.mode === "null-version") { reply("null"); return; }
    if (config.mode === "array-version") { reply("[]"); return; }
    if (config.mode === "scalar-version") { reply("7"); return; }
    if (config.mode === "oversize-version") { reply("x".repeat(8 * 1024 * 1024 + 1)); return; }
    if (config.mode === "malformed-version") { reply("{broken JSON"); return; }
    if (config.mode === "error-version") { reply({ id: message.id, error: { message: "authorization=secret /Users/private/profile" } }); return; }
    reply({ id: message.id, result: version }); return;
  }
  if (message.method === "Browser.close" || message.method === "browser.close") {
    record("close");
    reply({ id: message.id, ...(chromeProfile ? { result: {} } : { type: "success", result: {} }) });
    if (config.mode !== "close-no-exit") setTimeout(() => process.exit(0), config.exitDelayMs ?? 20);
    return;
  }
  if (message.method === "session.new" && config.mode === "session-error") {
    reply({ type: "error", id: message.id, error: "fixture", message: "pre-session failure" }); return;
  }
  if (message.method === "session.new" && config.mode === "malformed-session") { reply("{broken JSON"); return; }
  if (message.method === "session.new" && config.mode === "null-session") { reply("null"); return; }
  if (message.method === "session.new" && config.mode === "array-session") { reply("[]"); return; }
  if (message.method === "session.new" && config.mode === "scalar-session") { reply("7"); return; }
  if (message.method === "session.new" && config.mode === "oversize-session") { reply("x".repeat(8 * 1024 * 1024 + 1)); return; }
  if (message.method === "session.new" && config.mode === "drop-session") return;
  let result = {};
  if (message.method === "Target.createTarget") result = { targetId: "target" };
  if (message.method === "Target.attachToTarget") result = { sessionId: "session" };
  if (message.method === "Runtime.evaluate") result = { result: { value: true } };
  if (message.method === "Page.captureScreenshot") result = { data: png };
  if (message.method === "session.new") result = { sessionId: "session", capabilities: { browserVersion: "fixture" } };
  if (message.method === "browsingContext.getTree") result = { contexts: [{ context: "context" }] };
  if (message.method === "script.evaluate") result = { type: "success", result: { type: "string", value: JSON.stringify(message.params.expression.includes("navigator.userAgent") ? "Firefox/fixture" : true) } };
  if (message.method === "browsingContext.captureScreenshot") result = { data: png };
  reply({ id: message.id, ...(chromeProfile ? { result } : { type: "success", result }) });
  if (message.method === "Runtime.enable") reply({ method: "Runtime.consoleAPICalled", sessionId: "session", params: { type: "error", args: [{ value: "api_key=hidden https://name:pass@fixture.invalid/path?token=hidden /Users/private/file" }] } });
  if (message.method === "Fetch.enable") reply({ method: "Fetch.requestPaused", sessionId: "session", params: { requestId: "paused", resourceType: "Document", request: { url: "https://fixture.invalid/page", headers: { Accept: "text/html" } } } });
}

if (chromeProfile) {
  const input = process.stdin;
  // Inherited CDP pipes are fds3/4, as in the real Chrome adapter.
  // Event-loop pipes avoid blocking filesystem workers during process.exit().
  const pipeIn = new Socket({ fd: 3, readable: true, writable: false });
  const pipeOut = new Socket({ fd: 4, readable: false, writable: true });
  let buffer = "";
  pipeIn.on("data", bytes => {
    buffer += bytes.toString();
    let split;
    while ((split = buffer.indexOf("\0")) >= 0) {
      const frame = buffer.slice(0, split); buffer = buffer.slice(split + 1);
      command(JSON.parse(frame), value => pipeOut.write((typeof value === "string" ? value : JSON.stringify(value)) + "\0"));
    }
  });
  input.resume();
} else if (config.mode === "no-address") {
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((_request, response) => { response.writeHead(400); response.end(); });
  server.on("upgrade", (request, socket) => {
    record("websocket-upgrade");
    if (config.mode === "socket-error") { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    const reply = value => {
      const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      let head;
      if (bytes.length < 126) head = Buffer.from([0x81, bytes.length]);
      else if (bytes.length <= 65535) head = Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(bytes.length), 2); }
      socket.write(Buffer.concat([head, bytes]));
    };
    let buffered = Buffer.alloc(0);
    socket.on("data", bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        if (length === 127) throw new Error("Fixture only expects small frames");
        const masked = Boolean(buffered[1] & 128);
        const maskLength = masked ? 4 : 0;
        if (buffered.length < offset + maskLength + length) return;
        const mask = buffered.subarray(offset, offset + maskLength);
        const payload = Buffer.from(buffered.subarray(offset + maskLength, offset + maskLength + length));
        if (masked) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        buffered = buffered.subarray(offset + maskLength + length);
        if (opcode === 8) { socket.end(); continue; }
        if (opcode === 1) command(JSON.parse(payload.toString()), reply);
      }
    });
    socket.on("error", () => {});
  });
  server.listen(0, "127.0.0.1", () => process.stderr.write("WebDriver BiDi listening on ws://127.0.0.1:" + server.address().port + "\n"));
}
