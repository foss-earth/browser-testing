import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { openHeadlessPage } from "../src/headlessPage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const keys = ["Tab", "ShiftTab", "Enter", "Space", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"];
const times = { startupMs: 1500, commandMs: 500, closeMs: 100, exitMs: 1000 };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function fakePage(browser, fail = false) {
  const retained = path.join(root, "build", "keyboard-protocol");
  await mkdir(retained, { recursive: true });
  const directory = await mkdtemp(path.join(retained, `${browser}-`));
  const profile = path.join(directory, "profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "fake-config.json"), JSON.stringify({ mode: fail ? "key-down-error" : "normal" }));
  // Private fixture variant records protocol payloads and injects a first-key failure.
  let source = await readFile(path.join(root, "fixtures", "protocol", "fake-browser.mjs"), "utf8");
  source = source.replace('record("command", { method: message.method });', 'record("command", { method: message.method, params: message.params });');
  source = source.replace("  let result = {};", `  if (config.mode === "key-down-error" && (message.method === "input.performActions" || (message.method === "Input.dispatchKeyEvent" && message.params.type !== "keyUp" && message.params.key !== "Shift"))) {
    reply({ id: message.id, ...(chromeProfile ? { error: { message: "fixture key-down failure" } } : { type: "error", error: "fixture", message: "fixture key-down failure" }) }); return;
  }
  let result = {};`);
  const script = path.join(directory, "fake-keyboard.mjs");
  await writeFile(script, source);
  const binary = path.join(directory, "fake-browser");
  await writeFile(binary, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + " \"$@\"\n", { mode: 0o755 });
  const page = await openHeadlessPage(browser, profile, { mode: "live", binary, width: 640, height: 480, timeouts: times });
  return { page, async events() { return (await readFile(path.join(profile, "fake-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); } };
}

for (const browser of ["chrome", "firefox"]) {
  test(`${browser} finite native control dispatch serializes presses and preserves touch`, async () => {
    const { page, events } = await fakePage(browser);
    try {
      await assert.rejects(page.pressKey("A"), /Unsupported control key/);
      await assert.rejects(page.pressKey("__proto__"), /Unsupported control key/);
      await Promise.all(keys.map(key => page.pressKey(key)));
      await page.touch();
    } finally { await page.close(); }
    const recorded = await events();
    const commands = recorded.filter(event => event.event === "command");
    if (browser === "chrome") {
      const input = commands.filter(event => event.method === "Input.dispatchKeyEvent").map(event => event.params);
      assert.equal(input[0].key, "Tab"); assert.equal(input[1].type, "keyUp");
      assert.deepEqual(input.slice(2, 6).map(event => [event.key, event.type, event.modifiers]), [["Shift", "rawKeyDown", 8], ["Tab", "rawKeyDown", 8], ["Tab", "keyUp", 8], ["Shift", "keyUp", 0]]);
      const space = input.find(event => event.code === "Space" && event.type === "keyDown");
      assert.deepEqual([space.key, space.windowsVirtualKeyCode, space.text, space.unmodifiedText], [" ", 32, " ", " "]);
      assert(input.some(event => event.key === "Enter" && event.text === "\r" && event.windowsVirtualKeyCode === 13));
    } else {
      const input = commands.filter(event => ["input.performActions", "input.releaseActions"].includes(event.method));
      assert.equal(input.filter(event => event.method === "input.releaseActions").length, keys.length);
      assert.deepEqual(input[2].params.actions[0].actions.map(action => action.value), ["\uE008", "\uE004", "\uE004", "\uE008"]);
      assert(input.some(event => event.params?.actions?.[0].actions.some(action => action.value === " ")));
    }
    assert(!recorded.some(event => event.event === "signal"));
    assert.throws(() => process.kill(page.facts.pid, 0), { code: "ESRCH" });
  });

  test(`${browser} failed native key down releases all held keys and owned process`, async () => {
    const { page, events } = await fakePage(browser, true);
    try {
      await assert.rejects(page.pressKey("ShiftTab"), /fixture key-down failure/);
      assert(page.captureEvidence().lifecycle.some(event => event.event === "keyboard-error"));
    } finally { await page.close(); }
    const commands = (await events()).filter(event => event.event === "command");
    if (browser === "chrome") {
      const input = commands.filter(event => event.method === "Input.dispatchKeyEvent").map(event => event.params);
      assert.deepEqual(input.map(event => [event.key, event.type]), [["Shift", "rawKeyDown"], ["Tab", "rawKeyDown"], ["Tab", "keyUp"], ["Shift", "keyUp"]]);
    } else assert(commands.some(event => event.method === "input.releaseActions"));
    assert.throws(() => process.kill(page.facts.pid, 0), { code: "ESRCH" });
  });
}

async function waitFor(page, expression) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Native keyboard fixture state timed out");
}

test("explicit existing native browser proves trusted focus and default button activation", { skip: !process.env.FOSS_BROWSER_KEYBOARD_INPUT }, async () => {
  const input = JSON.parse(await readFile(process.env.FOSS_BROWSER_KEYBOARD_INPUT, "utf8"));
  assert(["chrome", "firefox", "webkit"].includes(input.browser));
  assert(path.isAbsolute(input.outputRoot));
  await mkdir(input.outputRoot); // Fresh caller-owned retained evidence directory.
  const profile = path.join(input.outputRoot, "profile");
  await mkdir(profile);
  const html = await readFile(path.join(root, "fixtures", "keyboard.html"));
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }); response.end(html); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let page;
  try {
    page = await openHeadlessPage(input.browser, profile, { ...input.options, mode: "live", width: 640, height: 480,
      timeouts: { startupMs: 10000, commandMs: 3000, closeMs: 3000, exitMs: 3000 } });
    await page.navigate(`http://127.0.0.1:${server.address().port}/keyboard.html`);
    await waitFor(page, "Boolean(window.keyboardFixture && document.activeElement.id === 'first')");
    await page.pressKey("Tab");
    await waitFor(page, "document.activeElement.id === 'second'");
    await page.pressKey("ShiftTab");
    await waitFor(page, "document.activeElement.id === 'first'");
    await page.pressKey("Enter");
    await waitFor(page, "keyboardFixture.clicks.length === 1");
    await page.pressKey("Space");
    await waitFor(page, "keyboardFixture.clicks.length === 2");
    for (const key of keys.slice(4)) await page.pressKey(key);
    const state = await page.evaluate("({ fixture: keyboardFixture, focused: document.activeElement.id })");
    assert.deepEqual(state.fixture.clicks, [{ id: "first", trusted: true }, { id: "first", trusted: true }]);
    for (const key of ["Tab", "Enter", " ", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"]) {
      assert(state.fixture.events.some(event => event.type === "keydown" && event.key === key && event.trusted));
      assert(state.fixture.events.some(event => event.type === "keyup" && event.key === key && event.trusted));
    }
    assert(state.fixture.events.some(event => event.key === "Tab" && event.shift && event.trusted));
    await writeFile(path.join(input.outputRoot, "native-input.json"), JSON.stringify({ browser: input.browser, product: page.product, facts: page.facts, state }, null, 2));
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
