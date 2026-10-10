import type { AdapterOptions, ChromeAdapter } from "./contracts.js";
export type { AdapterOptions, BrowserTimeouts, ChromeAdapter, ExitResult, LifecycleEvidence, ProtocolMessage } from "./contracts.js";
/** Explicit binary or CHROME_BIN; no binary acquisition or browser launch during import. */
export declare function openHeadlessChrome(profileDirectory: string, explicitBinary?: string, extraArgs?: string[], options?: AdapterOptions): Promise<ChromeAdapter>;
export declare function evaluate<T = unknown>(chrome: ChromeAdapter, sessionId: string, expression: string): Promise<T>;
export declare function waitForExpression(chrome: ChromeAdapter, sessionId: string, expression: string, timeoutMs?: number): Promise<void>;
