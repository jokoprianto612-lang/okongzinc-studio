/**
 * Premium tier plumbing.
 *
 * "Premium" means a single render can cost dollars rather than cents: Veo 3.1 is
 * $0.40 per generated second with audio, Kling v3 Pro $0.168, Nano Banana Pro
 * $0.15 an image. These share the SAME `FAL_KEY` as the cheap fal providers, so
 * without a separate switch a user browsing the model dropdown could spend a
 * dollar per click by accident.
 *
 * Two guards live here:
 *
 *   1. `premiumAvailability()` — an admin opt-in (`PREMIUM_ENABLED`). Off by
 *      default. A disabled premium provider reports `available: false` with a
 *      reason, exactly like a missing key, so it stays visible and explained
 *      instead of vanishing.
 *   2. `assertWithinBudget()` — a hard per-job ceiling
 *      (`PREMIUM_MAX_COST_PER_JOB_USD`, default $5) checked BEFORE submitting to
 *      fal. Costs are computed from the vendor's own published rate table below,
 *      never guessed.
 *
 * Every number in `RATES` was read from fal's model metadata on 2026-08-02
 * (`GET https://fal.ai/api/models?...` → `pricingInfoOverride`). When fal changes
 * a price this file is what has to be updated — the estimate is only as honest as
 * the table.
 */

import { config } from '../config.js';
import { ProviderError } from './types.js';

/** Availability for a premium provider: needs FAL_KEY *and* the admin opt-in. */
export function premiumAvailability(): { available: boolean; reason?: string } {
  if (!config.fal.apiKey) {
    return { available: false, reason: 'FAL_KEY is not set — get one at fal.ai/dashboard/keys' };
  }
  if (!config.premium.enabled) {
    return {
      available: false,
      reason:
        'premium models are off — set PREMIUM_ENABLED=true in .env to allow ' +
        'renders that cost dollars rather than cents',
    };
  }
  return { available: true };
}

/**
 * Reject a job whose vendor-quoted cost exceeds the configured ceiling.
 *
 * Throws before the request is submitted, so an over-budget job costs nothing.
 * A ceiling of 0 disables the check.
 */
export function assertWithinBudget(usd: number, label: string): void {
  const ceiling = config.premium.maxCostPerJobUsd;
  if (ceiling <= 0) return;
  if (usd > ceiling) {
    throw new ProviderError(
      `${label} would cost about $${usd.toFixed(2)}, over the ` +
        `PREMIUM_MAX_COST_PER_JOB_USD ceiling of $${ceiling.toFixed(2)}. ` +
        `Shorten the clip, drop the resolution, or raise the ceiling in .env.`,
      400,
    );
  }
}

/** Formats a computed cost for a progress note. */
export function costNote(usd: number): string {
  return `vendor-quoted cost ≈ $${usd.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Vendor rate table — verified 2026-08-02 from fal's own model metadata.
// ---------------------------------------------------------------------------

/** Per-generated-second video rates, in USD. */
export const VIDEO_RATES = {
  /** fal-ai/veo3.1 — 720p/1080p, then 4k. */
  veo31: {
    hd: { silent: 0.2, audio: 0.4 },
    '4k': { silent: 0.4, audio: 0.6 },
  },
  /** fal-ai/veo3.1/fast */
  veo31Fast: {
    hd: { silent: 0.1, audio: 0.15 },
    '4k': { silent: 0.3, audio: 0.35 },
  },
  /** fal-ai/veo3.1/lite — no 4k tier. */
  veo31Lite: {
    '720p': { silent: 0.03, audio: 0.05 },
    '1080p': { silent: 0.05, audio: 0.08 },
  },
  /** fal-ai/kling-video/v3/pro/* */
  klingV3Pro: { silent: 0.112, audio: 0.168 },
  /** fal-ai/kling-video/v3/standard/* */
  klingV3Standard: { silent: 0.084, audio: 0.126 },
  /** fal-ai/minimax/hailuo-02/standard/* — flat per-second, silent only. */
  hailuoStandard: 0.045,
  /** fal-ai/minimax/hailuo-02/pro/* — flat per-second, silent only. */
  hailuoPro: 0.08,
} as const;

/** Flat per-render rates, in USD. */
export const RENDER_RATES = {
  nanoBananaPro: 0.15,
  nanoBananaPro4k: 0.3,
  nanoBanana2: 0.08,
  seedream5Pro: 0.0675,
  seedream5Pro2k: 0.135,
  seedreamExtraInputImage: 0.0045,
  ideogramV3: { TURBO: 0.03, BALANCED: 0.06, QUALITY: 0.09 },
  flux2ProFirstMegapixel: 0.03,
  flux2ProExtraMegapixel: 0.015,
  topazUpTo24mp: 0.08,
  tripo: { no: 0.2, standard: 0.3, HD: 0.4 },
  tripoOptionSurcharge: 0.05,
} as const;
