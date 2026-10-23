import type { BrowserName, HeadlessPage, PageOptions } from "./contracts.js";
export type ControlKey = "Tab" | "ShiftTab" | "Enter" | "Space" | "Escape" | "ArrowLeft" | "ArrowUp" | "ArrowRight" | "ArrowDown" | "Home" | "End" | "PageUp" | "PageDown";
export interface PointerDragOptions { steps?: number; durationMs?: number; }
declare module "./contracts.js" {
  interface HeadlessPage {
    /** Native protocol dispatch, serialized per page, with bounded key release on failure. */
    pressKey(key: ControlKey): Promise<void>;
    /** Native primary click at finite viewport coordinates, rounded to a pixel. */
    clickAt(x: number, y: number): Promise<void>;
    /** Primary drag with 1..20 steps and 0..1000 integer milliseconds. */
    dragAt(fromX: number, fromY: number, toX: number, toY: number, options?: PointerDragOptions): Promise<void>;
    /** A finger's tap: Chrome only, on any device. */
    tapAt(x: number, y: number): Promise<void>;
    /** One finger down, moved and lifted: 10 steps over 250 ms by default. Chrome only. */
    swipeAt(fromX: number, fromY: number, toX: number, toY: number, options?: PointerDragOptions): Promise<void>;
    /** Two fingers either side of (x, y) on a level line, from `fromDistance` apart to `toDistance` apart: 10 steps over 300 ms by default. Chrome only. */
    pinchAt(x: number, y: number, fromDistance: number, toDistance: number, options?: PointerDragOptions): Promise<void>;
  }
}
export type { BrowserName, DeviceName, BrowserEvidence, BrowserFacts, BrowserTimeouts, CommonPageOptions, EvidenceLimits, HeadlessPage, InterceptResponse, PageMode, PageOptions, PlaywrightSelection, Respond, ScreenshotOptions } from "./contracts.js";
/** The user agent override, with its client hints, of an Android phone or tablet running the Chrome named by `product`. */
export declare function deviceUserAgent(product: string, device: { model: string; mobile: boolean }): { userAgent: string; platform: string; userAgentMetadata: Record<string, unknown> };
export declare function openHeadlessPage(browser: BrowserName, profileDirectory: string, options: PageOptions): Promise<HeadlessPage>;
