import { createRequire } from "node:module";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { evaluate, openHeadlessChrome } from "./headlessChrome.mjs";
import { openHeadlessFirefox } from "./headlessFirefox.mjs";
import { bounded, connectOwnedBrowserServer, resolveTimeouts } from "./lifecycle.mjs";
import { createEvidence, sanitizeText } from "./evidence.mjs";

const CHECK_NAME = "foss-earth-browser-testing/0.1";

// A finite control vocabulary; text entry and arbitrary protocol input remain outside this port.
const CONTROL_KEYS = Object.freeze({
  Tab: { key: "Tab", code: "Tab", virtualKey: 9, bidi: "\uE004" },
  ShiftTab: { key: "Tab", code: "Tab", virtualKey: 9, bidi: "\uE004", shift: true },
  Enter: { key: "Enter", code: "Enter", virtualKey: 13, bidi: "\uE006", text: "\r" },
  Space: { key: " ", code: "Space", virtualKey: 32, bidi: " ", text: " " },
  Escape: { key: "Escape", code: "Escape", virtualKey: 27, bidi: "\uE00C" },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", virtualKey: 37, bidi: "\uE012" },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", virtualKey: 38, bidi: "\uE013" },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", virtualKey: 39, bidi: "\uE014" },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", virtualKey: 40, bidi: "\uE015" },
  Home: { key: "Home", code: "Home", virtualKey: 36, bidi: "\uE011" },
  End: { key: "End", code: "End", virtualKey: 35, bidi: "\uE010" },
  PageUp: { key: "PageUp", code: "PageUp", virtualKey: 33, bidi: "\uE00E" },
  PageDown: { key: "PageDown", code: "PageDown", virtualKey: 34, bidi: "\uE00F" },
});

function inputQueue(evidence) {
  let pending = Promise.resolve();
  return (kind, control, dispatch) => {
    const next = pending.then(dispatch).catch(error => {
      evidence.add("lifecycle", { event: `${kind}-error` });
      evidence.add("console", { level: "error", text: `Native ${kind} ${control} failed: ${error.message}` });
      throw error;
    });
    pending = next.catch(() => {});
    return next;
  };
}

function queuedKeyPress(dispatch, enqueue) {
  return key => typeof key !== "string" || !Object.hasOwn(CONTROL_KEYS, key)
    ? Promise.reject(new Error("Unsupported control key"))
    : enqueue("keyboard", key, () => dispatch(CONTROL_KEYS[key]));
}

function pointerPorts(width, height, enqueue, click, drag) {
  function point(x, y) {
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= width || y < 0 || y >= height) throw new Error("Finite pointer coordinates within the page viewport required");
    return { x: Math.min(width - 1, Math.round(x)), y: Math.min(height - 1, Math.round(y)) };
  }
  return {
    async clickAt(x, y) {
      const position = point(x, y);
      return enqueue("pointer", "click", () => click(position));
    },
    async dragAt(fromX, fromY, toX, toY, options = {}) {
      const from = point(fromX, fromY), to = point(toX, toY);
      if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["steps", "durationMs"].includes(key))) throw new Error("Only bounded pointer steps and duration are accepted");
      const { steps = 5, durationMs = 250 } = options;
      if (!Number.isSafeInteger(steps) || steps < 1 || steps > 20 || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 1000) throw new Error("Pointer drag requires 1..20 steps and 0..1000 integer milliseconds");
      const moves = Array.from({ length: steps }, (_, index) => ({ x: Math.round(from.x + (to.x - from.x) * (index + 1) / steps),
        y: Math.round(from.y + (to.y - from.y) * (index + 1) / steps), durationMs: Math.round(durationMs * (index + 1) / steps) - Math.round(durationMs * index / steps) }));
      return enqueue("pointer", "drag", () => drag(from, to, moves));
    },
  };
}

/** A screenshot's optional crop, in CSS pixels of the viewport, and its pixel scale, which only Chrome can change. */
function screenshotClip(options, scalable) {
  if (options === undefined) return null;
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["clip", "scale"].includes(key))) throw new Error("Screenshot options are clip and scale");
  const { clip, scale = 1 } = options;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.25 || scale > 4) throw new Error("Screenshot scale must be 0.25..4");
  if (scale !== 1 && !scalable) throw new Error("Only Chrome screenshots can change scale");
  if (clip === undefined) return scale === 1 ? null : { scale };
  const box = clip && typeof clip === "object" ? clip : {};
  const fields = ["x", "y", "width", "height"].map(key => box[key]);
  if (fields.some(value => typeof value !== "number" || !Number.isFinite(value)) || box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1 || box.width > 8192 || box.height > 8192) throw new Error("Screenshot clip needs finite x, y >= 0 and width, height 1..8192");
  return { clip: { x: box.x, y: box.y, width: box.width, height: box.height }, scale };
}

