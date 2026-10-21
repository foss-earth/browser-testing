# Review screenshots

`scripts/shots.mjs` takes named screenshots of a running page in headless
Chrome, so you and the person you work with can review a UI change. It keeps
each run cheap: one browser for many shots, crops instead of whole pages, and a
report of what changed so nobody has to look at the rest.

## One shot

```sh
node ~/gh/foss-earth/browser-testing/scripts/shots.mjs \
  --url http://localhost:5173/app/ --name settings/open \
  --wait 'document.querySelector(".app-ready")' \
  --click '#settingsButton' --print 'document.title' \
  --selector '.settings-window' --scale 2
```

Steps run in the order given: `--step EXPR` evaluates an expression (awaited),
`--click CSS` clicks the center of the first visible match, `--key NAME`
presses a control key (`Tab`, `ShiftTab`, `Enter`, `Space`, `Escape`, the
arrows, `Home`, `End`, `PageUp`, `PageDown`), and `--print EXPR` prints the
expression's JSON. Other flags: `--width`, `--height` (1100 by 700),
`--scale`, `--pad`, `--hide CSS`, `--no-freeze` and `--out DIR`.

## A list

For more than one shot, write a list and run it with one command. A `.mjs`
list's default export or a `.json` file is the list. Keep throwaway lists in
the repository's gitignored `build/`.

```js
// build/review.mjs
const open = [`document.querySelector(".settings") || document.querySelector("#settings").click()`, { wait: "document.querySelector('.settings')" }];
export default {
  base: "http://localhost:5173/app/",
  width: 1000, height: 700,
  wait: `document.querySelector(".app-ready")`, // every shot waits for this
  hide: "canvas, .fps",                          // live parts that change every image
  shots: [
    { name: "settings/dark", url: "?theme=dark", steps: open, selector: ".settings" },
    { name: "settings/light", url: "?theme=light", steps: open, selector: ".settings" },
    { name: "settings/changed", steps: [...open, { click: "#frameRate .switch" }, { print: "document.querySelectorAll('.reset:not([hidden])').length" }], selector: "#frameRate", scale: 2 },
    { name: "first-visit", fresh: true },
  ],
};
```

```sh
node ~/gh/foss-earth/browser-testing/scripts/shots.mjs build/review.mjs
node ~/gh/foss-earth/browser-testing/scripts/shots.mjs build/review.mjs --only settings/changed
```

A shot has a `name` (letters, digits, `.`, `_`, `-`, in `/` folders), a `url`
relative to `base`, `steps`, and a `selector` to crop to the box around every
visible match, plus `pad` pixels. Without a `selector` it takes the whole
viewport. Steps are expression strings or `{ click }`, `{ key }`, `{ wait }`
and `{ print }`. The list's `width`, `height`, `scale`, `pad`, `freeze`,
`timeoutMs`, `wait` and `hide` are its shots' defaults. Unknown keys are an
error, so a typo fails at once instead of after a browser starts.

Before each shot the page must make `wait` true. Then it waits for fonts and
two frames, and animations, transitions and the caret are stopped (`freeze`).
Consecutive shots with the same viewport share one browser, and so share its
storage. A shot that must not see what an earlier one left behind, such as a
window that a later page load restores, sets `fresh: true`, or its steps check
before they act, as `open` does above. A page that reloads itself while it
starts is waited for again in the new document.

## What it writes

Everything goes under `--out`, by default `build/shots` in the current
directory:

| Path | What |
| --- | --- |
| `<name>.png` | the latest image of each shot |
| `archive/<UTC time>/<name>.png` | the image a changed shot replaced, under the time of the run that changed it, such as `2026-10-21T155203Z` |
| `failed/<name>.png` | the whole page when that shot failed |
| `index.html` | the run to review: changed shots beside what they were, then new, failed and unchanged ones, and console errors |
| `.cache/` | Chrome's HTTP cache, shared by runs so pages load warm; map tiles can make it a few hundred MB, and it is safe to delete |
| `.profiles/` | each browser's fresh profile, removed when it closes |

An image with the same bytes is left alone, so its file date says when it last
changed. The output names what happened:

```
new        build/shots/settings/changed.png 618x416
changed    build/shots/settings/dark.png 640x520  (before: build/shots/archive/2026-10-21T155203Z/settings/dark.png)
unchanged  settings/light, first-visit
print      settings/changed: 1
failed     settings/x: Nothing visible matches .x  (page: build/shots/failed/settings/x.png)
console    TypeError: ...
review     build/shots/index.html  (2.1 s)
```

It exits with 1 when a shot failed. Nothing removes archived images; delete
old `archive/` folders by hand when they are no longer useful.

## Working efficiently

- **Keep one dev server running** in the background for the whole task, and
  rerun the list after each change. Don't build or start a server per shot.
- **Put every shot in one list** and run it once: Chrome starts once per
  viewport, about a second, rather than once per shot. Use `--only` to retake a
  few.
- **Crop to what changed** with `selector`. A small image is quicker to take,
  compare and look at. An image costs about width × height / 750 tokens to
  view, so a 1100 by 700 viewport is about 1000 tokens and a 300 by 200 crop is
  about 80. Use `scale: 2` only where small detail matters: it makes four
  times as many pixels.
- **Wait for a condition, never a fixed time.** Wait for the element or state
  the shot needs, and for a signal that the app has attached its handlers, not
  merely for something to have drawn.
- **Hide or crop out what moves**: frame rates, clocks, live maps and video.
  Then an unchanged UI reports `unchanged` and doesn't need another look.
- **Look only at new and changed images.** Read a number or a label with a
  `print` step rather than from an image.
- **Hand the person the review**: the paths of the new and changed images, or
  `build/shots/index.html`, so they can spot what you missed.

## Chrome

It uses `CHROME_BINARY`, or the standard macOS install of Google Chrome.
Interrupting a run with Ctrl-C still closes Chrome. If Chrome was killed some
other way, run `scripts/chrome-clones.sh --clean` (see the
[README](../README.md#development)).

The same functions are exported from `@foss-earth/browser-testing/shots`
(`normalizeShotList`, `takeShots`, `saveShot`, `writeReview`, `utcStamp`,
`pngSize`) for a script that opens its pages its own way.
