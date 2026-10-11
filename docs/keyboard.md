# Native control keys

The development-only page helper exposes `await page.pressKey(key)` through
`@foss-earth/browser-testing/page`. Supported controls are `Tab`, `ShiftTab`,
`Enter`, `Space`, `Escape`, the four `Arrow` keys, `Home`, `End`, `PageUp` and
`PageDown`. It sends browser-native CDP, WebDriver BiDi or WebKit keyboard events.
Calls on the same page are serialized. Every attempted key press releases its
keys, including Shift, when dispatch fails. Protocol commands retain the page's
finite command timeout, and dispatch errors appear in bounded sanitized evidence.

`touch()` retains its original Shift-only behavior. Keyboard input does not
change browser ownership or the requirement to await `page.close()` in `finally`.

`fixtures/keyboard.html` is a generic disposable proof fixture. The opt-in native
tests use explicitly supplied existing browser binaries or the reviewed
Playwright/core 1.55.0 and WebKit 2203 tool contract. They verify actual Tab and
ShiftTab focus movement and trusted Enter/Space button activation. Tests do not
download tools. Native runs require a coordinator grant; source preparation is
not browser qualification.