const pointerPause = duration => duration ? new Promise(resolve => setTimeout(resolve, duration)) : Promise.resolve();

async function withKeyRelease(down, up) {
  let failure;
  try { await down(); } catch (error) { failure = error; }
  try { await up(); } catch (error) {
    if (failure) throw new AggregateError([failure, error], "Native key dispatch and release failed");
    throw error;
  }
  if (failure) throw failure;
}

/** Preserve the original page protocol API; explicit live mode does not intercept requests. */
export async function openHeadlessPage(browser, profileDirectory, options) {
  if (!options || typeof options !== "object") throw new Error("Page options are required");
  const mode = options.mode ?? (typeof options.respond === "function" ? "interception" : undefined);
  if (!["interception", "live"].includes(mode)) throw new Error("Select page mode: interception or live");
  if (mode === "interception" && typeof options.respond !== "function") throw new Error("Interception mode requires respond");
  if (mode === "live" && options.respond != null) throw new Error("Live mode does not accept respond");
  if (!["chrome", "firefox", "webkit"].includes(browser)) throw new Error(`No headless page for "${browser}": chrome, firefox or webkit`);
  if (!Number.isSafeInteger(options.width) || !Number.isSafeInteger(options.height) || options.width < 1 || options.height < 1 || options.width > 8192 || options.height > 8192) throw new Error("Finite bounded page width/height required");
  if (typeof profileDirectory !== "string" || !profileDirectory) throw new Error("An isolated page profile directory is required");
  if (mode === "interception" && options.workers && browser !== "chrome") throw new Error("Worker request interception is supported only by Chrome; select live mode for Firefox/WebKit worker behavior");
  const common = { ...options, mode, timeouts: resolveTimeouts(options.timeouts), evidence: createEvidence(options.evidenceLimits) };
  if (browser === "chrome") return chromePage(profileDirectory, common);
  if (browser === "firefox") return firefoxPage(profileDirectory, common);
  return webkitPage(profileDirectory, common);
}

