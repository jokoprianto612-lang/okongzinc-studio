/**
 * Premium video providers on fal — Veo 3.1 and Kling v3.
 *
 * These are the most expensive things this studio can run. Veo 3.1 at 1080p with
 * audio is $0.40 per generated second: an 8-second clip is $3.20, which is more
 * than a hundred Pollinations images. Every code path here therefore computes the
 * vendor-quoted cost from the published rate table BEFORE submitting, checks it
 * against `PREMIUM_MAX_COST_PER_JOB_USD`, and reports it through `onProgress` so
 * the number is visible in the UI while the job runs.
 *
 * Schemas read from fal's live OpenAPI on 2026-08-02:
 *
 *   GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
 *
 *   fal-ai/veo3.1                          prompt              → video
 *   fal-ai/veo3.1/image-to-video           prompt, image_url   → video
 *   fal-ai/veo3.1/fast                     prompt              → video
 *   fal-ai/veo3.1/fast/image-to-video      prompt, image_url   → video
 *   fal-ai/veo3.1/lite                     prompt              → video
 *   fal-ai/veo3.1/lite/image-to-video      prompt, image_url   → video
 *   fal-ai/kling-video/v3/pro/text-to-video       (none)       → video
 *   fal-ai/kling-video/v3/pro/image-to-video      start_image_url → video
 *   fal-ai/kling-video/v3/standard/text-to-video  (none)       → video
 *   fal-ai/kling-video/v3/standard/image-to-video start_image_url → video
 *
 * Four schema facts that are wrong if guessed:
 *
 *   - Veo takes `duration` as a string enum of exactly `'4s' | '6s' | '8s'` —
 *     with the "s" suffix. A number, or `'5s'`, is a 422.
 *   - Kling takes `duration` as a stringified integer `'3'..'15'` — no suffix.
 *     Same field name, different vocabulary, on a sibling endpoint.
 *   - Kling's image input is `start_image_url`, NOT `image_url`, and it also
 *     accepts `end_image_url` for a target frame.
 *   - Veo's `lite` tier has no 4k option; asking for it silently means 1080p on
 *     that endpoint, so this code clamps rather than passing 4k through.
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
// Veo 3.1
// ---------------------------------------------------------------------------

const VEO_TIERS = {
  'fal-ai/veo3.1': { rates: VIDEO_RATES.veo31, allows4k: true },
  'fal-ai/veo3.1/image-to-video': { rates: VIDEO_RATES.veo31, allows4k: true },
  'fal-ai/veo3.1/fast': { rates: VIDEO_RATES.veo31Fast, allows4k: true },
  'fal-ai/veo3.1/fast/image-to-video': { rates: VIDEO_RATES.veo31Fast, allows4k: true },
  'fal-ai/veo3.1/lite': { rates: VIDEO_RATES.veo31Lite, allows4k: false },
  'fal-ai/veo3.1/lite/image-to-video': { rates: VIDEO_RATES.veo31Lite, allows4k: false },
} as const;

type VeoEndpoint = keyof typeof VEO_TIERS;

const VEO_MODELS: ModelOption[] = [
  {
    id: 'fal-ai/veo3.1/lite',
    label: 'Veo 3.1 Lite — text→video (cheapest)',
    price: '$0.03/s silent · $0.05/s with audio @720p',
  },
  {
    id: 'fal-ai/veo3.1/lite/image-to-video',
    label: 'Veo 3.1 Lite — image→video',
    price: '$0.03/s silent · $0.05/s with audio @720p',
  },
  {
    id: 'fal-ai/veo3.1/fast',
    label: 'Veo 3.1 Fast — text→video',
    price: '$0.10/s silent · $0.15/s with audio',
  },
  {
    id: 'fal-ai/veo3.1/fast/image-to-video',
    label: 'Veo 3.1 Fast — image→video',
    price: '$0.10/s silent · $0.15/s with audio',
  },
  {
    id: 'fal-ai/veo3.1',
    label: 'Veo 3.1 — text→video (best)',
    price: '$0.20/s silent · $0.40/s with audio',
  },
  {
    id: 'fal-ai/veo3.1/image-to-video',
    label: 'Veo 3.1 — image→video (best)',
    price: '$0.20/s silent · $0.40/s with audio',
  },
];

/**
 * Veo accepts only 4s, 6s, or 8s. Snap the requested duration DOWN to a legal
 * value so a user asking for 7 seconds pays for 6 rather than getting a 422.
 */
function veoDuration(seconds: number | undefined): { value: '4s' | '6s' | '8s'; n: number } {
  if (!seconds || seconds <= 4) return { value: '4s', n: 4 };
  if (seconds <= 6) return { value: '6s', n: 6 };
  return { value: '8s', n: 8 };
}

