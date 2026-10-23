import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceUserAgent, openHeadlessPage } from "../src/headlessPage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const times = { startupMs: 1500, commandMs: 500, closeMs: 100, exitMs: 1000 };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

/** A fake Chrome that records each command's parameters, and fails a finger's move when asked. */
async function fakePage(browser, { fail = false, device } = {}) {
  const retained = path.join(root, "build", "touch-protocol");
  await mkdir(retained, { recursive: true });
  const directory = await mkdtemp(path.join(retained, `${browser}-`)), profile = path.join(directory, "profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "fake-config.json"), JSON.stringify({ mode: "normal" }));
  let source = await readFile(path.join(root, "fixtures", "protocol", "fake-browser.mjs"), "utf8");
  source = source.replace('record("command", { method: message.method });', 'record("command", { method: message.method, params: message.params });');
  if (fail) source = source.replace("  let result = {};", `  if (message.method === "Input.dispatchTouchEvent" && message.params.type === "touchMove") { reply({ id: message.id, error: { message: "fixture touch-move failure" } }); return; }
  let result = {};`);
  const script = path.join(directory, "fake-touch.mjs"), binary = path.join(directory, "fake-browser");
  await writeFile(script, source);
  await writeFile(binary, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(script) + " \"$@\"\n", { mode: 0o755 });
  const page = await openHeadlessPage(browser, profile, { mode: "live", binary, width: 412, height: 915, timeouts: times, ...(device ? { device } : {}) });
  return { page, async commands() { return (await readFile(path.join(profile, "fake-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(event => event.event === "command"); } };
}

const touches = recorded => recorded.filter(event => event.method === "Input.dispatchTouchEvent").map(event => event.params);

test("A phone has touch, a mobile viewport and an Android user agent; a desktop has none of them", async () => {
  for (const device of ["phone", undefined]) {
    const { page, commands } = await fakePage("chrome", { device });
    await page.close();
    const recorded = await commands();
    const metrics = recorded.find(event => event.method === "Emulation.setDeviceMetricsOverride").params;
    const agent = recorded.find(event => event.method === "Emulation.setUserAgentOverride").params;
    const touch = recorded.find(event => event.method === "Emulation.setTouchEmulationEnabled");
    assert.equal(page.facts.device, device ?? "desktop");
    if (device) {
      assert.deepEqual([metrics.width, metrics.height, metrics.deviceScaleFactor, metrics.mobile], [412, 915, 1, true]);
      assert.match(agent.userAgent, /Android 14; Pixel 8\).* Mobile Safari/);
      assert.equal(agent.userAgentMetadata.mobile, true);
      assert.deepEqual(touch.params, { enabled: true, maxTouchPoints: 5 });
    } else {
      assert.equal(metrics.mobile, false);
      assert.doesNotMatch(agent.userAgent, /Android/);
      assert.equal(touch, undefined);
    }
  }
});

test("A tablet's user agent names its Chrome and is not a phone's", () => {
  const tablet = deviceUserAgent("HeadlessChrome/149.0.7795.2", { model: "Pixel Tablet", mobile: false });
  assert.match(tablet.userAgent, /Chrome\/149\.0\.7795\.2 Safari\//);
  assert.doesNotMatch(tablet.userAgent, /Mobile|Headless/);
  assert.equal(tablet.userAgentMetadata.fullVersion, "149.0.7795.2");
  assert.deepEqual(tablet.userAgentMetadata.brands[0], { brand: "Chromium", version: "149" });
});

test("A tap, a swipe and a pinch are fingers down, moved and lifted, in turn", async () => {
  const { page, commands } = await fakePage("chrome", { device: "phone" });
  try {
    await assert.rejects(page.tapAt(412, 10), /Finite pointer coordinates/);
    await assert.rejects(page.pinchAt(200, 300, 1, 40), /at least 2 pixels/);
    await assert.rejects(page.pinchAt(5, 300, 40, 80), /Finite pointer coordinates/);
    await assert.rejects(page.swipeAt(10, 10, 20, 20, { steps: 30 }), /1\.\.20 steps/);
    await Promise.all([page.tapAt(100.4, 200.6), page.swipeAt(200, 800, 200, 400, { steps: 4, durationMs: 0 }), page.pinchAt(200, 400, 100, 200, { steps: 2, durationMs: 0 })]);
  } finally { await page.close(); }
  const events = touches(await commands());
  assert.deepEqual(events.map(event => event.type), [
    "touchStart", "touchEnd",
    "touchStart", "touchMove", "touchMove", "touchMove", "touchMove", "touchEnd",
    "touchStart", "touchMove", "touchMove", "touchEnd",
  ]);
  assert.deepEqual(events[0].touchPoints, [{ x: 100, y: 201, id: 0 }]);
  assert.deepEqual(events[1].touchPoints, []);
  assert.deepEqual(events[6].touchPoints, [{ x: 200, y: 400, id: 0 }]);
  assert.deepEqual(events[8].touchPoints, [{ x: 150, y: 400, id: 0 }, { x: 250, y: 400, id: 1 }]);
  assert.deepEqual(events[10].touchPoints, [{ x: 100, y: 400, id: 0 }, { x: 300, y: 400, id: 1 }]);
  assert.throws(() => process.kill(page.facts.pid, 0), { code: "ESRCH" });
});

test("A finger's failed move still lifts every finger", async () => {
  const { page, commands } = await fakePage("chrome", { fail: true, device: "tablet" });
  try {
    await assert.rejects(page.pinchAt(200, 400, 100, 200, { steps: 3, durationMs: 0 }), /fixture touch-move failure/);
    assert(page.captureEvidence().console.some(event => event.level === "error" && event.text.includes("touch")));
  } finally { await page.close(); }
  assert.deepEqual(touches(await commands()).map(event => event.type), ["touchStart", "touchMove", "touchEnd"]);
});

test("Only Chrome takes touch or emulates a device", async () => {
  const profile = path.join(root, "build", "touch-protocol", "unused");
  await assert.rejects(openHeadlessPage("firefox", profile, { mode: "live", width: 412, height: 915, device: "phone" }), /Only Chrome emulates/);
  await assert.rejects(openHeadlessPage("chrome", profile, { mode: "live", width: 412, height: 915, device: "watch" }), /Device must be desktop, phone, tablet/);
  const { page } = await fakePage("firefox");
  try { await assert.rejects(page.tapAt(10, 10), /Touch input is Chrome-only/); } finally { await page.close(); }
});
