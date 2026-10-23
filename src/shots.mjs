import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Screenshots for review: a list of named shots taken in one browser per
 * viewport, each cropped to what it shows. A shot whose image is unchanged is
 * left alone; a changed one replaces the file and the old image moves to
 * archive/<UTC time of the run>/ beside it, so a review sees only what changed
 * and can still compare it with what it was.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const DEFAULT_KEYS = ["device", "width", "height", "scale", "pad", "freeze", "timeoutMs", "wait", "hide"];
const SHOT_KEYS = ["name", "url", "steps", "selector", "fresh", ...DEFAULT_KEYS];
const LIST_KEYS = ["base", "shots", ...DEFAULT_KEYS];
/** Steps of one selector or expression; `swipe` and `drag` also take `by`, and `pinch` a `scale`. */
const STEP_KEYS = ["click", "tap", "key", "wait", "print"];
const MOVE_STEPS = { swipe: "by", drag: "by", pinch: "scale" };
/** Each device's viewport unless a shot gives its own: Chrome's Pixel 8 and Pixel Tablet, the tablet held level. */
export const DEVICE_SIZES = Object.freeze({ desktop: { width: 1100, height: 700 }, phone: { width: 412, height: 915 }, tablet: { width: 1280, height: 800 } });
const STEP_HELP = "a step is an expression string, { click | tap: selector }, { swipe | drag: selector, by: [dx, dy] }, { pinch: selector, scale }, { key: name }, { wait: expression } or { print: expression }";

/** A run's archive folder name: its UTC time, "2026-10-21T155203Z", which sorts by time. */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "");
}

function checkName(name) {
  const top = typeof name === "string" ? name.split("/")[0] : "";
  if (typeof name !== "string" || !NAME.test(name) || name.split("/").includes("..") || ["archive", "failed", "index"].includes(top)) {
    throw new Error(`Shot name "${name}" must be letters, digits, ".", "_" or "-", in "/" folders, not under archive/ or failed/`);
  }
}

/**
 * Writes a shot as <directory>/<name>.png. The same bytes leave the file
 * untouched; different bytes move the old image to
 * <directory>/archive/<stamp>/<name>.png first.
 */
