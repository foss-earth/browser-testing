import assert from "node:assert/strict";
import * as root from "@foss-earth/browser-testing";
import * as core from "@foss-earth/browser-testing/core";
import * as chrome from "@foss-earth/browser-testing/chrome";
import * as firefox from "@foss-earth/browser-testing/firefox";
import * as page from "@foss-earth/browser-testing/page";

/** Actual archive-only runner will import this only after a future recorded check grant. */
export async function publicImportContract() {
  assert.equal(root.openHeadlessChrome, chrome.openHeadlessChrome);
  assert.equal(root.openHeadlessFirefox, firefox.openHeadlessFirefox);
  assert.equal(root.openHeadlessPage, page.openHeadlessPage);
  assert.equal(root.evaluate, chrome.evaluate);
  assert.equal(root.waitForExpression, chrome.waitForExpression);
  assert.deepEqual(Object.keys(root).sort(), Object.keys(core).sort());
  // Pure/core imports above must not require a browser, Playwright or tool/cache paths.
  for (const specifier of ["@foss-earth/browser-testing/src/headlessChrome.mjs", "@foss-earth/browser-testing/src/evidence.mjs"]) {
    await assert.rejects(import(specifier), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
  return { exports: Object.keys(root).sort(), pureImport: true, privateImportsRejected: true };
}

export async function publicOwnedProcessContract(profile, binary) {
  const timeouts = { startupMs: 1500, commandMs: 500, closeMs: 100, exitMs: 1000 };
  const transport = await chrome.openHeadlessChrome(profile, binary, [], { timeouts });
  try {
    assert.equal(await chrome.evaluate(transport, "session", "true"), true);
    await chrome.waitForExpression(transport, "session", "true", 500);
    await transport.send("Browser.close");
    assert.equal((await transport.waitForExit(1000)).code, 0);
  } finally { await transport.close(); }
  return { pid: transport.pid, gracefulExit: true };
}
