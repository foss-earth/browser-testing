import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connectOwnedBrowserServer } from "../src/lifecycle.mjs";

const times = { startupMs: 100, commandMs: 100, closeMs: 50, exitMs: 100 };
function fakeServer({ stuckClose = false, resolvesWithoutExit = false } = {}) {
  const child = new EventEmitter();
  child.pid = 12345; child.exitCode = null; child.signalCode = null;
  const events = [];
  const exit = (code, signal) => { child.exitCode = code; child.signalCode = signal; child.emit("exit", code, signal); };
  return {
    events, child,
    process: () => child,
    wsEndpoint: () => "ws://127.0.0.1:41000/private-endpoint-token",
    async close() { events.push({ event: "close", time: Date.now() }); if (stuckClose) await new Promise(() => {}); else if (!resolvesWithoutExit) exit(0, null); },
    async kill() { events.push({ event: "kill", time: Date.now() }); exit(null, "SIGKILL"); },
  };
}

test("Public BrowserServer exposes owned PID/token-free origin and graceful observed exit", async () => {
  const server = fakeServer();
  const owned = await connectOwnedBrowserServer(server, async () => ({ fixture: true }), times);
  assert.equal(owned.pid, 12345); assert.equal(owned.transportOrigin, "ws://127.0.0.1:41000");
  assert.deepEqual(await owned.close(), { code: 0, signal: null });
  assert.deepEqual(server.events.map(value => value.event), ["close"]);
});

test("Public BrowserServer kill occurs only after the close deadline and exit is awaited", async () => {
  const server = fakeServer({ stuckClose: true });
  const owned = await connectOwnedBrowserServer(server, async () => ({}), times);
  assert.deepEqual(await owned.close(), { code: null, signal: "SIGKILL" });
  assert.deepEqual(server.events.map(value => value.event), ["close", "kill"]);
  assert(server.events[1].time - server.events[0].time >= times.closeMs - 5);
});

test("Failed public connect cleans the owned BrowserServer before rejection", async () => {
  const server = fakeServer();
  await assert.rejects(connectOwnedBrowserServer(server, async () => { throw new Error("connect failed"); }, times), /connect failed/);
  assert.equal(server.child.exitCode, 0);
  assert.deepEqual(server.events.map(value => value.event), ["close"]);
});

test("Pre-session connection timeout still performs bounded forced cleanup", async () => {
  const server = fakeServer({ stuckClose: true });
  await assert.rejects(connectOwnedBrowserServer(server, () => new Promise(() => {}), times), /startup timed out/);
  assert.equal(server.child.signalCode, "SIGKILL");
  assert.deepEqual(server.events.map(value => value.event), ["close", "kill"]);
});

test("A resolved close acknowledgement is not substituted for actual owned-process exit", async () => {
  const server = fakeServer({ resolvesWithoutExit: true });
  const owned = await connectOwnedBrowserServer(server, async () => ({}), times);
  assert.deepEqual(await owned.close(), { code: null, signal: "SIGKILL" });
  assert.deepEqual(server.events.map(value => value.event), ["close", "kill"]);
});
