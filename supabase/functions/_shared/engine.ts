/**
 * Pure backtest engine shared by the browser, the forecast edge function and the offline manifest
 * script. One truth: the UI and Deno both import this barrel. No Deno, DOM, Node or network imports
 * in any module below; TextEncoder and URL are the only globals used.
 */

export * from "./canonical.ts";
export * from "./time.ts";
export * from "./manifest.ts";
export * from "./evidence.ts";
export * from "./prompt.ts";
export * from "./critic.ts";
export * from "./attempts.ts";
export * from "./scoring.ts";
export * from "./bootstrap.ts";
export * from "./audit.ts";
export * from "./run.ts";
export * from "./bundle.ts";
