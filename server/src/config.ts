/**
 * Centralised, validated configuration.
 *
 * Reads `.env` once at import time. Every provider block is optional — a
 * missing credential disables that provider rather than crashing the server,
 * so the app always boots with at least Pollinations available.
 */

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name).toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/** Non-negative decimal (used for USD spend ceilings). */
function num(name: string, fallback: number): number {
  const raw = str(name);
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const serverRoot = path.resolve(import.meta.dirname, '..');
const storageDir = path.resolve(serverRoot, str('STORAGE_DIR', './storage'));
fs.mkdirSync(storageDir, { recursive: true });

const nodeEnv = str('NODE_ENV', 'development');

/** Origins allowed by CORS. Vite's dev server is added automatically in dev. */
const corsOrigins = (() => {
  const configured = str('CORS_ORIGINS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (nodeEnv !== 'production') {
    for (const dev of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      if (!configured.includes(dev)) configured.push(dev);
    }
  }
  return configured;
})();

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: int('PORT', 8787),
  corsOrigins,
  storageDir,
  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 2),
  /** Empty string means the API is unauthenticated (local dev only). */
  apiKey: str('API_KEY'),

  pollinations: {
    enabled: bool('POLLINATIONS_ENABLED', true),
    baseUrl: str('POLLINATIONS_BASE_URL', 'https://image.pollinations.ai'),
  },

  google: {
    apiKey: str('GOOGLE_API_KEY'),
    imageModel: str('GOOGLE_IMAGE_MODEL', 'gemini-3.1-flash-image'),
    videoModel: str('GOOGLE_VIDEO_MODEL', 'veo-3.1-generate-preview'),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  modal: {
    trellisUrl: str('MODAL_TRELLIS_URL'),
    trellisToken: str('MODAL_TRELLIS_TOKEN'),
    longcatUrl: str('MODAL_LONGCAT_URL'),
    longcatToken: str('MODAL_LONGCAT_TOKEN'),
  },

  /**
   * Reach — reference research. Pulls a URL down to clean markdown so a prompt
   * can be grounded in a real page instead of the model's memory.
   *
   * Two backends, in order:
   *   1. agent-reach CLI (Panniantong/Agent-Reach) when installed — covers
   *      Twitter/Reddit/YouTube/Bilibili/XiaoHongShu behind one command.
   *   2. Jina Reader (r.jina.ai) — zero install, no key, any public URL.
   *
   * Backend 2 always works, so the feature needs no configuration.
   */
  reach: {
    enabled: bool('REACH_ENABLED', true),
    /** Path to the agent-reach binary; empty means "look on PATH". */
    agentReachBin: str('AGENT_REACH_BIN'),
    jinaBaseUrl: str('JINA_READER_URL', 'https://r.jina.ai'),
    /** Optional Jina key raises rate limits; anonymous access works without it. */
    jinaApiKey: str('JINA_API_KEY'),
    /** Characters of extracted text kept before truncation. */
    maxChars: int('REACH_MAX_CHARS', 12000),
    timeoutMs: int('REACH_TIMEOUT_MS', 60000),
  },

  /**
   * fal.ai — one key covers image, video, and 3D. Hosts the same LongCat-Video
   * and TRELLIS models as the Modal workers at roughly a tenth of the cost,
   * with no weight download and no idle storage bill.
   */
  fal: {
    apiKey: str('FAL_KEY'),
  },

  /**
   * Premium tier — flagship models that cost dollars, not cents, per render
   * (Veo 3.1 at $0.40/s with audio, Kling v3 Pro, Nano Banana Pro, Seedream 5
   * Pro, Tripo3D). They use the same FAL_KEY as the standard fal providers, so
   * without a separate switch a user clicking through the model dropdown could
   * burn a dollar per click by accident.
   *
   * This is the admin's opt-in. Off by default: every premium provider reports
   * `available: false` with the reason shown in the UI, exactly like a missing
   * key, so nothing silently disappears.
   */
  premium: {
    enabled: bool('PREMIUM_ENABLED', false),
    /**
     * Hard ceiling in USD on the vendor-quoted cost of a single premium render.
     * A request whose quoted cost exceeds this is rejected before submission.
     * 0 disables the check.
     */
    maxCostPerJobUsd: num('PREMIUM_MAX_COST_PER_JOB_USD', 5),
  },

  /**
   * Prompt studio — LLM-assisted prompt authoring on `fal-ai/any-llm`.
   *
   * Needs no new credential (it rides FAL_KEY), and token cost for a prompt
   * rewrite is a fraction of a cent, so it is ON by default unlike the premium
   * tier. Set false to remove the endpoints entirely.
   */
  promptStudio: {
    enabled: bool('PROMPT_STUDIO_ENABLED', true),
  },

  openai: {
    apiKey: str('OPENAI_API_KEY'),
    baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    imageModel: str('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
  },
} as const;

/**
 * Warn loudly when the server is production-like but has no API key. Creating
 * an unauthenticated network-exposed endpoint silently is exactly the kind of
 * thing that should never be a surprise.
 */
export function warnIfInsecure(logger: (msg: string) => void): void {
  if (!config.apiKey) {
    logger(
      '[security] API_KEY is not set — the API is UNAUTHENTICATED. Anyone who ' +
        'can reach this port can spend your provider quota. Fine for localhost; ' +
        'set API_KEY in .env before exposing it to a network.',
    );
  }
}