async function chromePage(profileDirectory, { respond, mode, width, height, binary, chromeArgs = [], workers = false, timeouts, evidence }) {
  const chrome = await openHeadlessChrome(profileDirectory, binary, chromeArgs, { timeouts, onLifecycle: value => evidence.add("lifecycle", value) });
  try {
    const version = chrome.version;
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params = {}) => chrome.send(method, params, sessionId);
    const intercept = workers ? (method, params) => chrome.send(method, params) : send;
    const requestUrls = new Map();
    chrome.onEvent(message => {
      if (message.sessionId === sessionId) {
        const data = message.params ?? {};
        if (message.method === "Runtime.consoleAPICalled") evidence.add("console", { level: data.type, text: (data.args ?? []).map(arg => arg.value ?? arg.description ?? "").join(" ") });
        if (message.method === "Runtime.exceptionThrown") evidence.add("console", { level: "error", text: data.exceptionDetails?.exception?.description ?? data.exceptionDetails?.text ?? "Browser exception" });
        if (message.method === "Network.requestWillBeSent") {
          if (requestUrls.size >= 1000) requestUrls.delete(requestUrls.keys().next().value);
          requestUrls.set(data.requestId, data.request.url);
          evidence.add("network", { phase: "request", url: data.request.url, method: data.request.method });
        }
        if (message.method === "Network.responseReceived") evidence.add("network", { phase: "response", url: data.response.url, status: data.response.status });
        if (message.method === "Network.loadingFailed") { evidence.add("network", { phase: "failure", url: requestUrls.get(data.requestId), error: data.errorText }); requestUrls.delete(data.requestId); }
        if (message.method === "Network.loadingFinished") requestUrls.delete(data.requestId);
      }
      if (mode !== "interception" || message.method !== "Fetch.requestPaused" || (workers ? Boolean(message.sessionId) : message.sessionId !== sessionId)) return;
      void (async () => {
        const { requestId, request, resourceType } = message.params;
        const accepts = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "accept")?.[1] ?? "";
        let answer;
        try { answer = await bounded(Promise.resolve(respond(new URL(request.url), { navigation: resourceType === "Document" || accepts.includes("text/html") })), timeouts.commandMs, "Request responder timed out"); }
        catch (error) { evidence.add("network", { phase: "responder-error", url: request.url, error: error.message }); }
        if (!answer) { await intercept("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); return; }
        await intercept("Fetch.fulfillRequest", { requestId, responseCode: answer.status, responseHeaders: Object.entries(answer.headers ?? {}).map(([name, value]) => ({ name, value })), body: Buffer.from(answer.body ?? "").toString("base64") });
      })().catch(error => evidence.add("network", { phase: "interception-error", url: message.params?.request?.url, error: error.message }));
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");
    if (mode === "interception") await intercept("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await send("Emulation.setUserAgentOverride", { userAgent: `${version.userAgent} ${CHECK_NAME}` });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const facts = { browser: "chrome", mode, workers, pid: chrome.pid, engineVersion: sanitizeText(version.product, 200) };
    const enqueue = inputQueue(evidence);
    const pressKey = queuedKeyPress(async spec => {
      const modifiers = spec.shift ? 8 : 0;
      const key = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.virtualKey, modifiers };
      const main = () => withKeyRelease(
        () => send("Input.dispatchKeyEvent", { type: spec.text == null ? "rawKeyDown" : "keyDown", ...key,
          ...(spec.text == null ? {} : { text: spec.text, unmodifiedText: spec.text }) }),
        () => send("Input.dispatchKeyEvent", { type: "keyUp", ...key }));
      if (!spec.shift) return main();
      const shift = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
      await withKeyRelease(async () => { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shift, modifiers: 8 }); await main(); },
        () => send("Input.dispatchKeyEvent", { type: "keyUp", ...shift, modifiers: 0 }));
    }, enqueue);
    const pointer = pointerPorts(width, height, enqueue,
      position => withKeyRelease(async () => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...position, buttons: 0 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", buttons: 1, clickCount: 1 });
      }, () => send("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", buttons: 0, clickCount: 1 })),
      (from, to, moves) => withKeyRelease(async () => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from, buttons: 0 });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
        for (const { durationMs, ...position } of moves) {
          await pointerPause(durationMs);
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...position, button: "left", buttons: 1 });
        }
      }, () => send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 })));
    let closed;
    return {
      product: version.product, facts, pressKey, ...pointer,
      navigate: url => send("Page.navigate", { url: String(url) }),
      evaluate: expression => evaluate(chrome, sessionId, expression),
      async screenshot(options) {
        const crop = screenshotClip(options, true);
        // A scale without a crop takes the whole viewport at that scale. Chrome crops in page coordinates, so the scroll is added.
        let clip = null;
        if (crop) {
          const box = crop.clip ?? { x: 0, y: 0, width, height };
          const { cssVisualViewport: view } = await send("Page.getLayoutMetrics");
          clip = { ...box, x: box.x + (view?.pageX ?? 0), y: box.y + (view?.pageY ?? 0), scale: crop.scale };
        }
        return Buffer.from((await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) })).data, "base64");
      },
      async touch() {
        const shift = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...shift });
        await send("Input.dispatchKeyEvent", { type: "keyUp", ...shift });
      },
      close() {
        // Browser.close owns target cleanup and has the inherited graceful exit contract.
        closed ??= chrome.close();
        return closed;
      },
      captureEvidence: () => evidence.snapshot(version.product, facts),
    };
  } catch (error) {
    try { await chrome.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Chrome page setup and cleanup failed"); }
    throw error;
  }
}

