import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeShotList, pngSize, saveShot, takeShots, utcStamp, writeReview } from "../src/shots.mjs";

// Scratch stays in the package's gitignored build/.
const scratch = fileURLToPath(new URL("../build/", import.meta.url));
async function withDirectory(run) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "shots-"));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** The 24 bytes a PNG starts with: signature, then an IHDR chunk naming its size. */
function png(width, height, tail = 0) {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); bytes[24] = tail;
  return bytes;
}

test("A run's stamp is its UTC time to the second, in a name that sorts by time", () => {
  assert.equal(utcStamp(new Date(Date.UTC(2026, 9, 21, 15, 52, 3, 456))), "2026-10-21T155203Z");
  assert.match(utcStamp(), /^\d{4}-\d\d-\d\dT\d{6}Z$/);
});

test("A PNG's size comes from its header, from a Buffer or any byte view", () => {
  assert.deepEqual(pngSize(png(618, 416)), { width: 618, height: 416 });
  assert.deepEqual(pngSize(new Uint8Array(png(3, 4))), { width: 3, height: 4 });
  assert.equal(pngSize(Buffer.alloc(10)), null);
  assert.equal(pngSize(Buffer.alloc(30)), null);
});

test("A new shot is written, the same bytes leave it alone and new bytes archive the old image under the run's UTC stamp", () => withDirectory(async directory => {
  const first = await saveShot(directory, "panel/dark", png(2, 2, 1), { stamp: "2026-10-21T150000Z" });
  assert.deepEqual(first, { name: "panel/dark", status: "new", path: path.join(directory, "panel/dark.png") });
  const same = await saveShot(directory, "panel/dark", png(2, 2, 1), { stamp: "2026-10-21T160000Z" });
  assert.equal(same.status, "unchanged");
  await assert.rejects(readdir(path.join(directory, "archive")), { code: "ENOENT" });
  const changed = await saveShot(directory, "panel/dark", png(2, 2, 2), { stamp: "2026-10-21T170000Z" });
  assert.equal(changed.status, "changed");
  assert.equal(changed.previous, path.join(directory, "archive/2026-10-21T170000Z/panel/dark.png"));
  assert.deepEqual(await readFile(changed.previous), png(2, 2, 1));
  assert.deepEqual(await readFile(changed.path), png(2, 2, 2));
}));

test("Shot names stay inside the directory and away from archive/, failed/ and the review page", () => withDirectory(async directory => {
  for (const name of ["../x", "a/../../x", "/abs", "archive/x", "failed/x", "index", "a b", "", "a//b", ".hidden"]) {
    await assert.rejects(saveShot(directory, name, png(1, 1)), /Shot name/, name);
  }
  assert.equal((await saveShot(directory, "app/settings.v2_dark-1", png(1, 1))).status, "new");
}));

test("A list fills its shots from its own defaults, then the package's, and resolves their URLs", () => {
  const [first, second] = normalizeShotList({
    base: "http://localhost:5199/app/", width: 480, wait: "window.ready", hide: ".fps",
    shots: [{ name: "a", url: "?theme=dark", selector: ".panel", steps: ["x()", { click: "#b" }] }, { name: "b", height: 300, hide: ".clock", fresh: true }],
  });
  assert.deepEqual(first, { width: 480, height: 700, scale: 1, pad: 8, freeze: true, timeoutMs: 10000, fresh: false, wait: "window.ready", hide: ".fps",
    name: "a", url: "http://localhost:5199/app/?theme=dark", selector: ".panel", steps: ["x()", { click: "#b" }] });
  assert.equal(second.url, "http://localhost:5199/app/");
  assert.deepEqual([second.width, second.height, second.hide, second.fresh, second.steps], [480, 300, ".clock", true, []]);
});

test("A list with anything unknown, repeated or out of range is refused before a browser starts", () => {
  const shot = { name: "a", url: "http://localhost/" };
  for (const [list, message] of [
    [{ shots: [] }, /non-empty/],
    [{ shots: [shot], viewport: 1 }, /Unknown shot list keys: viewport/],
    [{ shots: [{ ...shot, crop: ".x" }] }, /unknown keys crop/],
    [{ shots: [shot, shot] }, /named twice/],
    [{ shots: [{ ...shot, width: 10.5 }] }, /width/],
    [{ shots: [{ ...shot, scale: 5 }] }, /scale/],
    [{ shots: [{ ...shot, timeoutMs: 200000 }] }, /timeoutMs/],
    [{ shots: [{ ...shot, pad: -1 }] }, /pad/],
    [{ shots: [{ ...shot, fresh: "yes" }] }, /fresh/],
    [{ shots: [{ ...shot, steps: [{ click: "#a", key: "Tab" }] }] }, /a step is/],
    [{ shots: [{ ...shot, steps: [{ tap: "#a" }] }] }, /a step is/],
    [{ shots: [{ ...shot, selector: 3 }] }, /selector must be a string/],
  ]) assert.throws(() => normalizeShotList(list), message);
});

