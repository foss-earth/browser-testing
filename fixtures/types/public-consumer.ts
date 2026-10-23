import { openHeadlessChrome, openHeadlessFirefox, openHeadlessPage, evaluate, waitForExpression, type HeadlessPage, type BrowserEvidence } from "@foss-earth/browser-testing";
import { openHeadlessChrome as chrome } from "@foss-earth/browser-testing/chrome";
import { openHeadlessFirefox as firefox } from "@foss-earth/browser-testing/firefox";
import { openHeadlessPage as page } from "@foss-earth/browser-testing/page";
import * as core from "@foss-earth/browser-testing/core";
import { normalizeShotList, saveShot, takeShots, utcStamp, writeReview, type ShotList, type ShotRun } from "@foss-earth/browser-testing/shots";

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
  const crop: Uint8Array = await live.screenshot({ clip: { x: 10, y: 20, width: 200, height: 100 }, scale: 2 });
  for (const key of ["Tab", "ShiftTab", "Enter", "Space", "Escape", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End", "PageUp", "PageDown"] as const) {
    await live.pressKey(key);
  }
  await live.clickAt(20, 30);
  await live.dragAt(20, 30, 90, 80, { steps: 5, durationMs: 250 });
  await live.close();
  const phone: HeadlessPage = await page("chrome", profile, { mode: "live", width: 412, height: 915, device: "phone", binary });
  await phone.tapAt(20, 30);
  await phone.swipeAt(200, 800, 200, 300, { steps: 10, durationMs: 250 });
  await phone.pinchAt(206, 450, 80, 160);
  await phone.close();
  const list: ShotList = { base: "http://localhost:5173/", width: 480, wait: "document.fonts.status === 'loaded'", hide: ".clock", shots: [
    { name: "panel/dark", url: "?theme=dark", selector: ".panel", scale: 2, steps: [{ click: "#open" }, { wait: "document.querySelector('.panel')" }, { key: "Escape" }, { print: "document.title" }, "window.scrollTo(0, 0)"] },
    { name: "panel/fresh", fresh: true },
    { name: "panel/phone", device: "phone", steps: [{ tap: "#open" }, { swipe: ".panel", by: [0, -200] }, { pinch: ".map", scale: 2 }, { drag: ".map", by: [40, 0] }] },
  ] };
  const run: ShotRun = await takeShots(normalizeShotList(list), { directory: "build/shots", stamp: utcStamp(), openPage: viewport => page("chrome", profile, { mode: "live", ...viewport, binary }) });
  const review: string = await writeReview("build/shots", run);
  const saved = await saveShot("build/shots", "panel/dark", crop);
  return { result, observed, evidence, pixels, review, saved: saved.status, identities: [openHeadlessChrome === core.openHeadlessChrome, openHeadlessFirefox === core.openHeadlessFirefox, openHeadlessPage === core.openHeadlessPage] };
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
  // @ts-expect-error A step is an expression or one of the named actions.
  const unknownAction: import("@foss-earth/browser-testing/shots").ShotStep = { hover: "#a" };
  // @ts-expect-error A swipe says how far it goes.
  const swipeWithoutBy: import("@foss-earth/browser-testing/shots").ShotStep = { swipe: "#a" };
  void swipeWithoutBy;
  // @ts-expect-error A device is a desktop, a phone or a tablet.
  void page("chrome", "profile", { mode: "live", width: 640, height: 480, device: "watch" });
  void unknownAction;
  // @ts-expect-error Live mode intentionally cannot promise interception through respond.
  void page("chrome", "profile", { mode: "live", width: 640, height: 480, respond: async () => null });
  // @ts-expect-error The reviewed tool contract cannot silently advance.
  const wrongToolVersion: import("@foss-earth/browser-testing").PlaywrightSelection = { packageRoot: "tool", browserCachePath: "cache", expectedVersion: "1.56.0", expectedCoreVersion: "1.55.0", expectedWebkitRevision: "2203" };
  void wrongToolVersion;
}
void negativeDeclarationsOnly;
