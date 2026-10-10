import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bounded, observeProcess, resolveTimeouts, shutdownProcess, validateTimeout } from "./lifecycle.mjs";
import { sanitizeText } from "./evidence.mjs";

/** Preserve original quiet profile preferences, never mutate an existing person's profile. */
const QUIET = {
  "app.update.disabledForTesting": true, "browser.aboutwelcome.enabled": false,
  "browser.shell.checkDefaultBrowser": false, "browser.startup.homepage_override.mstone": "ignore",
  "datareporting.healthreport.uploadEnabled": false, "datareporting.policy.dataSubmissionEnabled": false,
  "extensions.update.enabled": false, "network.captive-portal-service.enabled": false,
  "network.connectivity-service.enabled": false, "toolkit.telemetry.server": "", "toolkit.telemetry.unified": false,
};

/** Original WebDriver BiDi adapter with cleanup covering address/socket/session failures. */
export async function openHeadlessFirefox(profileDirectory, explicitBinary = process.env.FIREFOX_BIN, prefs = {}, options = {}) {
  const timeouts = resolveTimeouts(options.timeouts);
  if (typeof profileDirectory !== "string" || !profileDirectory) throw new Error("An isolated Firefox profile directory is required");
  if (typeof explicitBinary !== "string" || !explicitBinary) throw new Error("No Firefox binary selected; inject binary or FIREFOX_BIN");
  await access(explicitBinary);
  await mkdir(profileDirectory, { recursive: true });
  const temporaryDirectory = path.join(profileDirectory, "tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, "user.js"), Object.entries({ ...QUIET, ...prefs })
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`).join(""));
  const child = spawn(explicitBinary, ["--headless", "--no-remote", "--profile", profileDirectory, "--remote-debugging-port", "0", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1", TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
  });
  const record = value => { try { options.onLifecycle?.(value); } catch { /* Evidence callbacks cannot break process cleanup. */ } };
  const state = observeProcess(child, "Firefox", record);
  let stderr = "", socket, usableSession = false, nextId = 1, closing;
  const pending = new Map();
  const listeners = new Set();
  const rejectAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on("error", error => rejectAll(new Error("Firefox process error: " + sanitizeText(error.message))));
  state.exitPromise.then(({ code }) => rejectAll(new Error("Headless Firefox exited (" + code + "): " + sanitizeText(stderr))));
  const send = (method, params = {}, timeoutMs = timeouts.commandMs) => new Promise((resolve, reject) => {
    validateTimeout(timeoutMs);
    if (state.exited || socket?.readyState !== WebSocket.OPEN) { reject(new Error("Headless Firefox is closed")); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out waiting for Firefox " + method)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(new Error("Firefox transport error: " + sanitizeText(error.message))); }
  });
  const close = () => {
    closing ??= shutdownProcess(child, state, usableSession ? () => send("browser.close", {}, timeouts.closeMs) : null, timeouts, record)
      .finally(() => { socket?.close(); listeners.clear(); rejectAll(new Error("Headless Firefox is closed")); });
    return closing;
  };
  const startupDeadline = Date.now() + timeouts.startupMs;
  const remaining = () => Math.max(1, startupDeadline - Date.now());
  try {
    const address = await bounded(new Promise((resolve, reject) => {
      const data = bytes => {
        stderr = (stderr + bytes).slice(-16000);
        const found = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(stderr);
        if (found) resolve(found[1]);
      };
      child.stderr.on("data", data);
      child.once("error", error => reject(new Error("Firefox startup error: " + sanitizeText(error.message))));
      state.exitPromise.then(({ code }) => reject(new Error("Headless Firefox exited (" + code + "): " + sanitizeText(stderr))));
    }), remaining(), "Firefox did not open WebDriver BiDi before startup deadline");
    const endpoint = new URL(address);
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Firefox BiDi endpoint must be loopback");
    socket = new WebSocket(address + "/session");
    await bounded(new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Could not connect to Firefox WebDriver BiDi")), { once: true });
      socket.addEventListener("close", () => reject(new Error("Firefox WebDriver BiDi closed before session")), { once: true });
    }), remaining(), "Firefox BiDi socket startup timed out");
    socket.addEventListener("close", () => rejectAll(new Error("Firefox BiDi transport closed")));
    socket.addEventListener("error", () => rejectAll(new Error("Firefox BiDi transport failed")));
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string" || event.data.length > 8 * 1024 * 1024) { rejectAll(new Error("Firefox protocol frame exceeded its 8 MiB text bound")); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { rejectAll(new Error("Malformed Firefox protocol frame")); return; }
      if (message === null || typeof message !== "object" || Array.isArray(message)) { rejectAll(new Error("Invalid Firefox protocol envelope")); return; }
      if (message.type === "event") {
        for (const listener of listeners) { try { listener(message); } catch { record({ event: "event-listener-error" }); } }
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.type === "error") item.reject(new Error(sanitizeText(`${message.error}: ${message.message}`)));
      else item.resolve(message.result);
    });
    const session = await send("session.new", { capabilities: {} }, remaining());
    usableSession = true;
    return {
      pid: child.pid, session,
      send,
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async context() { const tree = await send("browsingContext.getTree", {}); return tree.contexts[0].context; },
      async evaluate(context, expression, timeoutMs = timeouts.commandMs) {
        const answer = await send("script.evaluate", { expression: `Promise.resolve((0, eval)(${JSON.stringify(expression)})).then(value => JSON.stringify(value) ?? "null")`, target: { context }, awaitPromise: true }, timeoutMs);
        if (answer.type !== "success") throw new Error("Firefox evaluation failed: " + sanitizeText(answer.exceptionDetails?.text ?? JSON.stringify(answer)));
        return JSON.parse(answer.result.value);
      },
      waitForExit: timeoutMs => state.waitForExit(timeoutMs), close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Firefox startup and cleanup failed"); }
    throw error;
  }
}
