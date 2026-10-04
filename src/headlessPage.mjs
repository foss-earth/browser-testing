import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, openHeadlessChrome } from "./headlessChrome.mjs";
import { openHeadlessFirefox } from "./headlessFirefox.mjs";

/** Where Playwright and its WebKit are installed, inside this checkout's scratch (docs/validation/README.md says how). */
const PLAYWRIGHT_HOME = fileURLToPath(new URL("../../build/tools/playwright/", import.meta.url));

/** What a check's requests are named, after the browser's own name. */
const CHECK_NAME = "foss-earth-check/1.0";

/**
 * One page of a headless browser, the same to a check whether it is Chrome, Firefox or
 * WebKit, Safari's engine: every request the page makes is answered by `respond`, so
 * there is no server and no network.
 *
 * `respond(url)` returns `{ status, headers, body }`, or null for a request that must
 * fail, as one to another origin. `chromeArgs` are Chrome's switches and `firefoxPrefs`
 * Firefox's preferences, such as `--disable-webgl2` and `webgl.enable-webgl2: false`.
 */
export async function openHeadlessPage(browser, profileDirectory, { respond, width, height, binary, chromeArgs = [], firefoxPrefs = {} }) {
  if (browser === "firefox") return firefoxPage(profileDirectory, { respond, width, height, binary, firefoxPrefs });
  if (browser === "chrome") return chromePage(profileDirectory, { respond, width, height, binary, chromeArgs });
  if (browser === "webkit") return webkitPage(profileDirectory, { respond, width, height });
  throw new Error(`No headless page for "${browser}": chrome, firefox or webkit.`);
}

/**
 * Playwright's build of WebKit: the engine of Safari, on this Mac's GPU through WebGL. It has no
 * WebGPU, and it is not Safari on a phone: its memory limits and its GPU are this Mac's.
 */
async function webkitPage(profileDirectory, { respond, width, height }) {
  // Its browsers, like its package, stay inside the checkout. Playwright reads this as it loads.
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(PLAYWRIGHT_HOME, "browsers");
  let webkit;
  try {
    ({ webkit } = createRequire(path.join(PLAYWRIGHT_HOME, "package.json"))("playwright"));
  } catch {
    throw new Error("Playwright is not installed: npm install --prefix build/tools/playwright playwright, then its WebKit (docs/validation/README.md).");
  }
  // Playwright's routing does not reach a worker's requests in WebKit: the app's tile workers would ask the real
  // network. A proxy at an address nothing listens on refuses whatever the routing below does not answer.
  const browser = await webkit.launch({ headless: true, proxy: { server: "http://127.0.0.1:9" } });
  try {
    const probe = await browser.newPage();
    const userAgent = await probe.evaluate(() => navigator.userAgent);
    await probe.close();
    // A context of its own for the profile's name: nothing of it is kept on disk.
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, userAgent: `${userAgent} ${CHECK_NAME}` });
    const page = await context.newPage();
    await page.route("**/*", async route => {
      const answer = await respond(new URL(route.request().url())).catch(() => null);
      if (!answer) { await route.abort("blockedbyclient").catch(() => {}); return; }
      await route.fulfill({ status: answer.status, headers: answer.headers ?? {}, body: Buffer.from(answer.body ?? "") }).catch(() => {});
    });
    return {
      product: `WebKit ${/Version\/([\d.]+)/.exec(userAgent)?.[1] ?? browser.version()} (Playwright ${browser.version()})`,
      navigate: url => page.goto(url, { waitUntil: "commit" }),
      // As Chrome's Runtime.evaluate: statements, the last one's value, a promise awaited.
      evaluate: expression => page.evaluate(code => (0, eval)(code), expression),
      screenshot: () => page.screenshot({ type: "png" }),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function chromePage(profileDirectory, { respond, width, height, binary, chromeArgs }) {
  const chrome = await openHeadlessChrome(profileDirectory, binary ?? process.env.CHROME_BIN, chromeArgs);
  try {
    const version = await chrome.send("Browser.getVersion");
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params = {}) => chrome.send(method, params, sessionId);
    chrome.onEvent(message => {
      if (message.sessionId !== sessionId || message.method !== "Fetch.requestPaused") return;
      void (async () => {
        const { requestId, request } = message.params;
        const answer = await respond(new URL(request.url));
        if (!answer) { await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); return; }
        await send("Fetch.fulfillRequest", { requestId, responseCode: answer.status, responseHeaders: Object.entries(answer.headers ?? {}).map(([name, value]) => ({ name, value })), body: Buffer.from(answer.body ?? "").toString("base64") });
      })().catch(() => {});
    });
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await send("Emulation.setUserAgentOverride", { userAgent: `${version.userAgent} ${CHECK_NAME}` });
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    return {
      product: version.product,
      navigate: url => send("Page.navigate", { url }),
      evaluate: expression => evaluate(chrome, sessionId, expression),
      async screenshot() { return Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"); },
      async close() {
        await chrome.send("Target.closeTarget", { targetId }).catch(() => {});
        await chrome.close();
      },
    };
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

async function firefoxPage(profileDirectory, { respond, width, height, binary, firefoxPrefs }) {
  const firefox = await openHeadlessFirefox(profileDirectory, binary ?? process.env.FIREFOX_BIN, firefoxPrefs);
  try {
    const context = await firefox.context();
    const userAgent = await firefox.evaluate(context, "navigator.userAgent");
    firefox.onEvent(message => {
      if (message.method !== "network.beforeRequestSent" || !message.params.isBlocked) return;
      void (async () => {
        const request = message.params.request.request;
        const answer = await respond(new URL(message.params.request.url));
        if (!answer) { await firefox.send("network.failRequest", { request }); return; }
        await firefox.send("network.provideResponse", {
          request, statusCode: answer.status, reasonPhrase: answer.status === 200 ? "OK" : "Not Found",
          headers: Object.entries(answer.headers ?? {}).map(([name, value]) => ({ name, value: { type: "string", value } })),
          body: { type: "base64", value: Buffer.from(answer.body ?? "").toString("base64") },
        });
      })().catch(() => {});
    });
    await firefox.send("session.subscribe", { events: ["network.beforeRequestSent"] });
    await firefox.send("network.addIntercept", { phases: ["beforeRequestSent"] });
    await firefox.send("emulation.setUserAgentOverride", { userAgent: `${userAgent} ${CHECK_NAME}`, contexts: [context] });
    await firefox.send("browsingContext.setViewport", { context, viewport: { width, height }, devicePixelRatio: 1 });
    return {
      product: /Firefox\/[\d.]+/.exec(userAgent)?.[0] ?? "Firefox",
      // "none": the caller waits for what it needs, as with Chrome's Page.navigate.
      navigate: url => firefox.send("browsingContext.navigate", { context, url, wait: "none" }),
      evaluate: expression => firefox.evaluate(context, expression),
      async screenshot() { return Buffer.from((await firefox.send("browsingContext.captureScreenshot", { context, origin: "viewport" })).data, "base64"); },
      close: () => firefox.close(),
    };
  } catch (error) {
    await firefox.close();
    throw error;
  }
}