async function firefoxPage(profileDirectory, { respond, mode, width, height, binary, firefoxPrefs = {}, workers = false, timeouts, evidence }) {
  const firefox = await openHeadlessFirefox(profileDirectory, binary, firefoxPrefs, { timeouts, onLifecycle: value => evidence.add("lifecycle", value) });
  try {
    const startupContext = await firefox.context();
    // A real foreground tab establishes native content focus; the startup tab can remain unfocused.
    const created = await firefox.send("browsingContext.create", { type: "tab", background: false, referenceContext: startupContext });
    const context = created?.context;
    if (typeof context !== "string" || !context || context === startupContext) throw new Error("Firefox foreground context creation returned an invalid owned context");
    // Keep the returned context for all setup, navigation and native input; tree order is not ownership.
    await firefox.send("browsingContext.activate", { context });
    const userAgent = await firefox.evaluate(context, "navigator.userAgent");
    firefox.onEvent(message => {
      const data = message.params ?? {};
      if (message.method === "log.entryAdded") evidence.add("console", { level: data.level, text: data.text ?? (data.args ?? []).map(value => value.value ?? "").join(" ") });
      if (message.method === "network.beforeRequestSent") evidence.add("network", { phase: "request", url: data.request?.url, method: data.request?.method });
      if (message.method === "network.responseCompleted") evidence.add("network", { phase: "response", url: data.response?.url ?? data.request?.url, status: data.response?.status });
      if (message.method === "network.fetchError") evidence.add("network", { phase: "failure", url: data.request?.url, error: data.errorText });
      if (mode !== "interception" || message.method !== "network.beforeRequestSent" || !data.isBlocked) return;
      void (async () => {
        const request = data.request.request;
        const { destination } = data.request;
        let answer;
        try { answer = await bounded(Promise.resolve(respond(new URL(data.request.url), { navigation: destination ? destination === "document" : data.navigation != null })), timeouts.commandMs, "Request responder timed out"); }
        catch (error) { evidence.add("network", { phase: "responder-error", url: data.request.url, error: error.message }); }
        if (!answer) { await firefox.send("network.failRequest", { request }); return; }
        await firefox.send("network.provideResponse", {
          request, statusCode: answer.status, reasonPhrase: answer.status === 200 ? "OK" : "Not Found",
          headers: Object.entries(answer.headers ?? {}).map(([name, value]) => ({ name, value: { type: "string", value } })),
          body: { type: "base64", value: Buffer.from(answer.body ?? "").toString("base64") },
        });
      })().catch(error => evidence.add("network", { phase: "interception-error", url: data.request?.url, error: error.message }));
    });
    await firefox.send("session.subscribe", { events: ["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted", "network.fetchError"] });
    if (mode === "interception") await firefox.send("network.addIntercept", { phases: ["beforeRequestSent"] });
    await firefox.send("emulation.setUserAgentOverride", { userAgent: `${userAgent} ${CHECK_NAME}`, contexts: [context] });
    await firefox.send("browsingContext.setViewport", { context, viewport: { width, height }, devicePixelRatio: 1 });
    const product = /Firefox\/[\d.]+/.exec(userAgent)?.[0] ?? "Firefox";
    const facts = { browser: "firefox", mode, workers, pid: firefox.pid, engineVersion: sanitizeText(firefox.session?.capabilities?.browserVersion ?? product, 200) };
    const enqueue = inputQueue(evidence);
    const pressKey = queuedKeyPress(spec => withKeyRelease(
      () => firefox.send("input.performActions", { context, actions: [{ type: "key", id: "keyboard", actions: [
        ...(spec.shift ? [{ type: "keyDown", value: "\uE008" }] : []),
        { type: "keyDown", value: spec.bidi }, { type: "keyUp", value: spec.bidi },
        ...(spec.shift ? [{ type: "keyUp", value: "\uE008" }] : []),
      ] }] }),
      () => firefox.send("input.releaseActions", { context })), enqueue);
    const pointerActions = actions => withKeyRelease(
      () => firefox.send("input.performActions", { context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] }),
      () => firefox.send("input.releaseActions", { context }));
    const move = (position, duration = 0) => ({ type: "pointerMove", origin: "viewport", x: position.x, y: position.y, duration });
    const pointer = pointerPorts(width, height, enqueue,
      position => pointerActions([move(position), { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]),
      (from, _to, moves) => pointerActions([move(from), { type: "pointerDown", button: 0 }, ...moves.map(position => move(position, position.durationMs)), { type: "pointerUp", button: 0 }]));
    return {
      product, facts, pressKey, ...pointer,
      navigate: url => firefox.send("browsingContext.navigate", { context, url: String(url), wait: "none" }),
      evaluate: expression => firefox.evaluate(context, expression),
      async screenshot(options) {
        const clip = screenshotClip(options, false)?.clip;
        return Buffer.from((await firefox.send("browsingContext.captureScreenshot", { context, origin: "viewport", ...(clip ? { clip: { type: "box", ...clip } } : {}) })).data, "base64");
      },
      touch: () => firefox.send("input.performActions", { context, actions: [{ type: "key", id: "keyboard", actions: [{ type: "keyDown", value: "\uE008" }, { type: "keyUp", value: "\uE008" }] }] }),
      close: () => firefox.close(), captureEvidence: () => evidence.snapshot(product, facts),
    };
  } catch (error) {
    try { await firefox.close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Firefox page setup and cleanup failed"); }
    throw error;
  }
}

/** Exact optional injected Playwright, loaded only when WebKit is explicitly selected. */
async function loadWebkit(tool) {
  if (!tool || typeof tool.packageRoot !== "string" || !tool.packageRoot || typeof tool.browserCachePath !== "string" || !tool.browserCachePath) throw new Error("WebKit requires explicit Playwright packageRoot and browserCachePath");
  if (tool.expectedVersion !== "1.55.0" || tool.expectedCoreVersion !== "1.55.0" || String(tool.expectedWebkitRevision) !== "2203") throw new Error("Reviewed WebKit tool contract is Playwright1.55.0/core1.55.0/WebKit2203");
  const requireTool = createRequire(path.join(path.resolve(tool.packageRoot), "package.json"));
  const playwrightPath = requireTool.resolve("playwright/package.json");
  const corePath = requireTool.resolve("playwright-core/package.json");
  const playwrightPackage = JSON.parse(await readFile(playwrightPath, "utf8"));
  const corePackage = JSON.parse(await readFile(corePath, "utf8"));
  const browsers = JSON.parse(await readFile(path.join(path.dirname(corePath), "browsers.json"), "utf8"));
  const webkitEntry = browsers.browsers.find(value => value.name === "webkit");
  if (playwrightPackage.version !== tool.expectedVersion || corePackage.version !== tool.expectedCoreVersion || String(webkitEntry?.revision) !== String(tool.expectedWebkitRevision)) throw new Error("Injected Playwright/core/WebKit tool versions do not match reviewed contract");
  // Cache selection is explicit. A caller selecting a different cache must use a new Node process;
  // Playwright reads this variable when loaded and cannot safely share concurrent cache roots.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH != null && path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH) !== path.resolve(tool.browserCachePath)) throw new Error("Existing Playwright browser cache differs from explicit selection");
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(tool.browserCachePath);
  const { webkit } = requireTool("playwright");
  const executable = webkit.executablePath();
  const relativeExecutable = path.relative(path.resolve(tool.browserCachePath), executable);
  if (relativeExecutable.split(path.sep)[0] !== `webkit-${tool.expectedWebkitRevision}`) throw new Error("Selected WebKit executable does not belong to the reviewed revision/cache; platform revision overrides are not approved implicitly");
  await access(executable); // Missing tools fail; no download or backend fallback.
  return { webkit, toolVersions: { playwright: playwrightPackage.version, playwrightCore: corePackage.version }, webkitRevision: String(webkitEntry.revision) };
}

/** WebKit engine qualification is not mobile Safari or WebGPU qualification. */
async function webkitPage(profileDirectory, { respond, mode, width, height, workers = false, timeouts, evidence, playwright, proxy }) {
  const tool = await loadWebkit(playwright);
  const temporaryDirectory = path.join(profileDirectory, "tmp");
  await mkdir(temporaryDirectory, { recursive: true });
  const server = await tool.webkit.launchServer({ host: "127.0.0.1", port: 0, headless: true, timeout: timeouts.startupMs,
    env: { ...process.env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
    downloadsPath: path.join(profileDirectory, "downloads"), tracesDir: path.join(profileDirectory, "traces"),
    ...(mode === "interception" ? { proxy: { server: "http://127.0.0.1:9" } } : proxy ? { proxy } : {}) });
  const owned = await connectOwnedBrowserServer(server, endpoint => tool.webkit.connect(endpoint, { timeout: timeouts.startupMs }), timeouts,
    value => evidence.add("lifecycle", value));
  const { instance, close } = owned;
  try {
    const probe = await bounded(instance.newPage(), timeouts.commandMs, "WebKit probe page setup timed out");
    const userAgent = await bounded(probe.evaluate(() => navigator.userAgent), timeouts.commandMs, "WebKit user-agent probe timed out");
    await bounded(probe.close(), timeouts.commandMs, "WebKit probe close timed out");
    // The isolated context does not persist a person's profile. profileDirectory remains a caller-owned evidence identity.
    const context = await bounded(instance.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      userAgent: `${userAgent} ${CHECK_NAME}`, serviceWorkers: mode === "live" && workers ? "allow" : "block" }), timeouts.commandMs, "WebKit context setup timed out");
    const page = await bounded(context.newPage(), timeouts.commandMs, "WebKit page setup timed out");
    page.on("console", message => evidence.add("console", { level: message.type(), text: message.text() }));
    page.on("pageerror", error => evidence.add("console", { level: "error", text: error.message }));
    page.on("request", request => evidence.add("network", { phase: "request", url: request.url(), method: request.method() }));
    page.on("response", response => evidence.add("network", { phase: "response", url: response.url(), status: response.status() }));
    page.on("requestfailed", request => evidence.add("network", { phase: "failure", url: request.url(), error: request.failure()?.errorText }));
    if (mode === "interception") await bounded(page.route("**/*", async route => {
      let answer;
      try { answer = await bounded(Promise.resolve(respond(new URL(route.request().url()), { navigation: route.request().isNavigationRequest() })), timeouts.commandMs, "Request responder timed out"); }
      catch (error) { evidence.add("network", { phase: "responder-error", url: route.request().url(), error: error.message }); }
      if (!answer) { await bounded(route.abort("blockedbyclient"), timeouts.commandMs, "WebKit request abort timed out").catch(() => {}); return; }
      await bounded(route.fulfill({ status: answer.status, headers: answer.headers ?? {}, body: Buffer.from(answer.body ?? "") }), timeouts.commandMs, "WebKit response fulfillment timed out")
        .catch(error => evidence.add("network", { phase: "interception-error", url: route.request().url(), error: error.message }));
    }), timeouts.commandMs, "WebKit interception setup timed out");
    const product = `WebKit ${/Version\/([\d.]+)/.exec(userAgent)?.[1] ?? instance.version()} (engine ${instance.version()})`;
    const facts = { browser: "webkit", mode, workers, engineVersion: instance.version(), toolVersions: tool.toolVersions,
      webkitRevision: tool.webkitRevision, pid: owned.pid, transportOrigin: owned.transportOrigin, persistentProfile: false };
    const enqueue = inputQueue(evidence);
    const pressKey = queuedKeyPress(async spec => {
      const down = key => bounded(page.keyboard.down(key), timeouts.commandMs, "WebKit key down timed out");
      const up = key => bounded(page.keyboard.up(key), timeouts.commandMs, "WebKit key release timed out");
      const main = () => withKeyRelease(() => down(spec.code), () => up(spec.code));
      if (!spec.shift) return main();
      await withKeyRelease(async () => { await down("Shift"); await main(); }, () => up("Shift"));
    }, enqueue);
    const mouseMove = position => bounded(page.mouse.move(position.x, position.y, { steps: 1 }), timeouts.commandMs, "WebKit pointer move timed out");
    const mouseDown = () => bounded(page.mouse.down({ button: "left" }), timeouts.commandMs, "WebKit pointer down timed out");
    const mouseUp = () => bounded(page.mouse.up({ button: "left" }), timeouts.commandMs, "WebKit pointer release timed out");
    const pointer = pointerPorts(width, height, enqueue,
      position => withKeyRelease(async () => { await mouseMove(position); await mouseDown(); }, mouseUp),
      (from, _to, moves) => withKeyRelease(async () => {
        await mouseMove(from); await mouseDown();
        for (const position of moves) { await pointerPause(position.durationMs); await mouseMove(position); }
      }, mouseUp));
    return {
      product, facts, pressKey, ...pointer,
      navigate: url => page.goto(String(url), { waitUntil: "commit", timeout: timeouts.commandMs }),
      evaluate: expression => bounded(page.evaluate(code => (0, eval)(code), expression), timeouts.commandMs, "WebKit evaluation timed out"),
      screenshot: options => {
        const clip = screenshotClip(options, false)?.clip;
        return page.screenshot({ type: "png", timeout: timeouts.commandMs, ...(clip ? { clip } : {}) });
      },
      touch: () => bounded(page.keyboard.press("Shift"), timeouts.commandMs, "WebKit key dispatch timed out"),
      close, captureEvidence: () => evidence.snapshot(product, facts),
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "WebKit page setup and cleanup failed"); }
    throw error;
  }
}
