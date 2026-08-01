/**
 * fal.ai providers — hosted models across all three modalities.
 *
 * One API key unlocks image, video, and 3D. Every schema below was read from
 * fal's live OpenAPI spec on 2026-08-01 rather than guessed:
 *
 *   GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
 *
 * Why this exists alongside the Modal workers: fal already hosts the exact
 * models we were going to self-host, at roughly a tenth of the cost and with no
 * weight download or idle storage bill.
 *
 *   LongCat-Video 480p distilled   $0.005 / generated second
 *   LongCat-Video 720p distilled   $0.01
 *   LongCat-Video 480p full        $0.025
 *   Seedance 2.0 mini 480p         ~$0.072
 *   Seedance 2.0 720p              ~$0.303
 *   TRELLIS-2 512p                 $0.25 per generation
 *
 * The Modal workers stay in the repo for the case fal cannot serve: full
 * control over weights, no third-party content gate, no per-request billing.
 *
 * All calls go through fal's QUEUE API (queue.fal.run), not the synchronous
 * endpoint. Video generation regularly exceeds any sane HTTP timeout, and the
 * queue gives a pollable request id instead.
 */

import { config } from '../config.js';
import { readSourceImage, saveArtifact } from '../storage.js';
import type { Artifact, AspectRatio, GenerateRequest } from '../types.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';

const QUEUE_BASE = 'https://queue.fal.run';
const UPLOAD_URL = 'https://rest.alpha.fal.ai/storage/upload/initiate';

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000;

