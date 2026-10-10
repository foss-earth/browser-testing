import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { observeProcess, resolveTimeouts, shutdownProcess, validateTimeout } from "./lifecycle.mjs";
import { sanitizeText } from "./evidence.mjs";

/** Original inherited-pipe CDP adapter. Paths are caller-selected; importing does not launch. */
export async function openHeadlessChrome(profileDirectory, explicitBinary = process.env.CHROME_BIN, extraArgs = [], options = {}) {
  const timeouts = resolveTimeouts(options.timeouts);
  if (typeof profileDirectory !== "string" || !profileDirectory) throw new Error("An isolated Chrome profile directory is required");
  if (typeof explicitBinary !== "string" || !explicitBinary) throw new Error("No Chrome binary selected; inject binary or CHROME_BIN");
  if (!Array.isArray(extraArgs) || extraArgs.some(value => typeof value !== "string")) throw new Error("Chrome args must be strings");
  if (extraArgs.some(value => /^--(?:user-data-dir|profile-directory|remote-debugging-pipe|remote-debugging-port)(?:=|$)/.test(value))) throw new Error("Chrome extra args cannot replace the owned profile or protocol transport");
  await access(explicitBinary);
  await mkdir(profileDirectory, { recursive: true });
  const temporaryDirectory = path.join(profileDirectory, "tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  const child = spawn(explicitBinary, [
    "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-extensions",
    "--disable-sync", "--mute-audio", "--user-data-dir=" + profileDirectory, ...extraArgs, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory } });
  const record = value => { try { options.onLifecycle?.(value); } catch { /* Evidence callbacks cannot break process cleanup. */ } };
  const state = observeProcess(child, "Chrome", record);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1, buffer = "", stderr = "", closing;
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-16000); });
  const rejectAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on("error", error => rejectAll(new Error("Chrome process error: " + sanitizeText(error.message))));
  state.exitPromise.then(({ code }) => rejectAll(new Error("Headless Chrome exited (" + code + "): " + sanitizeText(stderr))));
  child.stdio[4].on("data", bytes => {
    buffer += bytes.toString();
    if (buffer.length > 8 * 1024 * 1024) { rejectAll(new Error("Chrome protocol frame exceeded 8 MiB")); buffer = ""; return; }
    let separator;
    while ((separator = buffer.indexOf("\0")) >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 1);
      if (!frame) continue;
      let message;
      try { message = JSON.parse(frame); } catch { rejectAll(new Error("Malformed Chrome protocol frame")); continue; }
      if (message === null || typeof message !== "object" || Array.isArray(message)) { rejectAll(new Error("Invalid Chrome protocol envelope")); continue; }
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(new Error(sanitizeText(message.error.message)));
        else item.resolve(message.result);
      } else for (const listener of listeners) {
        try { listener(message); } catch { record({ event: "event-listener-error" }); }
      }
    }
  });
  const send = (method, params = {}, sessionId, timeoutMs = timeouts.commandMs) => new Promise((resolve, reject) => {
    validateTimeout(timeoutMs);
    if (state.exited) { reject(new Error("Headless Chrome is closed")); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for Chrome " + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const fail = error => { const item = pending.get(id); if (!item) return; pending.delete(id); clearTimeout(timer); reject(new Error("Chrome transport error: " + sanitizeText(error.message))); };
    try { child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0", error => { if (error) fail(error); }); }
    catch (error) { fail(error); }
  });
  child.stdio[3].on("error", error => rejectAll(new Error("Chrome transport error: " + sanitizeText(error.message))));
  child.stdio[4].on("error", error => rejectAll(new Error("Chrome transport error: " + sanitizeText(error.message))));
  const close = () => {
    closing ??= shutdownProcess(child, state, () => send("Browser.close", {}, undefined, timeouts.closeMs), timeouts, record)
      .finally(() => { listeners.clear(); rejectAll(new Error("Headless Chrome is closed")); });
    return closing;
  };
  let version;
  try { version = await send("Browser.getVersion", {}, undefined, timeouts.startupMs); }
  catch (error) {
    // Pre-session startup failures still await bounded owned-process cleanup.
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Chrome startup and cleanup failed"); }
    throw error;
  }
  return {
    pid: child.pid, version,
    send,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // 0SFS extension: observation alone never sends a signal.
    waitForExit: timeoutMs => state.waitForExit(timeoutMs),
    close,
  };
}

export async function evaluate(chrome, sessionId, expression) {
  const result = await chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(sanitizeText(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result.value;
}

export async function waitForExpression(chrome, sessionId, expression, timeoutMs = 10000) {
  validateTimeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, Math.max(1, deadline - Date.now()));
    if (result.exceptionDetails) throw new Error(sanitizeText(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    if (result.result.value) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
  throw new Error("Headless condition did not become true: " + sanitizeText(expression));
}
