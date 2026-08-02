/**
 * OpenAI-compatible image provider.
 *
 * Targets any endpoint that implements `POST /v1/images/generations` — the
 * official API, a self-hosted gateway, or a compatible proxy. Disabled unless
 * OPENAI_API_KEY is set.
 */

import { config } from '../config.js';
import { saveArtifact } from '../storage.js';
import { ASPECT_DIMENSIONS, type Artifact, type GenerateRequest } from '../types.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';

/** OpenAI's images API takes explicit pixel sizes, not ratios. */
const SIZE_BY_ASPECT: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1024x1024',
  '3:4': '1024x1536',
};

export const openaiImageProvider: Provider = {
  id: 'openai-image',
  label: 'OpenAI-compatible Image',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16'],
  models: [
    { id: 'gpt-image-1', label: 'gpt-image-1' },
    { id: 'dall-e-3', label: 'dall-e-3' },
  ],
  typicalLatency: '10-40s',
  tier: 'standard',
  priceRange: 'billed to your OpenAI key',
  notes: 'Works against any endpoint speaking POST /v1/images/generations.',

  availability() {
    return config.openai.apiKey
      ? { available: true }
      : { available: false, reason: 'OPENAI_API_KEY is not set' };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!config.openai.apiKey) {
      throw new ProviderError('OPENAI_API_KEY is not set', 503);
    }

    const model = req.model || config.openai.imageModel;
    const aspect = req.aspectRatio ?? '1:1';
    const size = SIZE_BY_ASPECT[aspect] ?? '1024x1024';

    ctx.onProgress(`calling ${model} at ${size}`);

    const res = await fetchWithTimeout(
      `${config.openai.baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openai.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, prompt: req.prompt, n: 1, size }),
        timeoutMs: 300_000,
      },
      ctx.signal,
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`Image API returned HTTP ${res.status} — ${detail}`, 502);
    }

    const body = (await res.json()) as {
      data?: { b64_json?: string; url?: string }[];
    };
    const first = body.data?.[0];
    if (!first) throw new ProviderError('Image API returned no data', 502);

    let bytes: Uint8Array;
    let mimeType = 'image/png';

    if (first.b64_json) {
      bytes = new Uint8Array(Buffer.from(first.b64_json, 'base64'));
    } else if (first.url) {
      ctx.onProgress('downloading result');
      const dl = await fetchWithTimeout(first.url, { method: 'GET', timeoutMs: 120_000 }, ctx.signal);
      if (!dl.ok) throw new ProviderError(`failed to download image (HTTP ${dl.status})`, 502);
      bytes = new Uint8Array(await dl.arrayBuffer());
      mimeType = dl.headers.get('content-type')?.split(';')[0] ?? 'image/png';
    } else {
      throw new ProviderError('Image API response had neither b64_json nor url', 502);
    }

    const dims = ASPECT_DIMENSIONS[aspect];
    return [await saveArtifact(bytes, mimeType, { width: dims.width, height: dims.height })];
  },
};
