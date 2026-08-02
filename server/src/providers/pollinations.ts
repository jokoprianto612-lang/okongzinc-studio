/**
 * Pollinations image provider.
 *
 * Free text-to-image with no API key and no signup: the prompt is URL-encoded
 * into the path and the response body is the JPEG itself. This is the default
 * provider so the app works immediately after `npm install`.
 *
 * Verified 2026-08-01: GET returns image/jpeg, ~2-45s depending on queue depth.
 */

import { config } from '../config.js';
import { saveArtifact } from '../storage.js';
import { ASPECT_DIMENSIONS, type Artifact, type AspectRatio, type GenerateRequest } from '../types.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';

const MODELS = [
  { id: 'flux', label: 'Flux (default, best quality)' },
  { id: 'turbo', label: 'Turbo (fastest)' },
  { id: 'kontext', label: 'Kontext (prompt adherence)' },
];

export const pollinationsProvider: Provider = {
  id: 'pollinations',
  label: 'Pollinations (free, no key)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: MODELS,
  typicalLatency: '3-45s',
  tier: 'free',
  priceRange: 'free',
  notes: 'No credentials required. Queue depth varies, so latency is uneven.',

  availability() {
    if (!config.pollinations.enabled) {
      return { available: false, reason: 'POLLINATIONS_ENABLED is false' };
    }
    return { available: true };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const aspect: AspectRatio = req.aspectRatio ?? '1:1';
    const dims = ASPECT_DIMENSIONS[aspect];
    const model = req.model && MODELS.some((m) => m.id === req.model) ? req.model : 'flux';

    const params = new URLSearchParams({
      width: String(dims.width),
      height: String(dims.height),
      model,
      nologo: 'true',
    });
    if (req.seed !== undefined) params.set('seed', String(req.seed));

    const url = `${config.pollinations.baseUrl}/prompt/${encodeURIComponent(req.prompt)}?${params}`;

    ctx.onProgress(`requesting ${model} at ${dims.width}x${dims.height}`);

    const res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        // Pollinations rejects some default runtime user agents.
        headers: { 'User-Agent': 'OkongzINC-Studio/0.1' },
        timeoutMs: 180_000,
      },
      ctx.signal,
    );

    if (!res.ok) {
      throw new ProviderError(`Pollinations returned HTTP ${res.status}`, 502);
    }

    const data = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength === 0) {
      throw new ProviderError('Pollinations returned an empty body', 502);
    }

    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    ctx.onProgress(`received ${(data.byteLength / 1024).toFixed(0)} KB`);

    const artifact = await saveArtifact(data, mimeType, {
      width: dims.width,
      height: dims.height,
    });
    return [artifact];
  },
};
