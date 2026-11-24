/**
 * MiniMax official API provider — text-to-video, image-to-video.
 *
 * Uses MiniMax's direct REST API (platform.minimaxi.com). Unlike the HF Space,
 * this is production-grade with proper quota management and longer clips.
 *
 * API docs: https://platform.minimaxi.com/docs
 *
 * Endpoints:
 *   POST /v1/video_generation        — text-to-video
 *   POST /v1/image_to_video          — image-to-video
 *
 * Pricing (vendor-quoted, 2026):
 *   video-01    → ~$0.02/s  (standard, 6s max)
 *   video-01-1  → ~$0.05/s  (fast, 6s max)
 *   video-02    → ~$0.08/s  (pro, 10s max)
 */

import { config } from '../config.js';
import { saveArtifact } from '../storage.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';
import type { Artifact, GenerateRequest } from '../types.js';

const BASE_URL = 'https://api.minimax.chat/v1';

const MODELS = [
  { id: 'video-01', label: 'MiniMax Video 01 — text→video ($0.02/s)' },
  { id: 'video-01-1', label: 'MiniMax Video 01 Fast — text→video ($0.05/s)' },
  { id: 'video-02', label: 'MiniMax Video 02 — text→video pro ($0.08/s)' },
];

export const minimaxApiProvider: Provider = {
  id: 'minimax-api',
  label: 'MiniMax (official API)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9'],
  models: MODELS,
  typicalLatency: '1-4 min',
  tier: 'standard',
  priceRange: '$0.02-$0.08 per second',
  producesAudio: false,
  notes:
    'Official MiniMax API. Longer clips and higher quality than HF Space. ' +
    'Requires API key from platform.minimaxi.com. video-01 caps at 6s, video-02 at 10s.',

  availability() {
    return config.minimax.apiKey
      ? { available: true }
      : { available: false, reason: 'MINIMAX_API_KEY is not set — get one at platform.minimaxi.com' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const model = req.model ?? 'video-01';
    const seconds = Math.min(Math.max(req.durationSeconds ?? 6, 2), model === 'video-02' ? 10 : 6);

    const input: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      duration: seconds,
      aspect_ratio: req.aspectRatio ?? '16:9',
    };

    if (req.sourceImage) {
      input.image_url = req.sourceImage;
    }

    ctx.onProgress(`submitting to MiniMax API: ${model} (${seconds}s)`);

    const res = await fetchWithTimeout(
      `${BASE_URL}/${req.sourceImage ? 'image_to_video' : 'video_generation'}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.minimax.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        timeoutMs: 600_000,
      },
      ctx.signal,
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`MiniMax API HTTP ${res.status}: ${detail}`, 502);
    }

    const body = (await res.json()) as { video_url?: string; url?: string; task_id?: string };
    const videoUrl = body.video_url ?? body.url;
    if (!videoUrl) {
      throw new ProviderError('MiniMax API returned no video URL', 502);
    }

    ctx.onProgress('downloading result from MiniMax');
    const { data, mimeType } = await downloadVideo(videoUrl, ctx);

    return [await saveArtifact(data, mimeType)];
  },
};

async function downloadVideo(url: string, ctx: GenerationContext): Promise<{ data: Uint8Array; mimeType: string }> {
  const res = await fetch(url, { signal: ctx.signal });
  if (!res.ok) throw new ProviderError(`download failed (HTTP ${res.status})`, 502);
  const data = new Uint8Array(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4';
  ctx.onProgress(`received ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return { data, mimeType };
}
