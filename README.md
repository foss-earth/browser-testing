# @foss-earth/browser-testing

Generic Node helpers for running development tests in Chrome, Firefox and
WebKit. The package imports no application, renderer or flight code. Each
application owns its assertions, routes and fixtures. The FOSS Earth app uses
this package only as a development dependency for its browser tests; it is
not part of any runtime.

## API

The root and `./core` export the same helpers: `openHeadlessChrome`,
`evaluate`, `waitForExpression`, `openHeadlessFirefox` and
`openHeadlessPage`. `./chrome`, `./firefox` and `./page` expose the individual
adapters, each with declaration files. Chrome's handle also has a
`waitForExit` method.

Pass explicit paths for the browser binary, profile, tools, cache and
artifacts. Never use a personal browser profile.

```js
import { openHeadlessPage } from '@foss-earth/browser-testing/page';

const page = await openHeadlessPage('chrome', profileDirectory, {
  mode: 'live', width: 1100, height: 700, binary: chromeBinary,
  workers: true,
  timeouts: { startupMs: 30000, commandMs: 15000, closeMs: 10000, exitMs: 5000 },
});
try {
  await page.navigate(applicationUrl);
  // The application makes its own assertions and writes its own artifacts.
  const image = await page.screenshot();
  const evidence = page.captureEvidence();
} finally {
  await page.close();
}
```

A missing browser or backend is an error. The helpers never report a pass or
quietly pick another browser. `captureEvidence()` returns bounded, sanitized
protocol data. Screenshots are returned as bytes and can contain application
content, so store them only in an approved private directory.

## Modes and tools

- **Interception mode** answers requests through an injected `respond`
  callback. A request with no response is blocked. WebKit interception blocks
  service workers, so it cannot be used to test worker scope or caching.
- **Live mode** uses the named local origin and real workers. The application
  must set up and control its own fixtures, server and network policy.

Chrome and Firefox use Node builtins and an installed binary you select.
WebKit loads an existing Playwright 1.55.0 / playwright-core 1.55.0 tool root
and the WebKit revision 2203 browser cache that you provide. Installing the
package or importing it never downloads a browser, and no tooling or binary is
bundled. See the [tool and lifecycle contract](docs/tool-contract.md), plus the
notes on [keyboard](docs/keyboard.md) and [pointer](docs/pointer.md) input.

WebKit tests do not establish mobile Safari or WebGPU support. Record the actual
browser, product and tool versions and the requested and obtained graphics
backend with your results. The package makes no GPU performance claims.

## Development

Requires Node 22 or later. The package has no `@foss-earth/*` dependencies.
Scripts from `package.json`:

```sh
npm install
npm run check:source   # source syntax checks
npm run typecheck      # strict check of the public declarations
npm test               # node --test
```

`npm run ci` runs all three. No script starts a browser, server or watcher
by itself.

## License

AGPL-3.0-only; see [LICENSE](LICENSE). Separate commercial terms are described
in [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md) and do not change the AGPL
grant. See [NOTICE](NOTICE) for third-party notices. No map, model, image or
browser binary is bundled.

[Code of Conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md) · [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md) ·
[License](LICENSE) · [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md) · [Notices](NOTICE)