/** A page that answers the run's expressions without a browser and records what it was asked. */
function fakePage(log, { fail = [], box = { x: 100, y: 50, width: 200, height: 40 } } = {}) {
  let url = "";
  return {
    async navigate(next) { url = next; log.push(`navigate ${new URL(next).pathname}`); },
    async evaluate(expression) {
      if (expression.includes("performance.now() + ")) { log.push("settle"); return true; }
      if (expression.includes("getBoundingClientRect")) {
        if (fail.includes(url)) throw new Error("Nothing visible matches .panel");
        log.push(expression.includes(".slice(0, 1)") ? "box first" : "box all");
        return box;
      }
      if (expression.includes("JSON.stringify(await")) return JSON.stringify(expression.length > 0 ? "printed" : "");
      log.push(`eval ${expression}`);
      return undefined;
    },
    async clickAt(x, y) { log.push(`click ${x},${y}`); },
    async pressKey(key) { log.push(`key ${key}`); },
    async screenshot(options) { log.push(`screenshot ${JSON.stringify(options ?? null)}`); return png(options?.clip?.width ?? 1100, options?.clip?.height ?? 700, url.length % 256); },
    captureEvidence() { return { console: [{ level: "error", text: "boom" }, { level: "info", text: "fine" }, { level: "error", text: "boom" }] }; },
    async close() { log.push("close"); },
  };
}

test("Shots run in order in one browser per viewport, fresh shots and new viewports open another, and a failure keeps the page", () => withDirectory(async directory => {
  const log = [];
  const opened = [];
  const results = [];
  const shots = normalizeShotList({ base: "http://localhost/", shots: [
    { name: "a", url: "a", selector: ".panel", scale: 2, steps: [{ click: "#open" }, "go()", { key: "Escape" }, { print: "document.title" }] },
    { name: "b", url: "b" },
    { name: "c", url: "c", fresh: true, selector: ".panel" },
    { name: "d", url: "d", width: 640 },
  ] });
  const run = await takeShots(shots, {
    directory, stamp: "2026-10-21T150000Z",
    openPage: async viewport => { opened.push(viewport); log.push("open"); return fakePage(log, { fail: ["http://localhost/c"] }); },
    onResult: result => results.push(result.name),
  });
  assert.deepEqual(opened, [{ width: 1100, height: 700 }, { width: 1100, height: 700 }, { width: 640, height: 700 }]);
  assert.deepEqual(results, ["a", "b", "c", "d"]);
  assert.deepEqual(log.slice(0, 14), [
    "open", "navigate /a", "settle", "box first", "click 200,70", "eval go()", "key Escape", "settle", "box all",
    `screenshot ${JSON.stringify({ clip: { x: 92, y: 42, width: 216, height: 56 }, scale: 2 })}`,
    "navigate /b", "settle", "screenshot null", "close",
  ]);
  const byName = Object.fromEntries(run.results.map(result => [result.name, result]));
  assert.equal(byName.a.status, "new");
  assert.deepEqual(byName.a.size, { width: 216, height: 56 });
  assert.deepEqual(byName.a.printed, ['"printed"']);
  assert.equal(byName.c.status, "failed");
  assert.match(byName.c.error, /Nothing visible/);
  assert.equal(byName.c.path, path.join(directory, "failed/c.png"));
  assert.deepEqual(run.consoleErrors, ["boom"]);
  assert.equal(log.filter(entry => entry === "close").length, 3);

  const review = await readFile(await writeReview(directory, run), "utf8");
  assert(review.indexOf(">a <span>new") < review.indexOf(">c <span>failed"));
  assert.match(review, /src="failed\/c\.png"/);
  assert.match(review, /<pre>boom<\/pre>/);
}));

test("A crop stays inside the viewport and one wholly outside it fails", () => withDirectory(async directory => {
  const run = await takeShots(normalizeShotList({ shots: [{ name: "edge", url: "http://localhost/", selector: ".x", width: 300, height: 200 }] }), {
    directory, openPage: async () => fakePage([], { box: { x: -20, y: 190, width: 400, height: 50 } }),
  });
  assert.deepEqual(run.results[0].size, { width: 300, height: 18 });
  const outside = await takeShots(normalizeShotList({ shots: [{ name: "away", url: "http://localhost/", selector: ".x", width: 300, height: 200, pad: 0 }] }), {
    directory, openPage: async () => fakePage([], { box: { x: 400, y: 10, width: 10, height: 10 } }),
  });
  assert.equal(outside.results[0].status, "failed");
  assert.match(outside.results[0].error, /outside the viewport/);
}));

test("A changed shot is reviewed first, beside its archived image, and names are escaped", () => withDirectory(async directory => {
  await writeFile(path.join(directory, "x.png"), png(1, 1));
  const run = { stamp: "2026-10-21T150000Z", consoleErrors: [], results: [
    { name: "plain", status: "unchanged", path: path.join(directory, "plain.png") },
    { name: "x", status: "changed", path: path.join(directory, "x.png"), previous: path.join(directory, "archive/2026-10-21T150000Z/x.png") },
    { name: "bad", status: "failed", error: "<script>" },
  ] };
  const review = await readFile(await writeReview(directory, run), "utf8");
  assert(review.indexOf(">x <span>changed") < review.indexOf(">bad <span>failed"));
  assert(review.indexOf(">bad <span>failed") < review.indexOf(">plain <span>unchanged"));
  assert.match(review, /src="archive\/2026-10-21T150000Z\/x\.png"/);
  assert(!review.includes("<script>"));
}));
