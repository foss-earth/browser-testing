import type { BrowserName, HeadlessPage, PageOptions } from "./contracts.js";
export type { BrowserName, BrowserEvidence, BrowserFacts, BrowserTimeouts, CommonPageOptions, EvidenceLimits, HeadlessPage, InterceptResponse, PageMode, PageOptions, PlaywrightSelection, Respond } from "./contracts.js";
export declare function openHeadlessPage(browser: BrowserName, profileDirectory: string, options: PageOptions): Promise<HeadlessPage>;
