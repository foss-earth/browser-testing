# Shared browser testing

`@foss-earth/browser-testing` supplies generic Node helpers for Chrome, Firefox
and WebKit development tests. Each application owns its assertions, routes,
fixtures and acceptance receipts. The shared package imports no application,
renderer or flight runtime. It is not an application dependency.

This extraction remains a candidate. Reviewed human helper history is attached
while package and browser qualification are pending. The coordinator owns public
publication and remote admission; source preparation does not qualify browsers,
GPU backends or worker behavior.

## Public API

The root and `./core` export the same lazy helpers. `./chrome`, `./firefox` and
`./page` expose the individual adapters with strict declaration files. Existing
Chrome/Firefox/page call signatures are retained; Chrome includes the retained
0SFS `waitForExit` compatibility method. Supply explicit binary, profile, tool,
cache and artifact paths. Never use the person's browser profile.

```js
import { openHeadlessPage } from '@foss-earth/browser-testing/page';

const page = await openHeadlessPage('chrome', profileDirectory, {
  mode: 'live', width: 1100, height: 700, binary: chromeBinary,
  workers: true,
  timeouts: { startupMs: 30000, commandMs: 15000, closeMs: 10000, exitMs: 5000 },
});
try {
  await page.navigate(applicationUrl);
  // The application performs its own assertions and writes its own artifacts.
  const image = await page.screenshot();
  const evidence = page.captureEvidence();
} finally {
  await page.close();
}
```

The helper never treats a missing browser/backend as a pass or silently selects
another browser. `captureEvidence()` returns bounded sanitized protocol evidence;
applications decide the acceptance checks. Screenshots are returned as bytes and
may contain application content, so store them only in the caller's approved
private output directory.

## Modes and tools

Interception mode answers requests through an injected `respond` callback. A
missing response blocks the request. WebKit interception blocks service workers;
that mode cannot qualify worker scope or cache behavior. Live mode uses the named
local origin and real workers; the application must declare and control its
fixture/server/network policy separately.

Chrome and Firefox use Node builtins with explicitly selected installed binaries.
WebKit lazily loads an injected existing Playwright 1.55.0 / playwright-core
1.55.0 tool root and WebKit revision 2203 browser cache. Tool acquisition is a
separate explicit version-bound scratch step. npm install, setup and importing
this package never download browsers. No tooling, binary or private cache is
bundled. See [tool and lifecycle contract](docs/tool-contract.md).

WebKit engine tests do not establish mobile Safari or WebGPU support. Record the
actual browser/product/tool version, requested and obtained backend, and any
software/hardware uncertainty in each application receipt. This package makes no
GPU performance claim.

## Checks and source history

The pending bounded request runs source syntax/strict declarations, causal
protocol/failure/cleanup fixtures, an exact archive-only public consumer,
installed shared conformance and complete intended-ref audits. Real application
checks are separate Chrome, Firefox and WebKit runs. Commands require the recorded
shared test slot; no watch/server/browser command starts implicitly.

Original helper inputs and human commits are recorded in
[SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json). Original recovery source,
tooling, caches and evidence remain intact. [SOURCE_RECEIPT.json](SOURCE_RECEIPT.json)
describes the frozen candidate; the private handoff binds exact requests/logs.

[Code of Conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md) · [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md) ·
[License](LICENSE) · [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md) · [Notices](NOTICE)
