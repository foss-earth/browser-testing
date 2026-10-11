import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { openHeadlessPage } from "../src/headlessPage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const times = { startupMs: 1500, commandMs: 500, closeMs: 100, exitMs: 1000 };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function fakePage(browser, fail) {
  const retained = path.join(root, "build", "pointer-protocol");
  await mkdir(retained, { recursive: true });
  const directory = await mkdtemp(path.join(retained, `${browser}-`)), profile = path.join(directory, "profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "fake-config.json"), JSON.stringify({ mode: fail ? "pointer-down-error" : "normal" }));
  let source = await readFile(path.join(root, "fixtures", "protocol", "fake-browser.mjs"), "utf8");
  source = source.replace('record("command", { method: message.method });', 'record("command", { method: message.method, params: message.params });');
  source = source.replace("  let result = {};", `  if (config.mode === "pointer-down-error" && (message.method === "input.performActions" || (message.method === "Input.dispatchMouseEvent" && message.params.type === "mousePressed"))) {
    reply({ id: message.id, ...(chromeProfile ? { error: { message: "fixture pointer-down failure" } } : { type: "error", error: "fixture", message: "fixture pointer-down failure" }) }); return;
  }
  let result = {};`);
  const script = path.join(directory, "fake-pointer.mjs"), binary = path.join(directory, "fake-browser");
  await writeFile(script, source);
  await writeFile(binary, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + " \"$@\"\n", { mode: 0o755 });
  const page = await openHeadlessPage(browser, profile, { mode: "live", binary, width: 640, height: 480, timeouts: times });
  return { page, async commands() { return (await readFile(path.join(profile, "fake-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "command"); } };
}

for (const browser of ["chrome", "firefox"]) {
  test(`${browser} bounded primary pointer shares keyboard queue and rejects unbounded input`, async () => {
    const { page, commands } = await fakePage(browser, false);
    try {
      for (const position of [[NaN, 10], [10, Infinity], [-1, 10], [640, 10], [10, 480]]) await assert.rejects(page.clickAt(...position), /Finite pointer coordinates/);
      for (const options of [{ steps: 21 }, { steps: 0 }, { durationMs: 1001 }, { durationMs: 1.5 }, { button: "right" }]) await assert.rejects(page.dragAt(10, 20, 90, 80, options));
      await Promise.all([page.clickAt(10.4, 20.2), page.pressKey("Tab"), page.dragAt(10, 20, 90, 80, { steps: 4, durationMs: 20 })]);
    } finally { await page.close(); }
    const recorded = await commands();
    if (browser === "chrome") {
      const inputs = recorded.filter(event => ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"].includes(event.method));
      assert.deepEqual(inputs.slice(0, 5).map(event => event.params.type), ["mouseMoved", "mousePressed", "mouseReleased", "rawKeyDown", "keyUp"]);
      const pointer = inputs.filter(event => event.method === "Input.dispatchMouseEvent").map(event => event.params);
      assert.deepEqual([pointer[0].x, pointer[0].y], [10, 20]);
      assert.equal(pointer.filter(event => event.type === "mouseMoved" && event.buttons === 1).length, 4);
      assert.deepEqual([pointer.at(-1).type, pointer.at(-1).x, pointer.at(-1).y, pointer.at(-1).buttons], ["mouseReleased", 90, 80, 0]);
    } else {
      const inputs = recorded.filter(event => ["input.performActions", "input.releaseActions"].includes(event.method));
      assert.deepEqual(inputs.map(event => event.method), ["input.performActions", "input.releaseActions", "input.performActions", "input.releaseActions", "input.performActions", "input.releaseActions"]);
      assert.deepEqual(inputs.filter(event => event.method === "input.performActions").map(event => event.params.actions[0].type), ["pointer", "key", "pointer"]);
      const drag = inputs.at(-2).params.actions[0];
      assert.equal(drag.parameters.pointerType, "mouse");
      assert.equal(drag.actions.filter(action => action.type === "pointerMove").reduce((sum, action) => sum + action.duration, 0), 20);
      assert.equal(drag.actions.at(-1).type, "pointerUp");
    }
    assert.throws(() => process.kill(page.facts.pid, 0), { code: "ESRCH" });
  });

  test(`${browser} failed native pointer down releases button and owned process`, async () => {
    const { page, commands } = await fakePage(browser, true);
    try {
      await assert.rejects(page.dragAt(10, 20, 90, 80, { steps: 4, durationMs: 0 }), /fixture pointer-down failure/);
      assert(page.captureEvidence().console.some(event => event.level === "error" && event.text.includes("pointer")));
    } finally { await page.close(); }
    const recorded = await commands();
    if (browser === "chrome") assert.deepEqual(recorded.filter(event => event.method === "Input.dispatchMouseEvent").map(event => event.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
    else assert(recorded.some(event => event.method === "input.releaseActions"));
    assert.throws(() => process.kill(page.facts.pid, 0), { code: "ESRCH" });
  });
}

test("explicit native primary click and drag produce trusted pointer events and graceful exit", { skip: !process.env.FOSS_BROWSER_POINTER_INPUT }, async () => {
  const input = JSON.parse(await readFile(process.env.FOSS_BROWSER_POINTER_INPUT, "utf8"));
  assert(["chrome", "firefox", "webkit"].includes(input.browser) && path.isAbsolute(input.outputRoot));
  await mkdir(input.outputRoot);
  const profile = path.join(input.outputRoot, "profile"); await mkdir(profile);
  const html = await readFile(path.join(root, "fixtures", "pointer.html"));
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }); response.end(html); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let page;
  try {
    page = await openHeadlessPage(input.browser, profile, { ...input.options, mode: "live", width: 640, height: 480,
      timeouts: { startupMs: 10000, commandMs: 3000, closeMs: 3000, exitMs: 3000 } });
    await page.navigate(`http://127.0.0.1:${server.address().port}/pointer.html`);
    const deadline = Date.now() + 3000;
    while (!(await page.evaluate("Boolean(window.pointerFixture)"))) {
      assert(Date.now() < deadline, "Native pointer fixture startup timed out");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await page.clickAt(80, 40);
    await page.dragAt(60, 140, 160, 170, { steps: 4, durationMs: 200 });
    const state = await page.evaluate("pointerFixture");
    assert(state.clicks.some(event => event.trusted && event.x === 80 && event.y === 40));
    assert(state.events.some(event => event.type === "pointerdown" && event.target === "drag" && event.trusted && event.button === 0 && event.buttons === 1));
    assert(state.events.filter(event => event.type === "pointermove" && event.target === "drag" && event.trusted && event.buttons === 1).length >= 4);
    assert(state.events.some(event => event.type === "pointerup" && event.target === "drag" && event.trusted && event.buttons === 0 && event.x === 160 && event.y === 170));
    await writeFile(path.join(input.outputRoot, "native-pointer.json"), JSON.stringify({ browser: input.browser, product: page.product, facts: page.facts, state }, null, 2));
  } finally {
    try { if (page) await page.close(); }
    finally {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (page) {
        const evidence = page.captureEvidence();
        await writeFile(path.join(input.outputRoot, "browser-evidence.json"), JSON.stringify(evidence, null, 2));
        assert(!evidence.console.some(event => event.level === "error"));
        assert(!evidence.network.some(event => ["failure", "responder-error", "interception-error"].includes(event.phase)));
        assert(Object.values(evidence.dropped).every(count => count === 0));
        assert(!evidence.lifecycle.some(event => ["signal", "forced-close", "graceful-close-timeout"].includes(event.event)));
        assert(Number.isSafeInteger(page.facts.pid) && page.facts.pid > 1);
        assert.throws(() => process.kill(page.facts.pid, 0), { code: "ESRCH" });
      }
    }
  }
});
