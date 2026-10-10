# Browser tool and lifecycle contract

Use Node 22 or newer and one sequential browser/check process. Explicitly inject
binary, fresh ignored profile, tool root, browser cache and private output paths.
No private machine path is a public default. Browser-specific command-line
arguments/preferences are caller policy. Existing retained tools may be used
read-only; acquisition, version changes and additional backends need their own
recorded scope. Never automatically download, replace binaries, clear caches,
install globally or kill an unrelated process.

Chrome closes through `Browser.close` and waits for actual exit before success.
Its graceful shutdown removes its own operating-system code-sign clone. A timeout
is a failed cleanup, not an ordinary successful shutdown. Failure cleanup is
bounded and restricted to the process the helper spawned. Firefox handles
pre-session startup/socket/session failures through the same owned lifecycle;
no abandoned browser may be hidden behind a startup rejection. Record cleanup
failures even when an earlier assertion failed.

Protocol/evidence storage uses named finite bounds. Evidence strips URL
credentials/query secrets, local paths and credential-looking messages before
serialization, and truncates/limits console, network and lifecycle collections.
Raw screenshots are not text sanitization targets; callers own their storage and
rights. A package consumer must not log raw browser stderr or environment data.

Public pure imports do not import Playwright or spawn any process. WebKit only
loads the supplied Playwright1.55.0/core1.55.0 root when selected and checks the
reviewed WebKit2203 metadata/cache. There is no compatible-latest substitution.
Playwright is Microsoft-owned third-party tooling with its upstream license;
this extraction does not bundle or relicense it. Installed Chrome/Firefox/WebKit
products retain their original ownership and terms.

In interception mode, Chrome can route worker requests when explicitly selected;
WebKit service workers are blocked and Firefox routing semantics are recorded.
Worker acceptance needs an explicit live local-origin test with actual
registration/controller/scriptURL/scope evidence. Interception-only fixtures
cannot claim that an application worker controlled a page or left the landing
root alone. Browser GPU/software facts come from the real application/backend;
unknown remains unknown.

WebKit uses the pinned tool public `launchServer`/`connect` APIs, with an owned
ephemeral loopback transport and observed child PID. Its endpoint token is
omitted from evidence. Caller deadlines bound page/context/route setup as well
as evaluation. Graceful shutdown waits for actual exit; the public owned-server
kill path is used only after its deadline. Browser child temporary directories
stay under the injected profile without changing the parent temporary directory.
Playwright owns WebKit's ephemeral profile; this is not a persistent user profile.

Both built-in protocol adapters bound incoming text to8MiB and reject malformed
JSON/envelopes through pending-command failures, preserving startup cleanup.
Forced cleanup is an observed recovery result. Application acceptance must reject
normal runs with signals or graceful-close-timeout/forced-close evidence.
