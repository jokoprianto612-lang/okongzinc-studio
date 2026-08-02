/**
 * Modal-hosted TRELLIS.2 provider (image → 3D mesh).
 *
 * microsoft/TRELLIS.2 requires an NVIDIA GPU with >=24GB VRAM (verified from
 * the upstream README: tested on A100/H100, CUDA 12.4). That rules out running
 * it on a typical laptop, so this provider calls a Modal web endpoint that
 * wraps the model on an A100. Deploy `modal/trellis_app.py` first, then set
 * MODAL_TRELLIS_URL to the endpoint Modal prints.
 *
 * Contract with the Modal worker:
 *   POST { image_base64, mime_type, seed?, texture_size? }
 *   →    { glb_base64, filename }
 */

import { config } from '../config.js';
import { readSourceImage, saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest } from '../types.js';
import { fetchWithTimeout, ProviderError, type GenerationContext, type Provider } from './types.js';

export const modalTrellisProvider: Provider = {
  id: 'modal-trellis',
  label: 'TRELLIS.2 on Modal (image → 3D)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  // 3D output has no aspect ratio; the field is unused for this modality.
  supportedAspectRatios: ['1:1'],
  models: [{ id: 'trellis2-image-large', label: 'TRELLIS.2 Image Large' }],
  typicalLatency: '30s-3min (plus cold start)',
  tier: 'standard',
  priceRange: 'Modal GPU seconds (A100)',
  notes:
    'Needs a deployed Modal endpoint — TRELLIS.2 requires a >=24GB NVIDIA GPU ' +
    'and cannot run on a normal laptop. Outputs a .glb mesh.',

  availability() {
    if (!config.modal.trellisUrl) {
      return {
        available: false,
        reason: 'MODAL_TRELLIS_URL is not set — deploy modal/trellis_app.py first',
      };
    }
    return { available: true };
  },

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!config.modal.trellisUrl) {
      throw new ProviderError('MODAL_TRELLIS_URL is not set', 503);
    }
    if (!req.sourceImage) {
      throw new ProviderError('TRELLIS.2 needs a source image (image → 3D)', 400);
    }

    ctx.onProgress('reading source image');
    const src = await readSourceImage(req.sourceImage);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.modal.trellisToken) {
      headers.Authorization = `Bearer ${config.modal.trellisToken}`;
    }

    ctx.onProgress('calling Modal TRELLIS.2 endpoint (cold start can take ~1 min)');

    const res = await fetchWithTimeout(
      config.modal.trellisUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          image_base64: Buffer.from(src.data).toString('base64'),
          mime_type: src.mimeType,
          seed: req.seed ?? 1,
        }),
        // Cold start + inference; generous but bounded.
        timeoutMs: 900_000,
      },
      ctx.signal,
    );

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(`Modal TRELLIS.2 returned HTTP ${res.status} — ${detail}`, 502);
    }

    const body = (await res.json()) as { glb_base64?: string; error?: string };
    if (body.error) throw new ProviderError(`TRELLIS.2 worker error: ${body.error}`, 502);
    if (!body.glb_base64) {
      throw new ProviderError('Modal TRELLIS.2 response contained no glb_base64', 502);
    }

    const data = new Uint8Array(Buffer.from(body.glb_base64, 'base64'));
    ctx.onProgress(`received mesh (${(data.byteLength / 1024 / 1024).toFixed(1)} MB)`);

    return [await saveArtifact(data, 'model/gltf-binary')];
  },
};
