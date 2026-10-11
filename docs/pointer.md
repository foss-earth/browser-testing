# Native primary pointer

`page.clickAt(x, y)` and `page.dragAt(fromX, fromY, toX, toY, options?)` send
native primary-button input through CDP, WebDriver BiDi or WebKit. Coordinates
must be finite numbers inside the configured viewport; they are rounded to a
pixel. Drag options accept only `steps` (integer 1..20, default 5) and `durationMs`
(integer 0..1000, default 250). Protocol commands keep the injected page timeout.
Drag duration describes the requested input timing in addition to command time.

Keyboard and pointer calls on a page share one queue. Every attempted click or
drag releases the primary button on success or failure. Input errors enter
bounded sanitized console evidence. Callers still await `page.close()` in
`finally` and check that browser exit was graceful.

The generic pointer fixture verifies trusted click and drag events using an
explicit existing browser/tool selection. `FOSS_BROWSER_POINTER_INPUT` names a
JSON input with `browser`, fresh `outputRoot` and injected page `options`. Native
fixtures require a coordinator grant; they never acquire tools or import an
application. The source fixture and input API remain unqualified until the
recorded protocol/type/native checks pass.
