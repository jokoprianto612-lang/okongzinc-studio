/**
 * Video utilities on fal — upscalers, not generators.
 *
 * Everything else in the video modality makes a clip from nothing. These take a
 * clip you already have and make it bigger or cleaner, which is why they set
 * `requiresSourceVideo` and `ignoresPrompt`: there is no prompt to write, and the
 * form should stop pretending otherwise.
 *
 * Four backends, because their pricing models differ enough that picking the
 * wrong one is expensive:
 *
 *   Topaz          per SECOND, by output resolution ($0.01 / $0.02 / $0.08)
 *   SeedVR2        per MEGAPIXEL of total video data ($0.001)
 *   FlashVSR       per MEGAPIXEL, half SeedVR2's rate ($0.0005)
 *   ByteDance      per SECOND at 30fps ($0.0072 @1080p) — cheapest by far, but
 *                  `pro` mode is 10x
 *
 * A megapixel here is width x height x frames / 1e6, so for a 1920x1080 121-frame
 * clip SeedVR2 costs $0.25 and FlashVSR $0.125 — the per-second models are much
 * cheaper for long clips and the per-megapixel ones for short ones. The quote
 * functions below compute both honestly from the vendor's published formula.
 *
 * Schemas read from fal's live OpenAPI on 2026-08-02:
 *
 *   fal-ai/topaz/upscale/video               video_url → video
 *   fal-ai/seedvr/upscale/video              video_url → video, seed
 *   fal-ai/flashvsr/upscale/video            video_url → video, seed
 *   fal-ai/bytedance-upscaler/upscale/video  video_url → video, duration
 *
 * The trap: every one of these takes `video_url`, but their resolution fields all
 * differ — Topaz has `upscale_factor` only, SeedVR2 has `upscale_mode`
 * ('target'|'factor') plus `target_resolution`, ByteDance has `target_resolution`
 * as lowercase '2k'|'4k' while SeedVR2 spells them '1440p'|'2160p'.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest, Resolution } from '../types.js';
import {
  downloadFalFile,
  falUploadMedia,
  runFalQueued,
  type FalFile,
} from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

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

function requireSourceVideo(req: GenerateRequest, label: string): string {
  const source = req.sourceVideo;
  if (!source) {
    throw new ProviderError(
      `${label} is an upscaler — it needs a source video. Generate a clip first, ` +
        `then reuse it here.`,
      400,
    );
  }
  return source;
}

/**
 * Assumed clip length when the caller does not say.
 *
 * Used only for the cost quote, never sent to the provider. 10s is longer than
 * anything this studio generates by default (Veo caps at 8s, Kling at 15s), so
 * the quote errs toward over-estimating rather than sneaking past the ceiling.
 */
const ASSUMED_SECONDS = 10;

// ---------------------------------------------------------------------------
// Topaz — per second, by output resolution
// ---------------------------------------------------------------------------

const TOPAZ_VIDEO = 'fal-ai/topaz/upscale/video';

/** $/s by output band. Verified from fal's pricing string 2026-08-02. */
function topazRate(resolution: Resolution | undefined): number {
  if (resolution === '4K' || resolution === '2K') return 0.08;
  if (resolution === '1080p') return 0.02;
  return 0.01;
}

export const falTopazVideoProvider: Provider = {
  id: 'fal-topaz-video',
  label: 'Topaz Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  // Output geometry follows the input, so an aspect picker would be a lie.
  supportedAspectRatios: [],
  supportedResolutions: ['720p', '1080p', '4K'],
  models: [
    { id: 'Starlight Mini', label: 'Starlight Mini — best all-round detail' },
    { id: 'Proteus', label: 'Proteus — general purpose' },
    { id: 'Artemis HQ', label: 'Artemis HQ — clean sources' },
    { id: 'Artemis LQ', label: 'Artemis LQ — compressed or noisy sources' },
    { id: 'Gaia CG', label: 'Gaia CG — animation and 3D renders' },
    { id: 'Gaia 2', label: 'Gaia 2 — half price of the other models' },
    { id: 'Nyx Fast', label: 'Nyx Fast — noisy footage, quick' },
  ],
  typicalLatency: '1-8 min',
  tier: 'premium',
  priceRange: '$0.01-$0.08 per video second',
  notes:
    'The quality leader for real footage. Priced per SECOND of video, so a long ' +
    'clip is expensive: 10s at 4K is $0.80. Gaia 2 is billed at half rate. Pick ' +
    'the model that matches your source — Gaia CG for renders and game capture, ' +
    'Artemis LQ for anything that has been through YouTube.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const source = requireSourceVideo(req, 'Topaz Video Upscale');
    const known = this.models.some((m) => m.id === req.model);
    const model = known ? (req.model as string) : 'Starlight Mini';

    // Gaia 2 is billed at half rate, per fal's own pricing note.
    const rate = topazRate(req.resolution) * (model === 'Gaia 2' ? 0.5 : 1);
    const seconds = req.durationSeconds ?? ASSUMED_SECONDS;
    const cost = rate * seconds;
    assertWithinBudget(cost, `Topaz Video (${seconds}s at ${req.resolution ?? '720p'})`);

    const input: Record<string, unknown> = {
      video_url: await falUploadMedia(source, ctx, 'video'),
      model,
      // Topaz has no target_resolution field — only a factor.
      upscale_factor: req.resolution === '4K' ? 4 : 2,
      H264_output: true,
    };

    ctx.onProgress(`submitting to ${TOPAZ_VIDEO} (${model}) — ${costNote(cost)}`);
    const result = await runFalQueued(TOPAZ_VIDEO, input, ctx);
    return persistVideo(result, ctx, 'Topaz Video Upscale');
  },
};

