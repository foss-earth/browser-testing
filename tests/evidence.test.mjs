import test from "node:test";
import assert from "node:assert/strict";
import { createEvidence, sanitizeText, sanitizeUrl } from "../src/evidence.mjs";
import { resolveTimeouts } from "../src/lifecycle.mjs";

test("Evidence redacts URL credentials/query/hash and private paths without retaining bodies", () => {
  assert.equal(sanitizeUrl("https://name:pass@fixture.invalid/tiles?key=secret#secret"), "https://fixture.invalid/tiles");
  assert.equal(sanitizeUrl("file:///Users/private/key"), "[file URL]");
  const text = sanitizeText("Bearer sk-private123 api_key=abc /Users/private/file https://host.invalid/path?secret=yes");
  assert(!text.includes("private123")); assert(!text.includes("=abc")); assert(!text.includes("/Users/")); assert(!text.includes("?secret"));
  const evidence = createEvidence({ console: 1, network: 1, lifecycle: 1 });
  evidence.add("console", { level: "info", text: "first" }); evidence.add("console", { level: "info", text: "second" });
  evidence.add("network", { phase: "request", url: "https://fixture.invalid/path?token=private", headers: { Authorization: "private" }, body: "private" });
  evidence.add("lifecycle", { event: "exit", code: 0, signal: null });
  const first = evidence.snapshot("fixture", { browser: "chrome", mode: "live", workers: true });
  assert.equal(first.dropped.console, 1); assert.equal(first.console[0].text, "first");
  assert(!JSON.stringify(first).includes("private"));
  first.console[0].text = "mutated";
  assert.equal(evidence.snapshot("fixture", {}).console[0].text, "first");
});

test("Nonfinite, unbounded and unknown timeout/evidence limits fail before a process", () => {
  assert.throws(() => resolveTimeouts({ startupMs: Infinity }));
  assert.throws(() => resolveTimeouts({ commandMs: 0 }));
  assert.throws(() => resolveTimeouts({ unknown: 1 }));
  assert.throws(() => createEvidence({ console: 10001 }));
});

test("Arbitrary bearer and complete authorization values do not escape text evidence", () => {
  for (const raw of ["Bearer ordinaryBearer123", "Authorization: Bearer ordinaryBearer123", "authorization=Basic ordinaryBasic123"]) {
    const result = sanitizeText(raw);
    assert(!result.includes("ordinaryBearer123"));
    assert(!result.includes("ordinaryBasic123"));
    assert(result.includes("[redacted]"));
  }
});