export const falVeo31Provider: Provider = {
  id: 'fal-veo31',
  label: 'Veo 3.1 (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16'],
  supportedResolutions: ['720p', '1080p', '4K'],
  models: VEO_MODELS,
  typicalLatency: '1-4 min',
  tier: 'premium',
  priceRange: '$0.12-$4.80 per clip',
  producesAudio: true,
  notes:
    'Google Veo 3.1 — the best video quality available here, and the most ' +
    'expensive. Duration snaps to 4s, 6s, or 8s. Audio is OFF unless you ask ' +
    'for it, because audio roughly doubles the price. Lite is ~7x cheaper than ' +
    'the full tier for the same length.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const requested = (req.model ?? 'fal-ai/veo3.1/lite') as VeoEndpoint;
    const tier = VEO_TIERS[requested];
    if (!tier) {
      throw new ProviderError(`unknown Veo endpoint '${req.model}'`, 400);
    }
    const endpoint = requested;
    const isImageToVideo = endpoint.includes('/image-to-video');

    if (isImageToVideo && !req.sourceImage) {
      throw new ProviderError('this Veo endpoint is image→video and needs a source image', 400);
    }

    const { value: duration, n: seconds } = veoDuration(req.durationSeconds);
    const withAudio = req.generateAudio === true;

    // Resolve resolution against what the tier actually offers.
    const wants4k = req.resolution === '4K';
    const resolution = wants4k && tier.allows4k ? '4k' : req.resolution === '1080p' ? '1080p' : '720p';

    // Rate lookup: the lite tier is keyed per resolution, the others by hd/4k.
    const rate = (() => {
      if (tier.rates === VIDEO_RATES.veo31Lite) {
        const band = resolution === '1080p' ? '1080p' : '720p';
        const r = VIDEO_RATES.veo31Lite[band];
        return withAudio ? r.audio : r.silent;
      }
      const rates = tier.rates as typeof VIDEO_RATES.veo31;
      const band = resolution === '4k' ? '4k' : 'hd';
      const r = rates[band];
      return withAudio ? r.audio : r.silent;
    })();

    const cost = rate * seconds;
    assertWithinBudget(cost, `Veo 3.1 (${seconds}s ${resolution}${withAudio ? ' with audio' : ''})`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      duration,
      resolution,
      generate_audio: withAudio,
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;

    if (isImageToVideo) {
      input.image_url = await falUploadImage(req.sourceImage as string, ctx);
      // i2v takes framing from the source image unless overridden.
      if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    } else {
      input.aspect_ratio = req.aspectRatio === '9:16' ? '9:16' : '16:9';
    }

    ctx.onProgress(
      `submitting to ${endpoint} — ${seconds}s ${resolution}` +
        `${withAudio ? ' with audio' : ' silent'}, ${costNote(cost)}`,
    );
    const result = await runFalQueued(endpoint, input, ctx);
    return persistVideo(result, ctx, 'Veo 3.1');
  },
};

// ---------------------------------------------------------------------------
// Kling v3
// ---------------------------------------------------------------------------

const KLING_TIERS = {
  'fal-ai/kling-video/v3/standard/text-to-video': VIDEO_RATES.klingV3Standard,
  'fal-ai/kling-video/v3/standard/image-to-video': VIDEO_RATES.klingV3Standard,
  'fal-ai/kling-video/v3/pro/text-to-video': VIDEO_RATES.klingV3Pro,
  'fal-ai/kling-video/v3/pro/image-to-video': VIDEO_RATES.klingV3Pro,
} as const;

type KlingEndpoint = keyof typeof KLING_TIERS;

const KLING_MODELS: ModelOption[] = [
  {
    id: 'fal-ai/kling-video/v3/standard/text-to-video',
    label: 'Kling v3 Standard — text→video',
    price: '$0.084/s silent · $0.126/s with audio',
  },
  {
    id: 'fal-ai/kling-video/v3/standard/image-to-video',
    label: 'Kling v3 Standard — image→video',
    price: '$0.084/s silent · $0.126/s with audio',
  },
  {
    id: 'fal-ai/kling-video/v3/pro/text-to-video',
    label: 'Kling v3 Pro — text→video',
    price: '$0.112/s silent · $0.168/s with audio',
  },
  {
    id: 'fal-ai/kling-video/v3/pro/image-to-video',
    label: 'Kling v3 Pro — image→video',
    price: '$0.112/s silent · $0.168/s with audio',
  },
];

export const falKlingV3Provider: Provider = {
  id: 'fal-kling-v3',
  label: 'Kling v3 (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  models: KLING_MODELS,
  typicalLatency: '2-6 min',
  tier: 'premium',
  priceRange: '$0.25-$2.52 per clip',
  producesAudio: true,
  notes:
    'Kling 3.0 — cinematic motion and native audio, up to 15 seconds in one ' +
    'call, which is longer than Veo can do. Duration is any whole number of ' +
    'seconds from 3 to 15. Audio is OFF by default (it adds 50% to the price).',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const requested = (req.model ??
      'fal-ai/kling-video/v3/standard/text-to-video') as KlingEndpoint;
    const rates = KLING_TIERS[requested];
    if (!rates) {
      throw new ProviderError(`unknown Kling endpoint '${req.model}'`, 400);
    }
    const endpoint = requested;
    const isImageToVideo = endpoint.includes('/image-to-video');

    if (isImageToVideo && !req.sourceImage) {
      throw new ProviderError('this Kling endpoint is image→video and needs a source image', 400);
    }

    // Kling's duration enum is '3'..'15' as strings, no unit suffix.
    const seconds = Math.min(Math.max(req.durationSeconds ?? 5, 3), 15);
    const withAudio = req.generateAudio === true;
    const cost = (withAudio ? rates.audio : rates.silent) * seconds;
    assertWithinBudget(cost, `Kling v3 (${seconds}s${withAudio ? ' with audio' : ''})`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      duration: String(seconds),
      generate_audio: withAudio,
    };
    // The endpoint defaults this to a tuned string; only override when asked.
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;

    if (isImageToVideo) {
      // NOTE: start_image_url, not image_url.
      input.start_image_url = await falUploadImage(req.sourceImage as string, ctx);
    } else {
      input.aspect_ratio =
        req.aspectRatio === '9:16' ? '9:16' : req.aspectRatio === '1:1' ? '1:1' : '16:9';
    }

    ctx.onProgress(
      `submitting to ${endpoint} — ${seconds}s` +
        `${withAudio ? ' with audio' : ' silent'}, ${costNote(cost)}`,
    );
    const result = await runFalQueued(endpoint, input, ctx);
    return persistVideo(result, ctx, 'Kling v3');
  },
};