function requireKey(): string {
  if (!config.fal.apiKey) {
    throw new ProviderError('FAL_KEY is not set', 503);
  }
  return config.fal.apiKey;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Key ${requireKey()}`,
    'Content-Type': 'application/json',
  };
}

/** fal's error envelope is `{detail: string | [{msg, loc}]}`. Make it readable. */
async function falError(res: Response, label: string): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const d = parsed.detail;
    if (typeof d === 'string') {
      detail = d;
    } else if (Array.isArray(d)) {
      detail = d
        .map((item) => {
          const it = item as { msg?: string; loc?: unknown[] };
          const where = Array.isArray(it.loc) ? it.loc.join('.') : '';
          return where ? `${where}: ${it.msg}` : String(it.msg);
        })
        .join('; ');
    }
  } catch {
    // keep raw text
  }
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`${label}: fal rejected the key (HTTP ${res.status})`, 401);
  }
  if (res.status === 402) {
    return new ProviderError(`${label}: fal account is out of credit (HTTP 402)`, 402);
  }
  return new ProviderError(`${label}: HTTP ${res.status} — ${detail}`, 502);
}

/**
 * Upload a local image to fal's storage and return its public URL.
 *
 * Every fal image-input endpoint takes `image_url`, not raw bytes, so a
 * `/media/...` artifact has to be uploaded before it can be used as a source.
 * A remote URL is passed straight through — no need to round-trip it.
 */
async function resolveImageUrl(
  source: string,
  ctx: GenerationContext,
): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return source;
  }

  ctx.onProgress('uploading source image to fal storage');
  const { data, mimeType } = await readSourceImage(source);

  // Two-step: initiate returns a signed PUT target plus the eventual file URL.
  const initRes = await fetchWithTimeout(
    UPLOAD_URL,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content_type: mimeType, file_name: 'source' }),
      timeoutMs: 60_000,
    },
    ctx.signal,
  );
  if (!initRes.ok) throw await falError(initRes, 'fal upload initiate');

  const init = (await initRes.json()) as { upload_url?: string; file_url?: string };
  if (!init.upload_url || !init.file_url) {
    throw new ProviderError('fal upload initiate returned no upload_url/file_url', 502);
  }

  const putRes = await fetchWithTimeout(
    init.upload_url,
    {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: data,
      timeoutMs: 180_000,
    },
    ctx.signal,
  );
  if (!putRes.ok) {
    throw new ProviderError(`fal upload PUT failed (HTTP ${putRes.status})`, 502);
  }

  return init.file_url;
}

/** A file entry in a fal response. */
interface FalFile {
  url?: string;
  content_type?: string;
  file_size?: number;
  file_name?: string;
}

/**
 * Submit to the queue, poll until completion, return the parsed payload.
 *
 * fal's queue returns 200 with `{status: 'IN_QUEUE'|'IN_PROGRESS'|'COMPLETED'}`
 * from the status URL; the result lives at `response_url` once completed.
 */
async function runQueued(
  endpointId: string,
  input: Record<string, unknown>,
  ctx: GenerationContext,
): Promise<Record<string, unknown>> {
  const submitRes = await fetchWithTimeout(
    `${QUEUE_BASE}/${endpointId}`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
      timeoutMs: 120_000,
    },
    ctx.signal,
  );
  if (!submitRes.ok) throw await falError(submitRes, `fal submit ${endpointId}`);

  const queued = (await submitRes.json()) as {
    request_id?: string;
    status_url?: string;
    response_url?: string;
  };
  if (!queued.status_url || !queued.response_url) {
    throw new ProviderError('fal queue response had no status_url/response_url', 502);
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastStatus = 'IN_QUEUE';

  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new ProviderError('job cancelled', 499);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statusRes = await fetchWithTimeout(
      queued.status_url,
      { method: 'GET', headers: authHeaders(), timeoutMs: 60_000 },
      ctx.signal,
    );
    if (!statusRes.ok) throw await falError(statusRes, 'fal status');

    const status = (await statusRes.json()) as {
      status?: string;
      queue_position?: number;
      error?: unknown;
    };

    if (status.status && status.status !== lastStatus) {
      lastStatus = status.status;
    }

    const elapsed = Math.round((MAX_WAIT_MS - (deadline - Date.now())) / 1000);
    const position =
      typeof status.queue_position === 'number' && status.queue_position > 0
        ? ` (queue position ${status.queue_position})`
        : '';
    ctx.onProgress(`${lastStatus.toLowerCase().replace('_', ' ')}${position} — ${elapsed}s elapsed`);

    if (status.status === 'COMPLETED') {
      const resultRes = await fetchWithTimeout(
        queued.response_url,
        { method: 'GET', headers: authHeaders(), timeoutMs: 120_000 },
        ctx.signal,
      );
      if (!resultRes.ok) throw await falError(resultRes, 'fal result');
      return (await resultRes.json()) as Record<string, unknown>;
    }

    if (status.error) {
      throw new ProviderError(`fal job failed: ${JSON.stringify(status.error).slice(0, 240)}`, 502);
    }
  }

  throw new ProviderError('fal job did not complete within 15 minutes', 504);
}

/** Download a produced file and persist it as an artifact. */
async function persistFalFile(
  file: FalFile,
  ctx: GenerationContext,
  fallbackMime: string,
  dims?: { width?: number; height?: number },
): Promise<Artifact> {
  if (!file.url) throw new ProviderError('fal result file had no url', 502);

  ctx.onProgress('downloading result from fal');
  const res = await fetchWithTimeout(
    file.url,
    { method: 'GET', timeoutMs: 600_000 },
    ctx.signal,
  );
  if (!res.ok) {
    throw new ProviderError(`failed to download fal output (HTTP ${res.status})`, 502);
  }

  const data = new Uint8Array(await res.arrayBuffer());
  const mimeType =
    file.content_type || res.headers.get('content-type')?.split(';')[0] || fallbackMime;

  ctx.onProgress(`received ${(data.byteLength / 1024 / 1024).toFixed(2)} MB`);
  return saveArtifact(data, mimeType, dims ?? {});
}

// ---------------------------------------------------------------------------
// Image — LongCat-Image
// ---------------------------------------------------------------------------

/** fal's LongCat-Image takes a named size, not width/height. */
const FAL_IMAGE_SIZE: Record<AspectRatio, string> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

export const falImageProvider: Provider = {
  id: 'fal-longcat-image',
  label: 'LongCat Image (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: 'fal-ai/longcat-image', label: 'LongCat Image (text→image)' },
    { id: 'fal-ai/longcat-image/edit', label: 'LongCat Image Edit (needs a source)' },
  ],
  typicalLatency: '5-20s',
  notes: 'Hosted on fal. The edit variant transforms a source image.',

  availability() {
    return config.fal.apiKey
      ? { available: true }
      : { available: false, reason: 'FAL_KEY is not set — get one at fal.ai/dashboard/keys' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint = req.model || 'fal-ai/longcat-image';
    const isEdit = endpoint.endsWith('/edit');

    if (isEdit && !req.sourceImage) {
      throw new ProviderError('LongCat Image Edit needs a source image', 400);
    }

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      image_size: FAL_IMAGE_SIZE[req.aspectRatio ?? '1:1'],
      output_format: 'png',
      num_images: 1,
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.sourceImage) {
      input.image_url = await resolveImageUrl(req.sourceImage, ctx);
    }

    ctx.onProgress(`submitting to ${endpoint}`);
    const result = await runQueued(endpoint, input, ctx);

    const images = result.images as FalFile[] | undefined;
    const first = images?.[0];
    if (!first) throw new ProviderError('fal returned no images', 502);

    return [await persistFalFile(first, ctx, 'image/png')];
  },
};

// ---------------------------------------------------------------------------
// Video — LongCat-Video
// ---------------------------------------------------------------------------

/**
 * LongCat endpoints encode task and resolution in the path, so the UI's "model"
 * is really an endpoint choice. Prices are per generated second.
 */
const LONGCAT_VIDEO_MODELS = [
  {
    id: 'fal-ai/longcat-video/distilled/text-to-video/480p',
    label: 'Text→Video 480p distilled — $0.005/s (cheapest)',
  },
  {
    id: 'fal-ai/longcat-video/distilled/text-to-video/720p',
    label: 'Text→Video 720p distilled — $0.01/s',
  },
  {
    id: 'fal-ai/longcat-video/text-to-video/480p',
    label: 'Text→Video 480p full — $0.025/s',
  },
  {
    id: 'fal-ai/longcat-video/text-to-video/720p',
    label: 'Text→Video 720p full — $0.04/s',
  },
  {
    id: 'fal-ai/longcat-video/distilled/image-to-video/480p',
    label: 'Image→Video 480p distilled — $0.005/s',
  },
  {
    id: 'fal-ai/longcat-video/distilled/image-to-video/720p',
    label: 'Image→Video 720p distilled — $0.01/s',
  },
  {
    id: 'fal-ai/longcat-video/image-to-video/480p',
    label: 'Image→Video 480p full — $0.025/s',
  },
  {
    id: 'fal-ai/longcat-video/image-to-video/720p',
    label: 'Image→Video 720p full — $0.04/s',
  },
];

export const falLongcatVideoProvider: Provider = {
  id: 'fal-longcat-video',
  label: 'LongCat-Video (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9', '9:16'],
  models: LONGCAT_VIDEO_MODELS,
  typicalLatency: '1-6 min',
  notes:
    'The same 13.6B model as the Modal worker, hosted. Distilled 480p is ' +
    '$0.005 per generated second — a 6s clip costs about 3 cents. Frames are ' +
    'counted at 15fps (480p) or 30fps (720p); duration sets num_frames.',

  availability() {
    return config.fal.apiKey
      ? { available: true }
      : { available: false, reason: 'FAL_KEY is not set — get one at fal.ai/dashboard/keys' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint = req.model || 'fal-ai/longcat-video/distilled/text-to-video/480p';
    const isImageToVideo = endpoint.includes('/image-to-video/');
    const is720p = endpoint.endsWith('/720p');

    if (isImageToVideo && !req.sourceImage) {
      throw new ProviderError('this LongCat endpoint is image→video and needs a source image', 400);
    }

    const fps = is720p ? 30 : 15;
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      fps,
      video_output_type: 'X264 (.mp4)',
      video_quality: 'high',
    };

    // num_frames range verified from the OpenAPI spec: 17..961, default 162.
    if (req.durationSeconds) {
      input.num_frames = Math.min(Math.max(req.durationSeconds * fps, 17), 961);
    }
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.aspectRatio && !isImageToVideo) input.aspect_ratio = req.aspectRatio;
    if (req.sourceImage) {
      input.image_url = await resolveImageUrl(req.sourceImage, ctx);
    }

    ctx.onProgress(`submitting to ${endpoint} at ${fps}fps`);
    const result = await runQueued(endpoint, input, ctx);

    const video = result.video as FalFile | undefined;
    if (!video) throw new ProviderError('fal returned no video', 502);

    return [await persistFalFile(video, ctx, 'video/mp4')];
  },
};

// ---------------------------------------------------------------------------
// Video — Seedance 2.0
// ---------------------------------------------------------------------------

const SEEDANCE_MODELS = [
  { id: 'bytedance/seedance-2.0/mini/text-to-video', label: 'Seedance 2.0 mini T2V — ~$0.072/s @480p' },
  { id: 'bytedance/seedance-2.0/fast/text-to-video', label: 'Seedance 2.0 fast T2V — ~$0.242/s @720p' },
  { id: 'bytedance/seedance-2.0/text-to-video', label: 'Seedance 2.0 T2V — ~$0.303/s @720p' },
  { id: 'bytedance/seedance-2.0/mini/image-to-video', label: 'Seedance 2.0 mini I2V (needs source)' },
  { id: 'bytedance/seedance-2.0/fast/image-to-video', label: 'Seedance 2.0 fast I2V (needs source)' },
  { id: 'bytedance/seedance-2.0/image-to-video', label: 'Seedance 2.0 I2V (needs source)' },
];

export const falSeedanceProvider: Provider = {
  id: 'fal-seedance',
  label: 'Seedance 2.0 (fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3'],
  models: SEEDANCE_MODELS,
  typicalLatency: '1-5 min',
  notes:
    'ByteDance Seedance 2.0, up to 4K, with optional generated audio. Duration ' +
    'is 4-15s (the API takes discrete values). The mini tier is ~4x cheaper ' +
    'than the full tier.',

  availability() {
    return config.fal.apiKey
      ? { available: true }
      : { available: false, reason: 'FAL_KEY is not set — get one at fal.ai/dashboard/keys' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint = req.model || 'bytedance/seedance-2.0/mini/text-to-video';
    const isImageToVideo = endpoint.includes('/image-to-video');

    if (isImageToVideo && !req.sourceImage) {
      throw new ProviderError('this Seedance endpoint is image→video and needs a source image', 400);
    }

    // duration is an enum of stringified integers 4..15 (plus 'auto').
    const seconds = req.durationSeconds
      ? String(Math.min(Math.max(req.durationSeconds, 4), 15))
      : 'auto';

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // mini is only rated to 720p; asking for more on that tier is a 422.
      resolution: endpoint.includes('/mini/') ? '480p' : '720p',
      duration: seconds,
      aspect_ratio: req.aspectRatio ?? 'auto',
    };
    if (req.sourceImage) {
      input.image_url = await resolveImageUrl(req.sourceImage, ctx);
    }

    ctx.onProgress(`submitting to ${endpoint}`);
    const result = await runQueued(endpoint, input, ctx);

    const video = result.video as FalFile | undefined;
    if (!video) throw new ProviderError('fal returned no video', 502);

    return [await persistFalFile(video, ctx, 'video/mp4')];
  },
};

// ---------------------------------------------------------------------------
// 3D — TRELLIS-2
// ---------------------------------------------------------------------------

export const falTrellisProvider: Provider = {
  id: 'fal-trellis',
  label: 'TRELLIS-2 (fal)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: 'fal-ai/trellis-2', label: 'TRELLIS-2 — $0.25 @512p, $0.30 @1024p' },
    { id: 'fal-ai/trellis', label: 'TRELLIS (v1)' },
  ],
  typicalLatency: '30s-2min',
  notes:
    'The same model as the Modal TRELLIS worker, hosted — no 24GB GPU needed. ' +
    'Outputs a .glb mesh.',

  availability() {
    return config.fal.apiKey
      ? { available: true }
      : { available: false, reason: 'FAL_KEY is not set — get one at fal.ai/dashboard/keys' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError('TRELLIS-2 needs a source image (image→3D)', 400);
    }

    const endpoint = req.model || 'fal-ai/trellis-2';
    const input: Record<string, unknown> = {
      image_url: await resolveImageUrl(req.sourceImage, ctx),
    };
    // Only trellis-2 exposes these; v1 ignores unknown fields.
    if (endpoint === 'fal-ai/trellis-2') {
      input.resolution = 512;
      input.texture_size = 1024;
    }
    if (req.seed !== undefined) input.seed = req.seed;

    ctx.onProgress(`submitting to ${endpoint}`);
    const result = await runQueued(endpoint, input, ctx);

    const mesh = (result.model_glb ?? result.model_mesh) as FalFile | undefined;
    if (!mesh) throw new ProviderError('fal returned no mesh', 502);

    return [await persistFalFile(mesh, ctx, 'model/gltf-binary')];
  },
};
