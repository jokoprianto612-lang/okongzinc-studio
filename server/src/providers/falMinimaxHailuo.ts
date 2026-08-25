/**
 * MiniMax Hailuo 02 video generation via fal.
 *
 * Hailuo 02 ("MiniMax H3" in recent marketing) is MiniMax's flagship video
 * model — strong on motion design, cinematic pacing, and stylised 3D. It is
 * noticeably cheaper than Veo 3.1 and roughly Kling v3 pricing at the pro
 * tier, and tops out at 10 seconds per clip versus Kling's 15s.
 *
 * Cost-as-number discipline follows falPremiumVideo.ts: this file computes
 * the vendor-quoted USD cost BEFORE submitting, refuses the job when it
 * exceeds `PREMIUM_MAX_COST_PER_JOB_USD`, and reports the estimate through
 * `onProgress` so the user sees the number while the job runs.
 *
 * Schemas read from fal's live OpenAPI on 2026-08-04:
 *
 *   GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
 *
 *   fal-ai/minimax/hailuo-02/standard/text-to-video        prompt         → video
 *   fal-ai/minimax/hailuo-02/standard/image-to-video       prompt,image   → video
 *   fal-ai/minimax/hailuo-02/pro/text-to-video             prompt         → video
 *   fal-ai/minimax/hailuo-02/pro/image-to-video            prompt,image   → video
 *
 * Four schema facts that are wrong if guessed:
 *
 *   - Hailuo's image field is `image_url` (same as Veo, NOT Kling's
 *     `start_image_url`). There is no end-frame input.
 *   - `duration` is a string enum of exactly `'6' | '10'` — no "s" suffix
 *     (Veo), and only two legal values (Kling accepts 3-15).
 *   - `prompt_optimizer` defaults to TRUE on fal — it silently rewrites the
 *     user's prompt server-side unless disabled. We pass it through.
 *   - Resolution is `'1080p'` on pro, `'768p'` on standard. Requesting the
 *     wrong one is a 422, not a silent clamp.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest, ModelOption } from '../types.js';
import { downloadFalFile, falUploadImage, runFalQueued, type FalFile } from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability, VIDEO_RATES } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

/** Persist the `video` field of a fal result. */
async function persistVideo(
  result: Record<string, unknown>,
  ctx: GenerationContext,
  label: string,
): Promise<Artifact[]> {
  const video = result.video as FalFile | undefined;
  if (!video?.url) throw new ProviderError(`${label} returned no video`, 502);
  const { data, mimeType } = await downloadFalFile(video, ctx, 'video/mp4');
  return [await saveArtifact(data, mimeType)];
}

// ---------------------------------------------------------------------------
// MiniMax Hailuo 02
// ---------------------------------------------------------------------------

const HAILUO_TIERS = {
  'fal-ai/minimax/hailuo-02/standard/text-to-video': {
    rates: VIDEO_RATES.hailuoStandard,
    resolution: '768p' as const,
  },
  'fal-ai/minimax/hailuo-02/standard/image-to-video': {
    rates: VIDEO_RATES.hailuoStandard,
    resolution: '768p' as const,
  },
  'fal-ai/minimax/hailuo-02/pro/text-to-video': {
    rates: VIDEO_RATES.hailuoPro,
    resolution: '1080p' as const,
  },
  'fal-ai/minimax/hailuo-02/pro/image-to-video': {
    rates: VIDEO_RATES.hailuoPro,
    resolution: '1080p' as const,
  },
} as const;

type HailuoEndpoint = keyof typeof HAILUO_TIERS;

const HAILUO_MODELS: ModelOption[] = [
  {
    id: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    label: 'Hailuo 02 Standard — text→video (cheapest)',
    price: '$0.045/s @768p',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    label: 'Hailuo 02 Standard — image→video',
    price: '$0.045/s @768p',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/pro/text-to-video',
    label: 'Hailuo 02 Pro — text→video (best)',
    price: '$0.08/s @1080p',
  },
  {
    id: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
    label: 'Hailuo 02 Pro — image→video (best)',
    price: '$0.08/s @1080p',
  },
];

/**
 * Hailuo accepts only 6s or 10s. Snap the request to the nearest legal
 * duration, preferring 6s for anything at-or-below 8 (a user asking for 8s
 * pays for 6s rather than $0.08×10).
 */
function hailuoDuration(seconds: number | undefined): { value: '6' | '10'; n: number } {
  if (!seconds || seconds <= 8) return { value: '6', n: 6 };
  return { value: '10', n: 10 };
}

export const falMiniMaxHailuoProvider: Provider = {
  id: 'fal-minimax-hailuo',
  label: 'MiniMax Hailuo 02 (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9'],
  supportedResolutions: ['768p', '1080p'],
  models: HAILUO_MODELS,
  typicalLatency: '2-5 min',
  tier: 'premium',
  priceRange: '$0.27-$0.80 per clip',
  producesAudio: false,
  notes:
    'MiniMax Hailuo 02 — cinematic motion design at a fraction of Veo 3.1 ' +
    'cost. Clips are 6s or 10s only; requests snap DOWN. Silent output. ' +
    'Resolution is fixed per tier (768p standard, 1080p pro) and aspect is ' +
    'always 16:9, so those UI controls are ignored.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const requested = (req.model ??
      'fal-ai/minimax/hailuo-02/standard/text-to-video') as HailuoEndpoint;
    const tier = HAILUO_TIERS[requested];
    if (!tier) {
      throw new ProviderError(`unknown Hailuo endpoint '${req.model}'`, 400);
    }
    const endpoint = requested;
    const isImageToVideo = endpoint.includes('/image-to-video');

    if (isImageToVideo && !req.sourceImage) {
      throw new ProviderError(
        'this Hailuo endpoint is image→video and needs a source image',
        400,
      );
    }

    const { value: duration, n: seconds } = hailuoDuration(req.durationSeconds);
    const cost = tier.rates * seconds;
    assertWithinBudget(cost, `Hailuo 02 (${seconds}s ${tier.resolution})`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      duration,
      resolution: tier.resolution,
      // fal defaults this to true; respect the caller's choice so a crafted
      // prompt is not silently rewritten server-side.
      prompt_optimizer: req.promptOptimizer !== false,
    };

    if (isImageToVideo) {
      input.image_url = await falUploadImage(req.sourceImage as string, ctx);
    }

    ctx.onProgress(
      `submitting to ${endpoint} — ${seconds}s ${tier.resolution}, ${costNote(cost)}`,
    );
    const result = await runFalQueued(endpoint, input, ctx);
    return persistVideo(result, ctx, 'Hailuo 02');
  },
};