// ---------------------------------------------------------------------------
// SeedVR2 and FlashVSR — per megapixel of total video data
// ---------------------------------------------------------------------------

const SEEDVR_VIDEO = 'fal-ai/seedvr/upscale/video';
const FLASHVSR_VIDEO = 'fal-ai/flashvsr/upscale/video';

/** SeedVR2 spells the high bands differently from ByteDance. */
const SEEDVR_TARGET: Record<string, string> = {
  '720p': '720p',
  '1080p': '1080p',
  '2K': '1440p',
  '4K': '2160p',
};

/**
 * Estimate output megapixels for a per-megapixel quote.
 *
 * width x height x frames / 1e6, using the vendor's own formula. Frame count is
 * assumed at 30fps because the input's real rate is unknown before upload — this
 * is an estimate for the budget gate, and the progress note says so rather than
 * presenting it as a bill.
 */
function estimateMegapixels(resolution: Resolution | undefined, seconds: number): number {
  const dims: Record<string, [number, number]> = {
    '720p': [1280, 720],
    '1080p': [1920, 1080],
    '2K': [2560, 1440],
    '4K': [3840, 2160],
  };
  const [w, h] = dims[resolution ?? '1080p'] ?? [1920, 1080];
  return (w * h * seconds * 30) / 1_000_000;
}

export const falSeedvrVideoProvider: Provider = {
  id: 'fal-seedvr-video',
  label: 'SeedVR2 Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  supportedResolutions: ['720p', '1080p', '2K', '4K'],
  models: [{ id: SEEDVR_VIDEO, label: 'SeedVR2', price: '$0.001 per megapixel of video data' }],
  typicalLatency: '1-6 min',
  tier: 'premium',
  priceRange: '$0.001 per megapixel',
  notes:
    'Priced per megapixel (width x height x frames), so cost tracks total pixels ' +
    'rather than clip length: a 1920x1080 121-frame clip is about $0.25. Cheaper ' +
    'than Topaz for short clips, more expensive for long ones.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const source = requireSourceVideo(req, 'SeedVR2');
    const seconds = req.durationSeconds ?? ASSUMED_SECONDS;
    const cost = estimateMegapixels(req.resolution, seconds) * 0.001;
    assertWithinBudget(cost, `SeedVR2 (~${seconds}s at ${req.resolution ?? '1080p'})`);

    const input: Record<string, unknown> = {
      video_url: await falUploadMedia(source, ctx, 'video'),
      output_format: 'X264 (.mp4)',
      output_quality: 'high',
      output_write_mode: 'balanced',
    };
    // 'target' honours target_resolution; 'factor' ignores it and doubles.
    if (req.resolution) {
      input.upscale_mode = 'target';
      input.target_resolution = SEEDVR_TARGET[req.resolution] ?? '1080p';
    } else {
      input.upscale_mode = 'factor';
      input.upscale_factor = 2;
    }
    if (req.seed !== undefined) input.seed = req.seed;

    ctx.onProgress(`submitting to ${SEEDVR_VIDEO} — estimated ${costNote(cost)}`);
    const result = await runFalQueued(SEEDVR_VIDEO, input, ctx);
    return persistVideo(result, ctx, 'SeedVR2');
  },
};

