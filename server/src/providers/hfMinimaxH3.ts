/**
 * MiniMax-H3 via HuggingFace Space (Gradio API).
 *
 * Pepe104/MiniMax-H3-Turbo-Lora-UNCENSORED is an unquantized MiniMax-H3 deployment
 * running on ZeroGPU (A10G). This provider calls it through the Gradio client API.
 *
 * The Space is the denoising half of a split deployment — the 77.3 GiB transformer +
 * VAEs. The Qwen3-VL conditioner runs in a separate Space (multimodalart/qwen3vl-conditioner)
 * that this Space calls internally, so callers only need to talk to this one.
 *
 * Limits: ZeroGPU Spaces have per-request GPU duration limits (~180s) and daily quota.
 * Videos are capped at 2-14s. The Space also rejects prompts flagged by an NCII classifier.
 *
 * Space URL: https://huggingface.co/spaces/Pepe104/MiniMax-H3-Turbo-Lora-UNCENSORED
 * HF Token: optional — raises quota when set, works without it.
 */

import { config } from '../config.js';
import { saveArtifact } from '../storage.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

const SPACE_NAME = 'Pepe104/MiniMax-H3-Turbo-Lora-UNCENSORED';

const CANVASES: Record<string, [number, number]> = {
  '960x544 · 16:9 fast': [544, 960],
  '1024x576 · 16:9 fast': [576, 1024],
  '1152x640 · 16:9': [640, 1152],
  '1280x704 · 16:9': [704, 1280],
  '1344x768 · 16:9 full': [768, 1344],
  '544x960 · 9:16 fast': [960, 544],
  '640x1152 · 9:16': [1152, 640],
  '768x1344 · 9:16 full': [1344, 768],
  '544x544 · 1:1 fast': [544, 544],
  '768x768 · 1:1 full': [768, 768],
};

const DEFAULT_CANVAS = '960x544 · 16:9 fast';
const FPS = 24;
const FRAMES_PER_CHUNK = 17;
const LATENTS_PER_CHUNK = 5;
const MIN_DURATION = 2;
const MAX_DURATION = 10;

function snapFrames(seconds: number): number {
  const clamped = Math.max(MIN_DURATION, Math.min(MAX_DURATION, seconds));
  let frames = Math.max(1, Math.round(clamped * FPS));
  while (frames % FRAMES_PER_CHUNK !== LATENTS_PER_CHUNK) {
    frames += 1;
  }
  return frames;
}

function resolveCanvas(canvas: string | undefined): { canvas: string; height: number; width: number } {
  const label = canvas ?? DEFAULT_CANVAS;
  const dims = CANVASES[label];
  if (!dims) {
    return { canvas: DEFAULT_CANVAS, height: CANVASES[DEFAULT_CANVAS][0], width: CANVASES[DEFAULT_CANVAS][1] };
  }
  return { canvas: label, height: dims[0], width: dims[1] };
}

const MODELS = [
  { id: 't2v-960x544', label: 'Text→Video 960x544 (16:9)' },
  { id: 't2v-1280x704', label: 'Text→Video 1280x704 (16:9)' },
  { id: 't2v-640x1152', label: 'Text→Video 640x1152 (9:16)' },
];

async function downloadVideo(url: string, ctx: GenerationContext): Promise<{ data: Uint8Array; mimeType: string }> {
  const res = await fetch(url, { signal: ctx.signal });
  if (!res.ok) throw new ProviderError(`download failed (HTTP ${res.status})`, 502);
  const data = new Uint8Array(await res.arrayBuffer());
  const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4';
  ctx.onProgress(`received ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);
  return { data, mimeType };
}

export const hfMinimaxH3Provider: Provider = {
  id: 'hf-minimax-h3',
  label: 'MiniMax-H3 (HF Space, uncensored)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9', '9:16'],
  supportedResolutions: ['544p', '704p'],
  models: MODELS,
  typicalLatency: '1-5 min (ZeroGPU queue + denoising)',
  tier: 'free',
  priceRange: 'free (ZeroGPU, quota-limited)',
  producesAudio: true,
  notes:
    'MiniMax-H3 Turbo LoRA on HuggingFace ZeroGPU. Uncensored but with NCII guard. ' +
    'Quota-limited — daily cap on anonymous requests, higher with HF token. ' +
    'Only 2-10s clips, fixed canvas presets. Best for quick tests, not production volume.',

  availability() {
    return { available: true };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    let Client: any;
    try {
      const mod = await import('gradio_client');
      Client = mod.Client;
    } catch {
      throw new ProviderError(
        'gradio_client is not installed. Run `npm install gradio_client` to use this provider.',
        503,
      );
    }

    const { canvas, height, width } = resolveCanvas(req.model);
    const frames = snapFrames(req.durationSeconds ?? 6);
    const seconds = frames / FPS;

    const headers: Record<string, string> = {};
    if (config.hf.token) {
      headers['Authorization'] = `Bearer ${config.hf.token}`;
    }

    ctx.onProgress(`connecting to HF Space: ${SPACE_NAME}`);
    const client = await Client.connect(SPACE_NAME, headers);

    ctx.onProgress(`submitting — ${seconds.toFixed(1)}s (${frames}f) ${canvas}, 4-step Turbo LoRA`);

    const result = await client.predict(
      '/generate',
      {
        prompt: req.prompt,
        canvas,
        duration_sec: seconds,
        seed: req.seed ?? 42,
      },
      { timeout: 600000 },
    );

    const videoUrl = result?.video_url ?? result?.url ?? result?.video;
    if (!videoUrl) {
      throw new ProviderError('HF Space returned no video URL in response', 502);
    }

    ctx.onProgress('downloading video from HF');
    const { data, mimeType } = await downloadVideo(videoUrl, ctx);

    return [await saveArtifact(data, mimeType, { width, height })];
  },
};
