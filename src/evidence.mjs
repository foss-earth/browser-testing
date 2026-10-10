/** Evidence contains no bodies, request headers, raw protocol frames or private paths. */
export function sanitizeText(value, maxLength = 2000) {
  return String(value ?? "")
    .replace(/https?:\/\/[^\s<>"']+/gi, match => sanitizeUrl(match))
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\)[^\s<>"']*/g, "[private-path]")
    .replace(/\b(?:Bearer\s+)?(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization)\s*[:=]\s*[^\r\n,;]+/gi, "$1=[redacted]")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, maxLength);
}

export function sanitizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) return `[${url.protocol.replace(":", "")} URL]`;
    // Query/hash may contain provider credentials. Keep route identity only.
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch { return "[invalid URL]"; }
}

export function createEvidence(limits = {}) {
  const caps = { console: 200, network: 500, lifecycle: 100, textLength: 2000, ...limits };
  for (const [name, value] of Object.entries(caps)) {
    if (!["console", "network", "lifecycle", "textLength"].includes(name) || !Number.isSafeInteger(value) || value < 1 || value > 10000) {
      throw new Error(`Invalid evidence limit ${name}`);
    }
  }
  const rows = { console: [], network: [], lifecycle: [] };
  const dropped = { console: 0, network: 0, lifecycle: 0 };
  return {
    add(kind, value) {
      if (!rows[kind]) throw new Error("Unknown evidence kind");
      let entry;
      if (kind === "console") entry = { level: sanitizeText(value.level, 40), text: sanitizeText(value.text, caps.textLength) };
      else if (kind === "network") entry = {
        phase: sanitizeText(value.phase, 40), url: sanitizeUrl(value.url),
        ...(value.method ? { method: sanitizeText(value.method, 20) } : {}),
        ...(Number.isFinite(value.status) ? { status: value.status } : {}),
        ...(value.error ? { error: sanitizeText(value.error, caps.textLength) } : {}),
      };
      else entry = {
        event: sanitizeText(value.event, 80),
        ...(value.code === null || Number.isInteger(value.code) ? { code: value.code } : {}),
        ...(value.signal === null || typeof value.signal === "string" ? { signal: value.signal === null ? null : sanitizeText(value.signal, 30) } : {}),
      };
      if (rows[kind].length >= caps[kind]) { dropped[kind]++; return; }
      rows[kind].push(entry);
    },
    snapshot(product, facts) {
      return { schemaVersion: 1, product: sanitizeText(product, 200), facts: structuredClone(facts),
        console: structuredClone(rows.console), network: structuredClone(rows.network), lifecycle: structuredClone(rows.lifecycle), dropped: { ...dropped } };
    },
  };
}
