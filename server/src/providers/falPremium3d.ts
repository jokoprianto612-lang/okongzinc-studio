/**
 * Premium 3D providers on fal — Tripo3D v2.5 and Hunyuan3D v2.
 *
 * TRELLIS-2 (in `fal.ts`) is already good and cheap at $0.25. These two exist
 * because they are better at things TRELLIS is not:
 *
 *   Tripo3D v2.5   PBR materials, quad topology, and a style transfer pass —
 *                  the only option here that outputs a mesh you could hand to a
 *                  game engine without retopology.
 *   Hunyuan3D v2   Tencent's open model; the `turbo` variant is the fastest
 *                  image→mesh path available, useful for iterating on silhouette
 *                  before paying for a finished asset.
 *
 * Schemas read from fal's live OpenAPI on 2026-08-02:
 *
 *   tripo3d/tripo/v2.5/image-to-3d   image_url        → model_mesh, pbr_model, base_model
 *   fal-ai/hunyuan3d/v2              input_image_url  → model_mesh
 *   fal-ai/hunyuan3d/v2/turbo        input_image_url  → model_mesh
 *
 * The field-name trap: Hunyuan takes `input_image_url`, Tripo takes `image_url`,
 * and TRELLIS takes `image_url`. Three image→3D endpoints, two different names.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest, ModelOption } from '../types.js';
import { downloadFalFile, falUploadImage, runFalQueued, type FalFile } from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability, RENDER_RATES } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

// ---------------------------------------------------------------------------
// Tripo3D v2.5
// ---------------------------------------------------------------------------

const TRIPO = 'tripo3d/tripo/v2.5/image-to-3d';

/** Texture quality is the price dial: no $0.20 / standard $0.30 / HD $0.40. */
const TRIPO_MODELS: ModelOption[] = [
  { id: 'no', label: 'Tripo v2.5 — geometry only, no textures', price: '$0.20' },
  { id: 'standard', label: 'Tripo v2.5 — standard textures', price: '$0.30' },
  { id: 'HD', label: 'Tripo v2.5 — HD textures', price: '$0.40' },
  { id: 'pbr', label: 'Tripo v2.5 — HD + PBR materials', price: '$0.40' },
  { id: 'quad', label: 'Tripo v2.5 — HD + quad topology (game-ready)', price: '$0.45' },
];

export const falTripoProvider: Provider = {
  id: 'fal-tripo',
  label: 'Tripo3D v2.5 (fal)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: TRIPO_MODELS,
  typicalLatency: '1-3 min',
  tier: 'premium',
  priceRange: '$0.20-$0.45 per mesh',
  notes:
    'The only image→3D option here that can output quad topology and PBR ' +
    'materials, which is what makes a mesh usable in a game engine without ' +
    'retopology. Pick "geometry only" while iterating on shape, then re-run with ' +
    'HD once the silhouette is right.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError('Tripo3D needs a source image (image→3D)', 400);
    }

    const choice = req.model || 'standard';
    const wantsPbr = choice === 'pbr';
    const wantsQuad = choice === 'quad';
    const texture: 'no' | 'standard' | 'HD' =
      choice === 'no' ? 'no' : choice === 'standard' ? 'standard' : 'HD';

    const cost =
      RENDER_RATES.tripo[texture] + (wantsQuad ? RENDER_RATES.tripoOptionSurcharge : 0);
    assertWithinBudget(cost, `Tripo3D v2.5 (${choice})`);

    const input: Record<string, unknown> = {
      image_url: await falUploadImage(req.sourceImage, ctx),
      texture,
      texture_alignment: 'original_image',
    };
    if (wantsPbr) input.pbr = true;
    if (wantsQuad) input.quad = true;
    if (req.seed !== undefined) input.seed = req.seed;

    ctx.onProgress(`submitting to ${TRIPO} (${choice}) — ${costNote(cost)}`);
    const result = await runFalQueued(TRIPO, input, ctx);

    // Prefer the PBR mesh when one was requested and returned; `model_mesh` is
    // the always-present fallback.
    const mesh = ((wantsPbr ? result.pbr_model : undefined) ??
      result.model_mesh ??
      result.base_model) as FalFile | undefined;
    if (!mesh?.url) throw new ProviderError('Tripo3D returned no mesh', 502);

    const { data, mimeType } = await downloadFalFile(mesh, ctx, 'model/gltf-binary');
    return [await saveArtifact(data, mimeType)];
  },
};

// ---------------------------------------------------------------------------
// Hunyuan3D v2
// ---------------------------------------------------------------------------

const HUNYUAN = 'fal-ai/hunyuan3d/v2';
const HUNYUAN_TURBO = 'fal-ai/hunyuan3d/v2/turbo';

export const falHunyuan3dProvider: Provider = {
  id: 'fal-hunyuan3d',
  label: 'Hunyuan3D v2 (fal)',
  modality: 'model3d',
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: HUNYUAN_TURBO, label: 'Hunyuan3D v2 Turbo — fastest' },
    { id: HUNYUAN, label: 'Hunyuan3D v2 — full quality' },
  ],
  typicalLatency: '30s-2min',
  tier: 'premium',
  notes:
    'Tencent Hunyuan3D v2. Turbo is the quickest image→mesh path here, which ' +
    'makes it the cheap way to check a silhouette before spending on a finished ' +
    'asset. Textured output is opt-in and slower. fal bills this per compute ' +
    'second rather than per render, so no fixed price is quoted.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError('Hunyuan3D needs a source image (image→3D)', 400);
    }

    const endpoint = req.model === HUNYUAN ? HUNYUAN : HUNYUAN_TURBO;

    const input: Record<string, unknown> = {
      // NOTE: input_image_url — Tripo and TRELLIS both use `image_url` instead.
      input_image_url: await falUploadImage(req.sourceImage, ctx),
      textured_mesh: true,
      octree_resolution: 256,
    };
    if (req.seed !== undefined) input.seed = req.seed;

    ctx.onProgress(`submitting to ${endpoint}`);
    const result = await runFalQueued(endpoint, input, ctx);

    const mesh = result.model_mesh as FalFile | undefined;
    if (!mesh?.url) throw new ProviderError('Hunyuan3D returned no mesh', 502);

    const { data, mimeType } = await downloadFalFile(mesh, ctx, 'model/gltf-binary');
    return [await saveArtifact(data, mimeType)];
  },
};
