/** Bounded process observation shared by the original pipe/BiDi adapters. */
export function bounded(promise, timeoutMs, message) {
  validateTimeout(timeoutMs);
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

export function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120000) throw new Error("Browser deadline must be an integer from 1 to 120000 ms");
  return value;
}

export function resolveTimeouts(values = {}) {
  const defaults = { startupMs: 30000, commandMs: 15000, closeMs: 10000, exitMs: 5000 };
  const result = { ...defaults, ...values };
  for (const [name, value] of Object.entries(result)) {
    if (!(name in defaults) || !Number.isSafeInteger(value) || value < 1 || value > 120000) {
      throw new Error(`Invalid browser timeout ${name}`);
    }
  }
  return result;
}

export function observeProcess(child, name, record = () => {}) {
  let result;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  const finish = value => {
    if (result) return;
    result = value;
    record({ event: "exit", ...value });
    resolveExit(value);
  };
  child.on("exit", (code, signal) => finish({ code, signal }));
  // A failed spawn has no process to await; an error on a running process does.
  child.on("error", () => { if (child.pid == null) finish({ code: null, signal: null, spawnFailed: true }); });
  if (child.exitCode != null || child.signalCode != null) finish({ code: child.exitCode, signal: child.signalCode });
  return {
    get exited() { return result !== undefined; },
    exitPromise,
    waitForExit(timeoutMs = 10000) {
      return bounded(exitPromise, timeoutMs, `${name} did not exit within ${timeoutMs} ms`);
    },
  };
}

/** Wait the entire graceful allowance before signals; observe exit after either signal. */
export async function shutdownProcess(child, state, closeProtocol, timeouts, record = () => {}) {
  if (state.exited) return state.exitPromise;
  const started = Date.now();
  if (closeProtocol) {
    try {
      await bounded(Promise.resolve().then(closeProtocol), timeouts.closeMs, "Browser close protocol timed out");
    } catch { /* Browser may close its transport before its acknowledgement. */ }
  }
  if (state.exited) return state.exitPromise;
  const remaining = Math.max(1, timeouts.closeMs - (Date.now() - started));
  try { return await state.waitForExit(remaining); } catch { /* Only this actual deadline permits a signal. */ }
  record({ event: "graceful-close-timeout" });
  if (state.exited) return state.exitPromise;
  record({ event: "signal", signal: "SIGTERM" });
  child.kill("SIGTERM");
  try { return await state.waitForExit(timeouts.exitMs); } catch { /* Bound stubborn-process cleanup as well. */ }
  if (state.exited) return state.exitPromise;
  record({ event: "signal", signal: "SIGKILL" });
  child.kill("SIGKILL");
  return state.waitForExit(timeouts.exitMs);
}

/** Public Playwright BrowserServer gives owned process observation without private fields. */
export async function connectOwnedBrowserServer(server, connect, timeouts, record = () => {}) {
  const child = server.process();
  const state = observeProcess(child, "WebKit", record);
  let closing;
  const close = () => {
    closing ??= (async () => {
      const started = Date.now();
      try { await bounded(server.close(), timeouts.closeMs, "WebKit graceful close timed out"); }
      catch { /* A protocol disconnect is not proof of process exit. */ }
      if (!state.exited) {
        const remaining = Math.max(1, timeouts.closeMs - (Date.now() - started));
        try { await state.waitForExit(remaining); } catch {
          record({ event: "graceful-close-timeout" });
          if (!state.exited) {
            record({ event: "forced-close" });
            // Public kill() cleans the owned process group and loopback server, then awaits exit.
            await bounded(server.kill(), timeouts.exitMs, "WebKit forced close timed out");
          }
        }
      }
      return state.waitForExit(timeouts.exitMs);
    })();
    return closing;
  };
  try {
    const endpoint = new URL(server.wsEndpoint());
    if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("WebKit transport must be loopback");
    const instance = await bounded(connect(server.wsEndpoint()), timeouts.startupMs, "WebKit connection startup timed out");
    return { instance, pid: child.pid, transportOrigin: endpoint.origin, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "WebKit connection and owned-process cleanup failed"); }
    throw error;
  }
}