export const falFlashvsrVideoProvider: Provider = {
  id: 'fal-flashvsr-video',
  label: 'FlashVSR Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [
    { id: 'regular', label: 'Regular — best quality' },
    { id: 'high', label: 'High acceleration — faster' },
    { id: 'full', label: 'Full acceleration — fastest' },
  ],
  typicalLatency: '30s-4min',
  tier: 'premium',
  priceRange: '$0.0005 per megapixel',
  notes:
    'Half the price of SeedVR2 at the same per-megapixel model, and it can keep ' +
    'the original audio track (SeedVR2 and Topaz drop it). The cheapest way to ' +
    'upscale a short clip here.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const source = requireSourceVideo(req, 'FlashVSR');
    const seconds = req.durationSeconds ?? ASSUMED_SECONDS;
    const cost = estimateMegapixels(req.resolution, seconds) * 0.0005;
    assertWithinBudget(cost, `FlashVSR (~${seconds}s)`);

    const acceleration =
      req.model === 'high' || req.model === 'full' ? req.model : 'regular';

    const input: Record<string, unknown> = {
      video_url: await falUploadMedia(source, ctx, 'video'),
      upscale_factor: 2,
      acceleration,
      output_format: 'X264 (.mp4)',
      output_quality: 'high',
      // Unlike the other upscalers here, this one can carry the audio through.
      preserve_audio: true,
      color_fix: true,
    };
    if (req.seed !== undefined) input.seed = req.seed;

    ctx.onProgress(`submitting to ${FLASHVSR_VIDEO} (${acceleration}) — estimated ${costNote(cost)}`);
    const result = await runFalQueued(FLASHVSR_VIDEO, input, ctx);
    return persistVideo(result, ctx, 'FlashVSR');
  },
};

// ---------------------------------------------------------------------------
// ByteDance upscaler — cheapest per second
// ---------------------------------------------------------------------------

const BYTEDANCE_VIDEO = 'fal-ai/bytedance-upscaler/upscale/video';

/** $/s at 30fps by target. 60fps doubles; `pro` tier is 10x. */
const BYTEDANCE_RATE: Record<string, number> = {
  '1080p': 0.0072,
  '2k': 0.0144,
  '4k': 0.0288,
};

const BYTEDANCE_TARGET: Record<string, string> = {
  '720p': '1080p',
  '1080p': '1080p',
  '2K': '2k',
  '4K': '4k',
};

export const falBytedanceVideoProvider: Provider = {
  id: 'fal-bytedance-video',
  label: 'ByteDance Video Upscale (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  ignoresPrompt: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  supportedResolutions: ['1080p', '2K', '4K'],
  models: [
    { id: 'fast', label: 'Fast — cheapest', price: '$0.0072/s @1080p' },
    { id: 'standard', label: 'Standard — balanced', price: '$0.0072/s @1080p' },
    { id: 'pro', label: 'Pro — 10x the price, best quality', price: '$0.072/s @1080p' },
  ],
  typicalLatency: '1-5 min',
  tier: 'premium',
  priceRange: '$0.0072-$0.288 per second',
  notes:
    'By far the cheapest upscaler here at $0.0072 per second for 1080p — about a ' +
    'seventh of Topaz. It also has content presets (UGC, anime/AIGC, old film) ' +
    'that measurably beat a generic model on matching footage. NOTE: the `pro` ' +
    'tier is TEN TIMES the price, so it is not the default.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const source = requireSourceVideo(req, 'ByteDance Video Upscale');
    const tier = req.model === 'pro' || req.model === 'fast' ? req.model : 'standard';
    const target = BYTEDANCE_TARGET[req.resolution ?? '1080p'] ?? '1080p';

    const base = BYTEDANCE_RATE[target] ?? 0.0072;
    // pro is 10x per fal's pricing note — the single most expensive footgun here.
    const rate = base * (tier === 'pro' ? 10 : 1);
    const seconds = req.durationSeconds ?? ASSUMED_SECONDS;
    const cost = rate * seconds;
    assertWithinBudget(cost, `ByteDance upscale (${seconds}s ${target} ${tier})`);

    const input: Record<string, unknown> = {
      video_url: await falUploadMedia(source, ctx, 'video'),
      target_resolution: target,
      enhancement_tier: tier,
      target_fps: '30fps',
      enhancement_preset: 'general',
      fidelity: 'high',
    };

    ctx.onProgress(`submitting to ${BYTEDANCE_VIDEO} (${tier} → ${target}) — ${costNote(cost)}`);
    const result = await runFalQueued(BYTEDANCE_VIDEO, input, ctx);
    return persistVideo(result, ctx, 'ByteDance Video Upscale');
  },
};

/** Everything in this file, for the registry. */
export const VIDEO_UTILITY_PROVIDERS: Provider[] = [
  falBytedanceVideoProvider,
  falFlashvsrVideoProvider,
  falSeedvrVideoProvider,
  falTopazVideoProvider,
];
