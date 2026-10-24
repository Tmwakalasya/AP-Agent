import { resolve } from "node:path";

// Loads .env from the repo root once. Missing file is fine; the worker then
// runs on the labeled manual fallback.
try { process.loadEnvFile(resolve(".env")); } catch { /* no .env */ }

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-4-5";
