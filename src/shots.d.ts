import type { HeadlessPage } from "./contracts.js";

/** An expression run in the page, or a native click at the first visible match's center, a control key, a wait for an expression, or an expression whose JSON result is printed. */
export type ShotStep = string | { click: string } | { key: string } | { wait: string } | { print: string };

/** What a shot list's shots take from it unless they set their own. */
export interface ShotDefaults {
  /** Viewport in CSS pixels; 1100 by 700 by default. */
  width?: number;
  height?: number;
  /** Device pixels per CSS pixel of the image, 0.25..4; Chrome only for anything but 1. */
  scale?: number;
  /** CSS pixels kept around a crop; 8 by default. */
  pad?: number;
  /** Stop animations, transitions and the caret; true by default. */
  freeze?: boolean;
  /** How long a wait may take, up to 110000; 10000 by default. */
  timeoutMs?: number;
  /** An expression the page must make true before anything else; by default, the document has loaded. */
  wait?: string;
  /** Elements made invisible without moving anything else: a frame rate, a clock or a live map that would change every image. */
  hide?: string;
}

export interface Shot extends ShotDefaults {
  /** The image's path under the output directory, without ".png": letters, digits, ".", "_" and "-" in "/" folders. */
  name: string;
  /** Resolved against the list's base. */
  url?: string;
  steps?: ShotStep[];
  /** Crop to the box holding every visible match; the whole viewport without one. */
  selector?: string;
  /** Start a new browser, with empty storage, for this shot; otherwise it reuses the previous shot's browser when their viewports match. */
  fresh?: boolean;
}

export interface ShotList extends ShotDefaults {
  base?: string;
  shots: Shot[];
}

export type NormalizedShot = Required<Omit<Shot, "selector" | "wait" | "hide">> & Pick<Shot, "selector" | "wait" | "hide">;

export interface ShotResult {
  name: string;
  status: "new" | "changed" | "unchanged" | "failed";
  /** The image, or for a failed shot the page when it failed, if that could be captured. */
  path?: string;
  /** For a changed shot, where its old image went. */
  previous?: string;
  size?: { width: number; height: number } | null;
  /** The results of its print steps. */
  printed?: string[];
  error?: string;
}

export interface ShotRun {
  stamp: string;
  results: ShotResult[];
  consoleErrors: string[];
}

export interface TakeShotsOptions {
  directory: string;
  /** Opens a browser for a group of shots; the run closes it. */
  openPage(viewport: { width: number; height: number }): Promise<HeadlessPage>;
  /** The run's archive folder name; utcStamp() by default. */
  stamp?: string;
  onPage?(page: HeadlessPage | null): void;
  onResult?(result: ShotResult): void;
}

/** A time as an archive folder name, "2026-10-21T155203Z", which sorts by time. */
export declare function utcStamp(date?: Date): string;
/** Writes <directory>/<name>.png, unless the bytes are the same; a changed image's old file moves to <directory>/archive/<stamp>/<name>.png first. */
export declare function saveShot(directory: string, name: string, bytes: Uint8Array, options?: { stamp?: string }): Promise<ShotResult>;
export declare function pngSize(bytes: Uint8Array): { width: number; height: number } | null;
/** Checks a list and fills each shot from the list's defaults. Throws on anything unknown or out of range. */
export declare function normalizeShotList(list: ShotList): NormalizedShot[];
export declare function takeShots(shots: NormalizedShot[], options: TakeShotsOptions): Promise<ShotRun>;
/** Writes <directory>/index.html to review a run: changed shots next to what they were, then new, failed and unchanged ones. */
export declare function writeReview(directory: string, run: ShotRun): Promise<string>;
