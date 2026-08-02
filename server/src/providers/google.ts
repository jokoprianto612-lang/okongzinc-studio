/**
 * Google Gemini image + Veo video providers.
 *
 * Both use the same `GOOGLE_API_KEY`. Two different API shapes:
 *
 *   - Gemini image  → POST :generateContent with responseModalities:['IMAGE'],
 *                     image comes back as inline base64.
 *   - Veo video     → POST :predictLongRunning returns an operation name that
 *                     must be polled until `done`, then the file is fetched
 *                     with the key appended.
 *
 * Verified 2026-08-01: both endpoints accept these payload shapes. A free-tier
 * key returns HTTP 429 RESOURCE_EXHAUSTED once its small media quota is spent —
 * that surfaces to the user as a quota message, not a generic failure.
 */

import { config } from '../config.js';
import { saveArtifact } from '../storage.js';
import { readSourceImage } from '../storage.js';
import { ASPECT_DIMENSIONS, type Artifact, type GenerateRequest } from '../types.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';

function requireKey(): string {
  if (!config.google.apiKey) {
    throw new ProviderError('GOOGLE_API_KEY is not set', 503);
  }
  return config.google.apiKey;
}

/** Turns Google's error envelope into a message worth showing a human. */
async function googleError(res: Response, label: string): Promise<ProviderError> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
    if (parsed.error?.status === 'RESOURCE_EXHAUSTED' || res.status === 429) {
      return new ProviderError(
        `${label}: Google API quota exhausted for this key. Free-tier media quota ` +
          `is small — enable billing or wait for the window to reset.`,
        429,
      );
    }
  } catch {
    // leave detail as raw text
  }
  return new ProviderError(`${label}: HTTP ${res.status} — ${detail}`, 502);
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export const googleImageProvider: Provider = {
  id: 'google-image',
  label: 'Google Gemini Image',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image' },
    { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image' },
  ],
  typicalLatency: '5-20s',
  tier: 'standard',
  priceRange: 'billed to your Google API key',
  notes: 'Also accepts a source image for editing (image-to-image).',

  availability() {
    return config.google.apiKey
      ? { available: true }
      : { available: false, reason: 'GOOGLE_API_KEY is not set' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const key = requireKey();
    const model = req.model || config.google.imageModel;
    const aspect = req.aspectRatio ?? '1:1';

    const parts: Record<string, unknown>[] = [{ text: req.prompt }];

    // Optional image-to-image: prepend the source as inline data.
    if (req.sourceImage) {
      ctx.onProgress('reading source image');
      const src = await readSourceImage(req.sourceImage);
      parts.unshift({
        inlineData: {
          mimeType: src.mimeType,
          data: Buffer.from(src.data).toString('base64'),
        },
      });
    }

    ctx.onProgress(`calling ${model}`);

    const res = await fetchWithTimeout(
      `${config.google.baseUrl}/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: aspect },
          },
        }),
        timeoutMs: 180_000,
      },
      ctx.signal,
    );

    if (!res.ok) throw await googleError(res, 'Gemini image');

    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[];
    };

    const inline = body.candidates
      ?.flatMap((c) => c.content?.parts ?? [])
      .find((p) => p.inlineData)?.inlineData;

    if (!inline) {
      throw new ProviderError(
        'Gemini returned no image data (the prompt may have been refused by safety filters)',
        502,
      );
    }

    const data = new Uint8Array(Buffer.from(inline.data, 'base64'));
    const dims = ASPECT_DIMENSIONS[aspect];
    ctx.onProgress(`received ${(data.byteLength / 1024).toFixed(0)} KB`);

    return [await saveArtifact(data, inline.mimeType, { width: dims.width, height: dims.height })];
  },
};

// ---------------------------------------------------------------------------
// Video (Veo)
// ---------------------------------------------------------------------------

const VEO_POLL_INTERVAL_MS = 8_000;
const VEO_MAX_WAIT_MS = 10 * 60 * 1000;

export const googleVideoProvider: Provider = {
  id: 'google-veo',
  label: 'Google Veo (video)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16'],
  models: [{ id: 'veo-3.1-generate-preview', label: 'Veo 3.1 (preview)' }],
  typicalLatency: '1-5 min',
  tier: 'premium',
  priceRange: 'billed to your Google API key',
  producesAudio: true,
  notes:
    'Long-running operation: the job polls until Google reports done. Accepts an ' +
    'optional source image for image-to-video.',

  availability() {
    return config.google.apiKey
      ? { available: true }
      : { available: false, reason: 'GOOGLE_API_KEY is not set' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const key = requireKey();
    const model = req.model || config.google.videoModel;

    const instance: Record<string, unknown> = { prompt: req.prompt };
    if (req.sourceImage) {
      ctx.onProgress('reading source image');
      const src = await readSourceImage(req.sourceImage);
      instance.image = {
        bytesBase64Encoded: Buffer.from(src.data).toString('base64'),
        mimeType: src.mimeType,
      };
    }

    const parameters: Record<string, unknown> = {
      aspectRatio: req.aspectRatio === '9:16' ? '9:16' : '16:9',
    };
    if (req.negativePrompt) parameters.negativePrompt = req.negativePrompt;
    if (req.durationSeconds) parameters.durationSeconds = req.durationSeconds;

    ctx.onProgress(`submitting ${model} operation`);

    const startRes = await fetchWithTimeout(
      `${config.google.baseUrl}/models/${model}:predictLongRunning?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instances: [instance], parameters }),
        timeoutMs: 120_000,
      },
      ctx.signal,
    );

    if (!startRes.ok) throw await googleError(startRes, 'Veo submit');

    const started = (await startRes.json()) as { name?: string };
    if (!started.name) {
      throw new ProviderError('Veo did not return an operation name', 502);
    }

    // Poll the operation until done or timeout.
    const deadline = Date.now() + VEO_MAX_WAIT_MS;
    let uri: string | undefined;

    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new ProviderError('job cancelled', 499);
      await new Promise((r) => setTimeout(r, VEO_POLL_INTERVAL_MS));

      const elapsed = Math.round((VEO_MAX_WAIT_MS - (deadline - Date.now())) / 1000);
      ctx.onProgress(`rendering — polling operation (${elapsed}s elapsed)`);

      const pollRes = await fetchWithTimeout(
        `${config.google.baseUrl}/${started.name}?key=${key}`,
        { method: 'GET', timeoutMs: 60_000 },
        ctx.signal,
      );
      if (!pollRes.ok) throw await googleError(pollRes, 'Veo poll');

      const op = (await pollRes.json()) as {
        done?: boolean;
        error?: { message?: string };
        response?: {
          generateVideoResponse?: {
            generatedSamples?: { video?: { uri?: string } }[];
          };
        };
      };

      if (op.error?.message) {
        throw new ProviderError(`Veo failed: ${op.error.message}`, 502);
      }
      if (op.done) {
        uri = op.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        break;
      }
    }

    if (!uri) {
      throw new ProviderError(
        'Veo did not produce a video within the time budget (10 min)',
        504,
      );
    }

    ctx.onProgress('downloading rendered video');

    // The download URI needs the API key appended.
    const sep = uri.includes('?') ? '&' : '?';
    const fileRes = await fetchWithTimeout(
      `${uri}${sep}key=${key}`,
      { method: 'GET', timeoutMs: 300_000 },
      ctx.signal,
    );
    if (!fileRes.ok) throw await googleError(fileRes, 'Veo download');

    const data = new Uint8Array(await fileRes.arrayBuffer());
    ctx.onProgress(`received ${(data.byteLength / 1024 / 1024).toFixed(1)} MB`);

    return [await saveArtifact(data, fileRes.headers.get('content-type') ?? 'video/mp4')];
  },
};
