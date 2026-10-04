import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** What a check's Firefox does not do by itself: no updates, first-run pages, telemetry or checks of the network. */
const QUIET = {
  "app.update.disabledForTesting": true,
  "browser.aboutwelcome.enabled": false,
  "browser.shell.checkDefaultBrowser": false,
  "browser.startup.homepage_override.mstone": "ignore",
  "datareporting.healthreport.uploadEnabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "extensions.update.enabled": false,
  "network.captive-portal-service.enabled": false,
  "network.connectivity-service.enabled": false,
  "toolkit.telemetry.server": "",
  "toolkit.telemetry.unified": false,
};

/**
 * Bounded headless Firefox control over WebDriver BiDi, on a loopback WebSocket
 * Firefox opens on a port of its own choosing; headlessChrome.mjs's counterpart.
 * `prefs` are written to the profile's user.js, such as `webgl.enable-webgl2: false`
 * for a WebGL 1 context. The profile is the caller's folder, never the person's own.
 */
export async function openHeadlessFirefox(profileDirectory, explicitBinary = process.env.FIREFOX_BIN, prefs = {}) {
  const candidates = explicitBinary ? [explicitBinary] : [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/usr/bin/firefox",
  ];
  let executable;
  for (const candidate of candidates) {
    try { await access(candidate); executable = candidate; break; } catch { /* Try the next installed binary. */ }
  }
  if (!executable) throw new Error("No installed Firefox found; set FIREFOX_BIN to an existing executable.");
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, "user.js"), Object.entries({ ...QUIET, ...prefs })
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`).join(""));
  const child = spawn(executable, ["--headless", "--no-remote", "--profile", profileDirectory, "--remote-debugging-port", "0", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, MOZ_CRASHREPORTER_DISABLE: "1" },
  });
  let stderr = "", closed = false;
  const exited = new Promise(resolve => child.on("exit", code => { closed = true; resolve(code); }));
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Firefox did not open WebDriver BiDi in 30 s: " + stderr)), 30000);
    child.stderr.on("data", bytes => {
      stderr = (stderr + bytes).slice(-16000);
      const found = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    exited.then(code => { clearTimeout(timer); reject(new Error("Headless Firefox exited (" + code + "): " + stderr)); });
  });
  const socket = new WebSocket(address + "/session");
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  const rejectAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  exited.then(code => rejectAll(new Error("Headless Firefox exited (" + code + "): " + stderr)));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Firefox's WebDriver BiDi at " + address)), { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.type === "event") { for (const listener of listeners) listener(message); return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.type === "error") item.reject(new Error(`${message.error}: ${message.message}`));
    else item.resolve(message.result);
  });
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Headless Firefox is closed")); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for Firefox " + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("session.new", { capabilities: {} });
  return {
    send,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** The one tab Firefox opened. */
    async context() {
      const tree = await send("browsingContext.getTree", {});
      return tree.contexts[0].context;
    },
    /** Runs statements in the tab as Chrome's Runtime.evaluate does, awaiting a promise, and returns the last one's value where it is JSON. */
    async evaluate(context, expression, timeoutMs = 30000) {
      const answer = await send("script.evaluate", { expression: `Promise.resolve((0, eval)(${JSON.stringify(expression)})).then(value => JSON.stringify(value) ?? "null")`, target: { context }, awaitPromise: true }, timeoutMs);
      if (answer.type !== "success") throw new Error("Firefox evaluation failed: " + (answer.exceptionDetails?.text ?? JSON.stringify(answer)));
      return JSON.parse(answer.result.value);
    },
    /** Asks Firefox to quit and waits for it; no signal is sent. */
    async close() {
      if (!closed) await send("browser.close", {}).catch(() => {});
      await exited;
    },
  };
}
