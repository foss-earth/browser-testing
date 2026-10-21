#!/usr/bin/env node
// Takes review screenshots in headless Chrome. See docs/screenshots.md.
//
//   node shots.mjs <list.mjs|list.json> [--only name,name] [--out dir]
//   node shots.mjs --url URL [--name NAME] [--selector CSS] [--wait EXPR] [--hide CSS] [--width N] [--height N]
//                  [--scale N] [--pad N] [--timeout MS] [--no-freeze] [--out dir] [--step EXPR | --click CSS | --key KEY | --print EXPR]...
//
// Shots go to --out (build/shots under the current directory by default). An
// unchanged image is left alone; a changed one moves the old image to
// <out>/archive/<UTC time>/ first. It prints what changed and writes
// <out>/index.html to compare them. Steps run in the order given. Each browser
// starts with a fresh profile, so no site storage carries over from an earlier
// run, and shares one HTTP cache, so pages load warm. Chrome comes from
// CHROME_BINARY, or the standard macOS install.
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openHeadlessPage } from "../src/headlessPage.mjs";
import { normalizeShotList, takeShots, utcStamp, writeReview } from "../src/shots.mjs";

const STEP_FLAGS = { step: step => step, click: click => ({ click }), key: key => ({ key }), print: print => ({ print }) };
const { values, positionals, tokens } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: {
    out: { type: "string", default: "build/shots" },
    only: { type: "string", multiple: true },
    url: { type: "string" },
    name: { type: "string" },
    selector: { type: "string" },
    wait: { type: "string" },
    hide: { type: "string" },
    ...Object.fromEntries(Object.keys(STEP_FLAGS).map(flag => [flag, { type: "string", multiple: true }])),
    width: { type: "string" },
    height: { type: "string" },
    scale: { type: "string" },
    pad: { type: "string" },
    timeout: { type: "string" },
    "no-freeze": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || (positionals.length === 0 && !values.url)) {
  console.log("Usage: shots.mjs <list.mjs|list.json> [--only a,b] [--out dir]\n       shots.mjs --url URL [--name NAME] [--selector CSS] [--wait EXPR] [--hide CSS] [--width N] [--height N] [--scale N] [--pad N] [--timeout MS] [--no-freeze] [--out dir] [--step EXPR | --click CSS | --key KEY | --print EXPR]...");
  process.exit(values.help ? 0 : 2);
}

async function loadList() {
  if (values.url) {
    const number = key => (values[key] === undefined ? {} : { [key]: Number(values[key]) });
    const text = key => (values[key] === undefined ? {} : { [key]: values[key] });
    const steps = tokens.filter(token => token.kind === "option" && token.name in STEP_FLAGS).map(token => STEP_FLAGS[token.name](token.value));
    return { shots: [{
      name: values.name ?? "shot", url: values.url, steps,
      ...text("selector"), ...text("wait"), ...text("hide"),
      ...number("width"), ...number("height"), ...number("scale"), ...number("pad"),
      ...(values.timeout === undefined ? {} : { timeoutMs: Number(values.timeout) }),
      ...(values["no-freeze"] ? { freeze: false } : {}),
    }] };
  }
  const file = path.resolve(positionals[0]);
  // A JSON list is imported as JSON; a module's default export is the list.
  const module = await import(pathToFileURL(file).href, file.endsWith(".json") ? { with: { type: "json" } } : undefined);
  return module.default;
}

const chrome = process.env.CHROME_BINARY ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "");
try { await access(chrome); } catch { console.error(`No Chrome at "${chrome}"; set CHROME_BINARY.`); process.exit(2); }

let shots = normalizeShotList(await loadList());
if (values.only) {
  // --only a,b and --only a --only b are the same.
  const only = new Set(values.only.flatMap(names => names.split(",")));
  shots = shots.filter(shot => only.has(shot.name));
  if (shots.length === 0) { console.error(`No shot is named ${[...only].join(", ")}`); process.exit(2); }
}
const directory = path.resolve(values.out);
const stamp = utcStamp();
const timeoutMs = Math.max(...shots.map(shot => shot.timeoutMs));
const started = Date.now();

// A stopped run still closes Chrome, so it leaves no code-sign clone behind.
let open = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`${signal}: closing Chrome`);
    void Promise.resolve(open?.close()).finally(() => process.exit(130));
  });
}

let browsers = 0;
async function openPage({ width, height }) {
  const profile = path.join(directory, ".profiles", `${stamp}-${++browsers}`);
  await mkdir(profile, { recursive: true });
  const page = await openHeadlessPage("chrome", profile, {
    mode: "live", width, height, binary: chrome,
    chromeArgs: [`--disk-cache-dir=${path.join(directory, ".cache")}`],
    timeouts: { startupMs: 30000, commandMs: Math.min(120000, timeoutMs + 10000), closeMs: 10000, exitMs: 5000 },
  });
  const close = page.close;
  // The profile goes once Chrome has exited; a failed close keeps it to look at.
  return Object.assign(page, { close: async () => { const exit = await close(); await rm(profile, { recursive: true, force: true }); return exit; } });
}

const show = file => path.relative(process.cwd(), file) || file;
let run;
try {
  run = await takeShots(shots, {
    directory,
    stamp,
    openPage,
    onPage: page => { open = page; },
    onResult: result => {
      const size = result.size ? ` ${result.size.width}x${result.size.height}` : "";
      for (const text of result.printed ?? []) console.log(`print      ${result.name}: ${text}`);
      if (result.status === "failed") console.log(`failed     ${result.name}: ${result.error.split("\n")[0]}${result.path ? `  (page: ${show(result.path)})` : ""}`);
      else if (result.status !== "unchanged") console.log(`${result.status.padEnd(10)} ${show(result.path)}${size}${result.previous ? `  (before: ${show(result.previous)})` : ""}`);
    },
  });
} catch (error) {
  // Chrome failed to start or close: a killed Chrome leaves a 2 GB clone behind.
  console.error(`${error instanceof Error ? error.message : error}\nIf Chrome was killed, run ${path.join(import.meta.dirname, "chrome-clones.sh")} --clean`);
  process.exit(1);
}
const unchanged = run.results.filter(result => result.status === "unchanged").map(result => result.name);
if (unchanged.length) console.log(`unchanged  ${unchanged.join(", ")}`);
for (const text of run.consoleErrors) console.log(`console    ${text.split("\n")[0].slice(0, 300)}`);
console.log(`review     ${show(await writeReview(directory, run))}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(run.results.some(result => result.status === "failed") ? 1 : 0);
