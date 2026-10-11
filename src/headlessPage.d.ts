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
  }
}
export type { BrowserName, BrowserEvidence, BrowserFacts, BrowserTimeouts, CommonPageOptions, EvidenceLimits, HeadlessPage, InterceptResponse, PageMode, PageOptions, PlaywrightSelection, Respond } from "./contracts.js";
export declare function openHeadlessPage(browser: BrowserName, profileDirectory: string, options: PageOptions): Promise<HeadlessPage>;