export async function saveShot(directory, name, bytes, { stamp = utcStamp() } = {}) {
  checkName(name);
  const file = path.join(directory, `${name}.png`);
  let old = null;
  try { old = await readFile(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (old && Buffer.compare(old, bytes) === 0) return { name, status: "unchanged", path: file };
  await mkdir(path.dirname(file), { recursive: true });
  let previous;
  if (old) {
    previous = path.join(directory, "archive", stamp, `${name}.png`);
    await mkdir(path.dirname(previous), { recursive: true });
    await rename(file, previous);
  }
  await writeFile(file, bytes);
  return { name, status: old ? "changed" : "new", path: file, ...(previous ? { previous } : {}) };
}

/** A PNG's pixel size from its header, or null. */
export function pngSize(bytes) {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function positive(value, name, max) {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) throw new Error(`${name} must be a number above 0 and at most ${max}`);
}

function checkStep(step, where) {
  if (typeof step === "string") return;
  const keys = step && typeof step === "object" ? Object.keys(step) : [];
  const action = keys.find(key => key in MOVE_STEPS);
  if (action) {
    const extra = MOVE_STEPS[action];
    const value = step[extra];
    const valid = extra === "by"
      ? Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
      : typeof value === "number" && value >= 0.1 && value <= 10;
    if (keys.length === 2 && typeof step[action] === "string" && valid) return;
    throw new Error(`${where}: ${action === "pinch" ? "a pinch's scale is a number 0.1..10" : `a ${action}'s by is [dx, dy] in CSS px`}; ${STEP_HELP}`);
  }
  if (keys.length !== 1 || !STEP_KEYS.includes(keys[0]) || typeof step[keys[0]] !== "string") throw new Error(`${where}: ${STEP_HELP}`);
}

/**
 * Checks a shot list and fills each shot from the list's defaults: a desktop
 * viewport of 1100 by 700, scale 1, 8 px around a crop, animations frozen and
 * 10 s to wait. The list's own device, width, height, scale, pad, freeze,
 * timeoutMs, wait and hide are its shots' defaults. A phone or a tablet has
 * its own viewport, which a width or height beside the device, or on its
 * shot, changes; a shot that names its own device leaves the list's size.
 * A shot's url is relative to the list's base.
 */
export function normalizeShotList(list) {
  if (!list || typeof list !== "object" || !Array.isArray(list.shots) || list.shots.length === 0) throw new Error("A shot list has a non-empty shots array");
  const unknown = Object.keys(list).filter(key => !LIST_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown shot list keys: ${unknown.join(", ")}`);
  const names = new Set();
  return list.shots.map((shot, index) => {
    const where = `Shot ${shot?.name ?? index}`;
    if (!shot || typeof shot !== "object") throw new Error(`${where} must be an object`);
    const extra = Object.keys(shot).filter(key => !SHOT_KEYS.includes(key));
    if (extra.length) throw new Error(`${where}: unknown keys ${extra.join(", ")}`);
    checkName(shot.name);
    if (names.has(shot.name)) throw new Error(`${where} is named twice`);
    names.add(shot.name);
    const device = shot.device ?? list.device ?? "desktop";
    if (!Object.hasOwn(DEVICE_SIZES, device)) throw new Error(`${where}: device is ${Object.keys(DEVICE_SIZES).join(", ")}`);
    const ownDevice = shot.device !== undefined;
    const merged = {
      ...DEVICE_SIZES[device], scale: 1, pad: 8, freeze: true, timeoutMs: 10000, fresh: false,
      ...Object.fromEntries(DEFAULT_KEYS.filter(key => list[key] !== undefined && !(ownDevice && (key === "width" || key === "height"))).map(key => [key, list[key]])),
      ...shot,
      device,
    };
    for (const key of ["width", "height"]) if (!Number.isSafeInteger(merged[key]) || merged[key] < 1 || merged[key] > 8192) throw new Error(`${where}: ${key} must be a whole number 1..8192`);
    positive(merged.scale, `${where}: scale`, 4);
    positive(merged.timeoutMs, `${where}: timeoutMs`, 110000);
    if (typeof merged.pad !== "number" || !Number.isFinite(merged.pad) || merged.pad < 0) throw new Error(`${where}: pad must be 0 or more`);
    for (const key of ["freeze", "fresh"]) if (typeof merged[key] !== "boolean") throw new Error(`${where}: ${key} is true or false`);
    for (const key of ["url", "wait", "selector", "hide"]) if (merged[key] !== undefined && typeof merged[key] !== "string") throw new Error(`${where}: ${key} must be a string`);
    const steps = merged.steps ?? [];
    if (!Array.isArray(steps)) throw new Error(`${where}: steps must be an array`);
    for (const step of steps) checkStep(step, where);
    const url = new URL(merged.url ?? "", list.base).href;
    return { ...merged, url, steps };
  });
}

// Hidden, not removed, so nothing else moves: a frame rate or a live map that would change every image.
const hideRule = selector => `${selector} { visibility: hidden !important; }`;
const FREEZE = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }";

/** In one round trip: wait for a condition in the page, then for fonts and two frames. */
function settleExpression(wait, timeoutMs, freeze, hide) {
  return `(async () => {
    const check = () => { try { return Boolean(${wait ?? 'document.readyState === "complete"'}); } catch { return false; } };
    const deadline = performance.now() + ${Math.round(timeoutMs)};
    while (!check()) {
      if (performance.now() > deadline) throw new Error(${JSON.stringify(`Timed out waiting for ${wait ?? "the page to load"}`)});
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (${freeze} && !document.getElementById("browser-testing-freeze")) {
      const style = document.createElement("style");
      style.id = "browser-testing-freeze";
      style.textContent = ${JSON.stringify(FREEZE)};
      (document.head ?? document.documentElement).append(style);
    }
    if (${JSON.stringify(hide ?? "")} && !document.getElementById("browser-testing-hide")) {
      const style = document.createElement("style");
      style.id = "browser-testing-hide";
      style.textContent = ${JSON.stringify(hide ? hideRule(hide) : "")};
      (document.head ?? document.documentElement).append(style);
    }
    await document.fonts?.ready;
    const frames = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.race([frames, new Promise(resolve => setTimeout(resolve, 200))]);
    return true;
  })()`;
}

// A page that reloads itself, as one does to become cross-origin isolated, drops an evaluation in flight.
const NAVIGATED = /navigated or closed|Execution context was destroyed|Cannot find context/i;

/** Waits in the page, starting over in the new document when the page navigates meanwhile. */
async function settle(page, wait, timeoutMs, freeze, hide) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await page.evaluate(settleExpression(wait, Math.max(1, deadline - Date.now()), freeze, hide)); }
    catch (error) {
      if (!NAVIGATED.test(error instanceof Error ? error.message : "") || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/** The box holding every visible element a selector matches, or only the first, scrolled into view, in viewport pixels. */
function boxExpression(selector, first = false) {
  return `(() => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(element => element.getClientRects().length > 0).slice(0, ${first ? 1 : "Infinity"});
    if (elements.length === 0) throw new Error(${JSON.stringify(`Nothing visible matches ${selector}`)});
    elements[0].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const rects = elements.map(element => element.getBoundingClientRect());
    const left = Math.min(...rects.map(rect => rect.left)), top = Math.min(...rects.map(rect => rect.top));
    return { x: left, y: top, width: Math.max(...rects.map(rect => rect.right)) - left, height: Math.max(...rects.map(rect => rect.bottom)) - top };
  })()`;
}

/** A pinch's two distances, `scale` apart, about as wide as the element and inside the viewport either side of its centre. */
export function pinchDistances(box, x, width, scale) {
  let from = Math.max(20, Math.min(160, 0.4 * Math.min(box.width, box.height))), to = from * scale;
  const over = Math.max(from, to) / (2 * Math.min(x, width - 1 - x));
  if (over > 1) { from /= over; to /= over; }
  return { from, to };
}

async function runStep(page, step, shot, printed) {
  if (typeof step === "string") { await page.evaluate(step); return; }
  if (step.print !== undefined) { printed.push(await page.evaluate(`(async () => JSON.stringify(await (${step.print})))()`)); return; }
  if (step.wait !== undefined) { await settle(page, step.wait, shot.timeoutMs, false); return; }
  if (step.key !== undefined) { await page.pressKey(step.key); return; }
  const selector = step.click ?? step.tap ?? step.swipe ?? step.drag ?? step.pinch;
  const box = await page.evaluate(boxExpression(selector, true));
  const inside = (value, size) => Math.max(0, Math.min(size - 1, value));
  const x = inside(box.x + box.width / 2, shot.width), y = inside(box.y + box.height / 2, shot.height);
  if (step.click !== undefined) await page.clickAt(x, y);
  else if (step.tap !== undefined) await page.tapAt(x, y);
  else if (step.pinch !== undefined) { const { from, to } = pinchDistances(box, x, shot.width, step.scale); await page.pinchAt(x, y, from, to); }
  else {
    const toX = inside(x + step.by[0], shot.width), toY = inside(y + step.by[1], shot.height);
    await (step.swipe !== undefined ? page.swipeAt(x, y, toX, toY) : page.dragAt(x, y, toX, toY));
  }
}

/** A crop of the selector's box with pad around it, kept inside the viewport. */
function cropOf(box, shot) {
  const x = Math.max(0, Math.floor(box.x - shot.pad)), y = Math.max(0, Math.floor(box.y - shot.pad));
  const right = Math.min(shot.width, Math.ceil(box.x + box.width + shot.pad)), bottom = Math.min(shot.height, Math.ceil(box.y + box.height + shot.pad));
  if (right - x < 1 || bottom - y < 1) throw new Error(`${shot.selector} is outside the viewport`);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Takes a normalized list's shots in order through `openPage({ width,
 * height, device })`, which returns a HeadlessPage the run closes. A shot uses
 * the browser of the shot before it when they share a viewport and a device, and so its
 * storage; a fresh shot, or a new viewport, opens another. Each shot
 * navigates, waits, runs its steps, then captures its crop. `onPage` sees
 * each page as it opens, so a caller can close it on a signal.
 */
export async function takeShots(shots, { directory, openPage, stamp = utcStamp(), onPage = () => {}, onResult = () => {} }) {
  const results = [];
  const groups = [];
  for (const shot of shots) {
    const last = groups.at(-1)?.at(-1);
    if (last && !shot.fresh && last.width === shot.width && last.height === shot.height && last.device === shot.device) groups.at(-1).push(shot);
    else groups.push([shot]);
  }
  const consoleErrors = [];
  for (const group of groups) {
    const { width, height, device } = group[0];
    const page = await openPage({ width, height, device });
    onPage(page);
    try {
      for (const shot of group) {
        let result;
        const printed = [];
        try {
          await page.navigate(shot.url);
          await settle(page, shot.wait, shot.timeoutMs, shot.freeze, shot.hide);
          if (shot.steps.length) {
            for (const step of shot.steps) await runStep(page, step, shot, printed);
            await settle(page, undefined, shot.timeoutMs, shot.freeze, shot.hide);
          }
          const clip = shot.selector ? cropOf(await page.evaluate(boxExpression(shot.selector)), shot) : undefined;
          const bytes = await page.screenshot(clip || shot.scale !== 1 ? { ...(clip ? { clip } : {}), scale: shot.scale } : undefined);
          result = { ...await saveShot(directory, shot.name, bytes, { stamp }), size: pngSize(bytes), printed };
        } catch (error) {
          result = { name: shot.name, status: "failed", error: error instanceof Error ? error.message : String(error), printed };
          // What the page showed when it failed, whole, to see why; replaced by the next failure, never archived.
          try {
            const file = path.join(directory, "failed", `${shot.name}.png`);
            await mkdir(path.dirname(file), { recursive: true });
            await writeFile(file, await page.screenshot());
            result.path = file;
          } catch {}
        }
        results.push(result);
        onResult(result);
      }
      for (const entry of page.captureEvidence().console) if (entry.level === "error" && consoleErrors.length < 20 && !consoleErrors.includes(entry.text)) consoleErrors.push(entry.text);
    } finally {
      await page.close();
      onPage(null);
    }
  }
  return { stamp, results, consoleErrors };
}

const escape = text => String(text).replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

/** A page beside the shots for a person to review a run: what changed, next to what it was, then what is new, failed or unchanged. */
export async function writeReview(directory, run) {
  const relative = file => path.relative(directory, file).split(path.sep).map(encodeURIComponent).join("/");
  const order = { changed: 0, new: 1, failed: 2, unchanged: 3 };
  const rows = [...run.results].sort((a, b) => order[a.status] - order[b.status]).map(result => {
    const images = result.status === "failed"
      ? `<p class="error">${escape(result.error)}</p>` + (result.path ? `<figure><img src="${relative(result.path)}" alt="${escape(result.name)} when it failed" loading="lazy"><figcaption>the page when it failed</figcaption></figure>` : "")
      : `<figure><img src="${relative(result.path)}" alt="${escape(result.name)} now" loading="lazy"><figcaption>now</figcaption></figure>`
        + (result.previous ? `<figure><img src="${relative(result.previous)}" alt="${escape(result.name)} before" loading="lazy"><figcaption>before</figcaption></figure>` : "");
    return `<section class="${result.status}"><h2>${escape(result.name)} <span>${result.status}</span></h2><div>${images}</div></section>`;
  }).join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Screenshots ${escape(run.stamp)}</title>
<style>
:root { color-scheme: light dark; --line: #8884; }
body { margin: 0 auto; padding: 16px; max-width: 1400px; font: 14px system-ui, sans-serif; background: Canvas; color: CanvasText; }
section { margin: 0 0 20px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; }
section.unchanged { opacity: 0.7; }
h2 { margin: 0 0 8px; font-size: 15px; }
h2 span { font-weight: 400; opacity: 0.7; }
section > div { display: flex; flex-wrap: wrap; gap: 12px; }
figure { margin: 0; }
img { display: block; max-width: 100%; border: 1px solid var(--line); }
figcaption { opacity: 0.7; }
.error { color: #d33; }
</style></head>
<body><h1>Screenshots, ${escape(run.stamp)}</h1>
${run.consoleErrors?.length ? `<section class="failed"><h2>Console errors</h2><pre>${escape(run.consoleErrors.join("\n"))}</pre></section>` : ""}
${rows}
</body></html>
`;
  const file = path.join(directory, "index.html");
  await writeFile(file, html);
  return file;
}
