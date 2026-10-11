import { openHeadlessChrome, openHeadlessFirefox, openHeadlessPage, evaluate, waitForExpression, type HeadlessPage, type BrowserEvidence } from "@foss-earth/browser-testing";
import { openHeadlessChrome as chrome } from "@foss-earth/browser-testing/chrome";
import { openHeadlessFirefox as firefox } from "@foss-earth/browser-testing/firefox";
import { openHeadlessPage as page } from "@foss-earth/browser-testing/page";
import * as core from "@foss-earth/browser-testing/core";

/** Declaration fixture only; a later granted strict NodeNext compilation does not launch. */
export async function compatibleConsumer(profile: string, binary: string) {
  const transport = await chrome(profile, binary, ["--disable-webgl2"], { timeouts: { closeMs: 1000 } });
  const result: unknown = await evaluate(transport, "session", "({hello:true})");
  await waitForExpression(transport, "session", "true");
  const observed: { code: number | null; signal: string | null } = await transport.waitForExit(100);
  await transport.close();
  const bidi = await firefox(profile, binary, { "webgl.enable-webgl2": true });
  await bidi.evaluate(await bidi.context(), "true");
  await bidi.close();
  const live: HeadlessPage = await page("webkit", profile, { mode: "live", width: 1024, height: 768, workers: true,
    playwright: { packageRoot: "tool-home", browserCachePath: "browser-cache", expectedVersion: "1.55.0", expectedCoreVersion: "1.55.0", expectedWebkitRevision: "2203" } });
  const evidence: BrowserEvidence = live.captureEvidence();
  const pixels: Uint8Array = await live.screenshot();
  for (const key of ["Tab", "ShiftTab", "Enter", "Space", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"] as const) {
    await live.pressKey(key);
  }
  await live.clickAt(20, 30);
  await live.dragAt(20, 30, 90, 80, { steps: 5, durationMs: 250 });
  await live.close();
  return { result, observed, evidence, pixels, identities: [openHeadlessChrome === core.openHeadlessChrome, openHeadlessFirefox === core.openHeadlessFirefox, openHeadlessPage === core.openHeadlessPage] };
}

// Old signature remains representable: respond implies interception, not live workers.
export const oldOptions = { width: 640, height: 480, respond: async (_url: URL) => ({ status: 200, body: "fixture" }) };
function negativeDeclarationsOnly(live?: HeadlessPage) {
  if (live) {
    // @ts-expect-error Arbitrary printable input is outside the finite control key port.
    void live.pressKey("A");
    // @ts-expect-error Only the documented ShiftTab control is accepted.
    void live.pressKey("Shift+Tab");
    // @ts-expect-error Pointer coordinates must be numbers.
    void live.clickAt("20", 30);
    // @ts-expect-error Arbitrary pointer buttons are outside the primary-only port.
    void live.dragAt(20, 30, 90, 80, { button: "right" });
  }
  // @ts-expect-error Live mode intentionally cannot promise interception through respond.
  void page("chrome", "profile", { mode: "live", width: 640, height: 480, respond: async () => null });
  // @ts-expect-error The reviewed tool contract cannot silently advance.
  const wrongToolVersion: import("@foss-earth/browser-testing").PlaywrightSelection = { packageRoot: "tool", browserCachePath: "cache", expectedVersion: "1.56.0", expectedCoreVersion: "1.55.0", expectedWebkitRevision: "2203" };
  void wrongToolVersion;
}
void negativeDeclarationsOnly;
