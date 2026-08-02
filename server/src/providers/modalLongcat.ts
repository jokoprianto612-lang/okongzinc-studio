/**
 * LongCat-Video on Modal — text-to-video, image-to-video, and video continuation.
 *
 * meituan-longcat/LongCat-Video is a 13.6B foundational video model. Verified
 * from the upstream repo (2026-08-01):
 *
 *   - weights total ~83 GB (6-shard DiT ~50 GB + UMT5 text encoder ~25 GB)
 *   - requires flash-attn 2.7.4 + torch 2.6.0 + CUDA 12.4
 *   - generates 480p (93 frames @ 15fps) then optionally refines to 720p 30fps
 *   - natively pretrained on video-continuation, so it extends clips without
 *     the colour drift that plagues frame-chaining approaches
 *
 * That does not run on consumer hardware, so this provider calls a Modal
 * endpoint. Unlike Veo (a hosted API), this is a self-hosted open-weights model:
 * slower and you pay GPU-seconds, but no per-request quota and no content
 * gate you do not control.
 *
 * Contract with modal/longcat_app.py:
 *   POST { task, prompt, negative_prompt?, image_base64?, video_base64?,
 *          resolution, num_frames?, use_distill?, refine?, seed? }
 *   →    { video_base64, mime_type, filename, frames, fps }
 */

import { config } from '../config.js';
import { readSourceImage, saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest } from '../types.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';

/**
 * Upstream's own negative prompt from run_demo_text_to_video.py. Shipping it as
 * the default matters: the model was tuned with it, and omitting it visibly
 * degrades output.
 */
const DEFAULT_NEGATIVE_PROMPT =
  'Bright tones, overexposed, static, blurred details, subtitles, style, works, ' +
  'paintings, images, static, overall gray, worst quality, low quality, JPEG ' +
  'compression residue, ugly, incomplete, extra fingers, poorly drawn hands, ' +
  'poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, ' +
  'still picture, messy background, three legs, many people in the background, ' +
  'walking backwards';

const MODELS = [
  { id: 'longcat-t2v-480p', label: 'Text→Video 480p (50 steps, best quality)' },
  { id: 'longcat-t2v-distill', label: 'Text→Video 480p distilled (16 steps, fast)' },
  { id: 'longcat-t2v-720p', label: 'Text→Video 720p refined (slowest)' },
  { id: 'longcat-i2v', label: 'Image→Video (needs a source image)' },
  { id: 'longcat-continue', label: 'Video continuation (extend a clip)' },
];

/** Maps a UI model id onto the worker's task + flags. */
function resolveTask(modelId: string | undefined): {
  task: 't2v' | 'i2v' | 'continuation';
  resolution: '480p' | '720p';
  useDistill: boolean;
  refine: boolean;
} {
  switch (modelId) {
    case 'longcat-t2v-distill':
      return { task: 't2v', resolution: '480p', useDistill: true, refine: false };
    case 'longcat-t2v-720p':
      return { task: 't2v', resolution: '720p', useDistill: true, refine: true };
    case 'longcat-i2v':
      return { task: 'i2v', resolution: '480p', useDistill: false, refine: false };
    case 'longcat-continue':
      return { task: 'continuation', resolution: '480p', useDistill: false, refine: false };
    default:
      return { task: 't2v', resolution: '480p', useDistill: false, refine: false };
  }
}

export const modalLongcatProvider: Provider = {
  id: 'modal-longcat',
  label: 'LongCat-Video on Modal (open weights)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16'],
  models: MODELS,
  typicalLatency: '3-15 min (plus a long first cold start)',
  tier: 'standard',
  priceRange: 'Modal GPU seconds (H100)',
  notes:
    'Self-hosted 13.6B open-weights model. Needs a deployed Modal endpoint — ' +
    '~83 GB of weights and an 80 GB GPU, so it cannot run locally. No per-request ' +
    'quota, but you pay GPU-seconds. Image→Video and continuation need a source.',

  availability() {
    if (!config.modal.longcatUrl) {
      return {
        available: false,
        reason: 'MODAL_LONGCAT_URL is not set — deploy modal/longcat_app.py first',
      };
    }
    return { available: true };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!config.modal.longcatUrl) {
      throw new ProviderError('MODAL_LONGCAT_URL is not set', 503);
    }

    const { task, resolution, useDistill, refine } = resolveTask(req.model);

    if ((task === 'i2v' || task === 'continuation') && !req.sourceImage) {
      throw new ProviderError(
        `LongCat ${task === 'i2v' ? 'Image→Video' : 'continuation'} needs a source image`,
        400,
      );
    }

    const payload: Record<string, unknown> = {
      task,
      prompt: req.prompt,
      negative_prompt: req.negativePrompt || DEFAULT_NEGATIVE_PROMPT,
      resolution,
      use_distill: useDistill,
      refine,
      seed: req.seed ?? 42,
    };

    // 93 frames is upstream's default clip length; fps is 15 at 480p and 30
    // after refinement, so seconds → frames uses the pre-refine rate.
    if (req.durationSeconds) {
      payload.num_frames = Math.min(Math.max(req.durationSeconds * 15, 33), 465);
    }

    if (req.sourceImage) {
      ctx.onProgress('reading source image');
      const src = await readSourceImage(req.sourceImage);
      payload.image_base64 = Buffer.from(src.data).toString('base64');
      payload.mime_type = src.mimeType;
    }

    ctx.onProgress(
      `calling LongCat ${task} at ${resolution}${refine ? ' + 720p refine' : ''} — ` +
        'first run downloads ~83 GB of weights, expect a long cold start',
    );

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.modal.longcatToken) {
      headers.Authorization = `Bearer ${config.modal.longcatToken}`;
    }

    const res = await fetchWithTimeout(
      config.modal.longcatUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        // Refinement passes are genuinely slow; 30 min is the upper bound.
        timeoutMs: 1_800_000,
      },
      ctx.signal,
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`Modal LongCat returned HTTP ${res.status} — ${detail}`, 502);
    }

    const body = (await res.json()) as {
      video_base64?: string;
      mime_type?: string;
      frames?: number;
      fps?: number;
      error?: string;
    };

    if (body.error) throw new ProviderError(`LongCat worker error: ${body.error}`, 502);
    if (!body.video_base64) {
      throw new ProviderError('Modal LongCat response contained no video_base64', 502);
    }

    const data = new Uint8Array(Buffer.from(body.video_base64, 'base64'));
    ctx.onProgress(
      `received ${(data.byteLength / 1024 / 1024).toFixed(1)} MB ` +
        `(${body.frames ?? '?'} frames @ ${body.fps ?? '?'}fps)`,
    );

    return [await saveArtifact(data, body.mime_type ?? 'video/mp4')];
  },
};
