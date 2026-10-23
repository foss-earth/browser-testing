import type { Buffer } from "node:buffer";

export interface BrowserTimeouts {
  startupMs?: number;
  commandMs?: number;
  closeMs?: number;
  exitMs?: number;
}
export interface ExitResult { code: number | null; signal: string | null; spawnFailed?: boolean }
export interface LifecycleEvidence { event: string; code?: number | null; signal?: string | null }
export interface AdapterOptions { timeouts?: BrowserTimeouts; onLifecycle?: (value: LifecycleEvidence) => void }
export interface ProtocolMessage { id?: number; type?: string; method?: string; params?: Record<string, unknown>; sessionId?: string }
export interface ChromeAdapter {
  readonly pid: number;
  readonly version: { product: string; userAgent: string; protocolVersion?: string; revision?: string; jsVersion?: string };
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
  onEvent(listener: (message: ProtocolMessage) => void): () => void;
  waitForExit(timeoutMs?: number): Promise<ExitResult>;
  close(): Promise<ExitResult>;
}
export interface FirefoxAdapter {
  readonly pid: number;
  readonly session: Record<string, unknown>;
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onEvent(listener: (message: ProtocolMessage) => void): () => void;
  context(): Promise<string>;
  evaluate<T = unknown>(context: string, expression: string, timeoutMs?: number): Promise<T>;
  waitForExit(timeoutMs?: number): Promise<ExitResult>;
  close(): Promise<ExitResult>;
}
export type BrowserName = "chrome" | "firefox" | "webkit";
export type PageMode = "interception" | "live";
export interface InterceptResponse { status: number; headers?: Record<string, string>; body?: string | Uint8Array }
export type Respond = (url: URL, request: { navigation: boolean }) => Promise<InterceptResponse | null> | InterceptResponse | null;
export interface PlaywrightSelection {
  /** Existing tool home resolving the selected Playwright install. */
  packageRoot: string;
  browserCachePath: string;
  expectedVersion: "1.55.0";
  expectedCoreVersion: "1.55.0";
  expectedWebkitRevision: "2203";
}
export interface EvidenceLimits { console?: number; network?: number; lifecycle?: number; textLength?: number }
/** A desktop, or a phone or tablet as Chrome's device mode makes one: touch, a mobile viewport and an Android user agent. */
export type DeviceName = "desktop" | "phone" | "tablet";
export interface CommonPageOptions {
  width: number; height: number;
  /** Chrome only for anything but "desktop", the default. */
  device?: DeviceName;
  binary?: string;
  chromeArgs?: string[];
  firefoxPrefs?: Record<string, string | number | boolean>;
  workers?: boolean;
  timeouts?: BrowserTimeouts;
  evidenceLimits?: EvidenceLimits;
  playwright?: PlaywrightSelection;
  /** Live WebKit only. Chrome uses injected args; Firefox uses injected prefs. */
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
}
export type PageOptions = CommonPageOptions & (
  | { mode: "live"; respond?: never }
  | { mode?: "interception"; respond: Respond }
);
export interface BrowserFacts {
  browser: BrowserName; mode: PageMode; workers: boolean; engineVersion?: string;
  /** Chrome's emulated device. */
  device?: DeviceName;
  pid?: number;
  toolVersions?: { playwright: string; playwrightCore: string };
  webkitRevision?: string;
  processPidAvailable?: false;
  persistentProfile?: false;
  /** Owned Playwright transport origin, with endpoint token/path omitted. */
  transportOrigin?: string;
}
export interface BrowserEvidence {
  schemaVersion: 1;
  product: string;
  facts: BrowserFacts;
  console: Array<{ level: string; text: string }>;
  network: Array<{ phase: string; url: string; method?: string; status?: number; error?: string }>;
  lifecycle: LifecycleEvidence[];
  dropped: { console: number; network: number; lifecycle: number };
}
/** A screenshot's crop in CSS pixels of the viewport; only Chrome takes a scale other than 1, for a sharper crop. */
export interface ScreenshotOptions {
  clip?: { x: number; y: number; width: number; height: number };
  scale?: number;
}

export interface HeadlessPage {
  readonly product: string;
  readonly facts: BrowserFacts;
  navigate(url: string | URL): Promise<unknown>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  touch(): Promise<unknown>;
  close(): Promise<ExitResult | void>;
  /** Synchronous immutable copy; still available after close, bounded and sanitized. */
  captureEvidence(): BrowserEvidence;
}
