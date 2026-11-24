/**
 * pi-H3 via HuggingFace Space (Gradio API).
 *
 * Lakonik/pi-H3 — MiniMax H3 video in 2-4 steps without a VAE decoder.
 * Runs on HF ZeroGPU. Takes a prompt (+ optional opening/closing keyframes),
 * an aspect ratio, megapixels, duration, steps, and a remove_decoder toggle,
 * then returns an MP4 with audio.
 *
 * Space URL: https://huggingface.co/spaces/Lakonik/pi-H3
 * Subdomain: https://lakonik-pi-h3.hf.space
 *
 * The Space declares hf_oauth: true, so anonymous calls may be rejected — set
 * HF_TOKEN in `.env` if you have a token with access. Videos land between
 * ~5.2s (124 frames) and ~14.4s (345 frames) at 24 fps, in 17n+5 frame steps.
 *
 * Limits: ZeroGPU per-request GPU duration (~180s) and daily quota.
 */

import { config } from '../config.js';
import { saveArtifact } from '../storage.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';
import type { Artifact, AspectRatio, GenerateRequest } from '../types.js';

const SPACE_NAME = 'Lakonik/pi-H3';

const ASPECT_RATIOS: AspectRatio[] = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const DEFAULT_ASPECT_RATIO = '16:9';
const FPS = 24;
const MIN_DURATION = 5;
const MAX_DURATION = 15;

/** pi-H3 renders 17n + 5 frames at 24 fps — clamp duration to the valid span. */
function snapDuration(seconds: number): number {
  const clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, seconds));
  // num_frames = clamp(round((duration*24 - 5)/17), 7, 20) * 17 + 5
  // invert: pick the largest frames value whose rendered duration <= clamped
  let frames = 124; // 5.2 s
  for (let n = 7; n <= 20; n++) {
    const candidate = n * 17 + 5;
    if (candidate / FPS <= clamped) frames = candidate;
  }
  return frames / FPS;
}

async function downloadVideo(url: string, ctx: GenerationContext): Promise<{ data: Uint8Array; mimeType: string }> {
  const res = await fetch(url, { signal: ctx.signal });
  if (!res.ok) throw new ProviderError(`download failed (HTTP ${res.status})`, 502);
  const data = new Uint8Array(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4';
  ctx.onProgress(`received ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return { data, mimeType };
}

export const hfPiH3Provider: Provider = {
  id: 'hf-pi-h3',
  label: 'pi-H3 (Lakonik HF Space)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ASPECT_RATIOS,
  models: [{ id: 'pi-h3', label: 'pi-H3 — 2-4 step MiniMax H3 video' }],
  typicalLatency: '2-6 min (ZeroGPU queue + 2-4 step denoise)',
  tier: 'free',
  priceRange: 'free (ZeroGPU, quota-limited, hf_oauth may require token)',
  producesAudio: true,
  notes:
    'MiniMax H3 video in 2-4 steps without a VAE decoder, on HuggingFace ZeroGPU. ' +
    'Accepts an optional source image as the opening keyframe and an optional ' +
    'referenceImages[0] as the closing keyframe. Duration is clamped to 5-15s ' +
    '(17n+5 frames at 24 fps). hf_oauth is enabled on the Space, so anonymous ' +
    'runs may be rejected — set HF_TOKEN if you have access.',

  availability() {
    return { available: true };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    let Client: any;
    try {
      const mod = await import('@gradio/client');
      Client = mod.Client;
    } catch {
      throw new ProviderError(
        '@gradio/client is not installed. Run `npm install @gradio/client` to use this provider.',
        503,
      );
    }

    const aspectRatio =
      req.aspectRatio && ASPECT_RATIOS.includes(req.aspectRatio)
        ? req.aspectRatio
        : DEFAULT_ASPECT_RATIO;
    const seconds = snapDuration(req.durationSeconds ?? 10);
    const frames = Math.round(seconds * FPS);

    const headers: Record<string, string> = {};
    if (config.hf.token) {
      headers['Authorization'] = `Bearer ${config.hf.token}`;
    }

    ctx.onProgress(`connecting to HF Space: ${SPACE_NAME}`);
    const client = await Client.connect(SPACE_NAME, headers);

    ctx.onProgress(
      `submitting — ${seconds.toFixed(1)}s (${frames}f) ${aspectRatio}, 4-step`,
    );

    const result = await client.predict(
      '/generate',
      {
        seed: req.seed ?? Math.floor(Math.random() * 2 ** 31),
        prompt: req.prompt,
        in_image: req.sourceImage ?? null,
        in_last_image: (req.referenceImages ?? [])[0] ?? null,
        aspect_ratio: aspectRatio,
        megapixels: 1,
        duration: seconds,
        steps: 4,
        remove_decoder: false,
      },
      { timeout: 600000 },
    );

    const videoUrl =
      result?.video?.url ?? result?.video_url ?? result?.url ?? result?.video;
    if (!videoUrl) {
      throw new ProviderError('HF Space returned no video URL in response', 502);
    }

    ctx.onProgress('downloading video from HF');
    const { data, mimeType } = await downloadVideo(videoUrl, ctx);

    return [await saveArtifact(data, mimeType)];
  },
};
