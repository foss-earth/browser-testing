import type { AdapterOptions, FirefoxAdapter } from "./contracts.js";
export type { AdapterOptions, BrowserTimeouts, FirefoxAdapter, ExitResult, LifecycleEvidence, ProtocolMessage } from "./contracts.js";
export declare function openHeadlessFirefox(profileDirectory: string, explicitBinary?: string, prefs?: Record<string, string | number | boolean>, options?: AdapterOptions): Promise<FirefoxAdapter>;
