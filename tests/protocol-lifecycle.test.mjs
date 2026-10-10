import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { openHeadlessChrome, evaluate, waitForExpression } from "../src/headlessChrome.mjs";
import { openHeadlessFirefox } from "../src/headlessFirefox.mjs";
import { openHeadlessPage } from "../src/headlessPage.mjs";

// Source fixtures prepared for a future grant. Every process has a fresh owned profile.
const times = { startupMs: 1500, commandMs: 500, closeMs: 100, exitMs: 1000 };
const fixturePath = fileURLToPath(new URL("../fixtures/protocol/fake-browser.mjs", import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function fake(mode = "normal", extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "foss-browser-fixture-"));
  const profile = path.join(root, "profile");
  await mkdir(profile);
  await writeFile(path.join(profile, "fake-config.json"), JSON.stringify({ mode, ...extra }));
  const binary = path.join(root, "fake-browser");
  await writeFile(binary, "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(fixturePath) + " \"$@\"\n", { mode: 0o755 });
  return { root, profile, binary, async events() { return (await readFile(path.join(profile, "fake-events.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row)); } };
}
function requireDead(events) {
  assert(events.some(row => row.event === "spawn"));
  const pid = events[0].pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("Chrome public legacy evaluate/wait helpers and graceful Browser.close→waitForExit", async () => {
  const input = await fake();
  const chrome = await openHeadlessChrome(input.profile, input.binary, [], { timeouts: times });
  try {
    assert.equal(await evaluate(chrome, "session", "true"), true);
    await waitForExpression(chrome, "session", "true", 500);
    await chrome.send("Browser.close");
    assert.equal((await chrome.waitForExit(1000)).code, 0);
  } finally { await chrome.close(); }
  const events = await input.events();
  assert.equal(events.filter(row => row.event === "close").length, 1);
  assert.equal(events.filter(row => row.event === "signal").length, 0);
  requireDead(events);
});

test("Chrome close waits graceful deadline before signal and then observes actual exit", async () => {
  const input = await fake("close-no-exit");
  const chrome = await openHeadlessChrome(input.profile, input.binary, [], { timeouts: times });
  await chrome.close();
  const events = await input.events();
  assert(events.find(row => row.event === "signal").time - events.find(row => row.event === "close").time >= times.closeMs - 10);
  requireDead(events);
});

for (const mode of ["drop-version", "malformed-version", "error-version", "null-version", "array-version", "scalar-version", "oversize-version"]) {
  test(`Chrome ${mode} startup failure closes and awaits process`, async () => {
    const input = await fake(mode);
    await assert.rejects(openHeadlessChrome(input.profile, input.binary, [], { timeouts: { ...times, startupMs: 500 } }));
    requireDead(await input.events());
  });
}

test("Missing binary rejects without a spawned process", async () => {
  const input = await fake();
  await assert.rejects(openHeadlessChrome(input.profile, path.join(input.root, "missing"), [], { timeouts: times }), { code: "ENOENT" });
});

test("Spawn permission failure has no lingering process or pending protocol request", async () => {
  const input = await fake();
  const notExecutable = path.join(input.root, "not-executable");
  await writeFile(notExecutable, "fixture", { mode: 0o644 });
  await assert.rejects(openHeadlessChrome(input.profile, notExecutable, [], { timeouts: times }));
  await assert.rejects(openHeadlessFirefox(input.profile, notExecutable, {}, { timeouts: times }));
});

test("Firefox graceful close observes exit and preserves context/evaluate compatibility", async () => {
  const input = await fake();
  const firefox = await openHeadlessFirefox(input.profile, input.binary, {}, { timeouts: times });
  try { assert.equal(await firefox.evaluate(await firefox.context(), "true"), true); }
  finally { await firefox.close(); }
  const events = await input.events();
  assert.equal(events.filter(row => row.event === "signal").length, 0);
  requireDead(events);
});

for (const mode of ["no-address", "socket-error", "session-error", "malformed-session", "drop-session", "null-session", "array-session", "scalar-session", "oversize-session"]) {
  test(`Firefox ${mode} failure before usable session awaits bounded process cleanup`, async () => {
    const input = await fake(mode);
    await assert.rejects(openHeadlessFirefox(input.profile, input.binary, {}, { timeouts: { ...times, startupMs: 500 } }));
    const events = await input.events();
    if (mode === "socket-error") assert(events.some(event => event.event === "websocket-upgrade"), "Socket-error fixture must reach the actual upgrade");
    else if (mode !== "no-address") assert(events.some(event => event.event === "command" && event.method === "session.new"), "Session-error fixture must reach session.new");
    requireDead(events);
  });
}

test("Chrome failed interception responder actively fails request and sanitized evidence survives close", async () => {
  const input = await fake();
  const page = await openHeadlessPage("chrome", input.profile, { mode: "interception", binary: input.binary, width: 640, height: 480,
    respond() { throw new Error("api_key=private /Users/private/file"); }, timeouts: times });
  try {
    const until = Date.now() + 1000;
    while (!(await input.events()).some(row => row.method === "Fetch.failRequest") && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert((await input.events()).some(row => row.method === "Fetch.failRequest"));
    assert.equal((await page.screenshot()).subarray(1, 4).toString(), "PNG");
    await page.touch();
  } finally { await page.close(); }
  const evidence = page.captureEvidence();
  assert(evidence.console.some(row => row.text.includes("[redacted]")));
  assert(!JSON.stringify(evidence).includes("/Users/private"));
  assert(!JSON.stringify(evidence).includes("?token="));
  assert(evidence.lifecycle.some(row => row.event === "exit"));
  requireDead(await input.events());
});

test("Live Chrome never enables interception and supports explicit workers", async () => {
  const input = await fake();
  const page = await openHeadlessPage("chrome", input.profile, { mode: "live", binary: input.binary, width: 640, height: 480, workers: true, timeouts: times });
  try { assert.equal(await page.evaluate("true"), true); await page.navigate("http://127.0.0.1/fixture"); }
  finally { await page.close(); }
  assert(!(await input.events()).some(row => row.method === "Fetch.enable"));
});

test("WebKit blocked interception cannot claim worker proof or silently load tools", async () => {
  await assert.rejects(openHeadlessPage("webkit", "profile", { mode: "interception", workers: true, width: 640, height: 480, respond: () => null }), /Worker request interception/);
  await assert.rejects(openHeadlessPage("webkit", "profile", { mode: "live", width: 640, height: 480 }), /requires explicit Playwright/);
});
