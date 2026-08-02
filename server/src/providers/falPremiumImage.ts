/**
 * Premium image providers on fal.
 *
 * These are the flagship image models — the ones a paying user actually wants
 * when output quality matters more than the bill. Every schema below was read
 * from fal's live OpenAPI spec on 2026-08-02, not remembered:
 *
 *   GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint>
 *
 * Verified required fields and outputs:
 *
 *   fal-ai/flux-2-pro                    prompt                      → images[]
 *   fal-ai/flux-2-pro/edit               prompt, image_urls           → images[]
 *   fal-ai/nano-banana-pro               prompt                      → images[]
 *   fal-ai/nano-banana-pro/edit          prompt, image_urls           → images[]
 *   bytedance/seedream/v5/pro/text-to-image  prompt                  → images[]
 *   bytedance/seedream/v5/pro/edit       prompt, image_urls           → images[]
 *   fal-ai/ideogram/v3                   prompt                      → images[]
 *   fal-ai/topaz/upscale/image           image_url                   → image
 *
 * Two schema details that are easy to get wrong from intuition:
 *
 *   - The FLUX 2 / Nano Banana / Seedream EDIT endpoints take `image_urls` as an
 *     ARRAY. The single-image `image_url` field does not exist on them; sending
 *     it is a 422 that reads like our bug.
 *   - Nano Banana Pro takes `aspect_ratio` as a string enum with its own list
 *     (`21:9`, `5:4`, `4:5`, `2:3`…) plus a separate `resolution` of
 *     `1K|2K|4K`. It does NOT take fal's usual `image_size` names, so the shared
 *     FAL_IMAGE_SIZE map from fal.ts is wrong here.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, AspectRatio, GenerateRequest, ModelOption } from '../types.js';
import {
  downloadFalFile,
  falUploadImage,
  runFalQueued,
  type FalFile,
} from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability, RENDER_RATES } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

/** fal's shared named-size vocabulary, used by FLUX 2, Seedream, Ideogram. */
const IMAGE_SIZE: Record<AspectRatio, string> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

/** Persist the first image of a fal result, or fail loudly. */
async function persistFirstImage(
  result: Record<string, unknown>,
  ctx: GenerationContext,
  label: string,
): Promise<Artifact[]> {
  const images = result.images as FalFile[] | undefined;
  const first = images?.[0];
  if (!first?.url) throw new ProviderError(`${label} returned no images`, 502);
  const { data, mimeType } = await downloadFalFile(first, ctx, 'image/png');
  return [await saveArtifact(data, mimeType)];
}

// ---------------------------------------------------------------------------
// FLUX.2 Pro — Black Forest Labs flagship
// ---------------------------------------------------------------------------

const FLUX2_T2I = 'fal-ai/flux-2-pro';
const FLUX2_EDIT = 'fal-ai/flux-2-pro/edit';

export const falFlux2ProProvider: Provider = {
  id: 'fal-flux2-pro',
  label: 'FLUX.2 Pro (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: FLUX2_T2I, label: 'FLUX.2 Pro — text→image', price: '$0.03/MP' },
    { id: FLUX2_EDIT, label: 'FLUX.2 Pro Edit — needs a source', price: '$0.03/MP + input' },
  ],
  typicalLatency: '8-25s',
  tier: 'premium',
  priceRange: '$0.03-$0.06 per image',
  notes:
    'Black Forest Labs flagship. Strongest prompt adherence and typography of ' +
    'the image models here. $0.03 for the first output megapixel, $0.015 per ' +
    'extra megapixel of input and output.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint = req.model === FLUX2_EDIT ? FLUX2_EDIT : FLUX2_T2I;
    const isEdit = endpoint === FLUX2_EDIT;

    if (isEdit && !req.sourceImage) {
      throw new ProviderError('FLUX.2 Pro Edit needs a source image', 400);
    }

    // Two megapixels is the worst case for the sizes this UI offers, so the
    // ceiling check uses that rather than pretending to know the exact output.
    const worstCase = RENDER_RATES.flux2ProFirstMegapixel + RENDER_RATES.flux2ProExtraMegapixel;
    assertWithinBudget(worstCase, 'FLUX.2 Pro');

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      output_format: 'png',
    };
    if (req.seed !== undefined) input.seed = req.seed;

    if (isEdit) {
      // NOTE: array field. `image_url` does not exist on this endpoint.
      input.image_urls = [await falUploadImage(req.sourceImage as string, ctx)];
      input.image_size = 'auto';
    } else {
      input.image_size = IMAGE_SIZE[req.aspectRatio ?? '1:1'];
    }

    ctx.onProgress(`submitting to ${endpoint} — ${costNote(worstCase)}`);
    const result = await runFalQueued(endpoint, input, ctx);
    return persistFirstImage(result, ctx, 'FLUX.2 Pro');
  },
};

// ---------------------------------------------------------------------------
// Nano Banana Pro — Google's flagship image model via fal
// ---------------------------------------------------------------------------

const NANO_PRO = 'fal-ai/nano-banana-pro';
const NANO_PRO_EDIT = 'fal-ai/nano-banana-pro/edit';
const NANO_2 = 'fal-ai/nano-banana-2';

/**
 * Nano Banana's own aspect vocabulary. It accepts ratios this studio's
 * `AspectRatio` type does not model, so the map only covers the shared ones and
 * anything else falls back to `auto`.
 */
const NANO_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1:1',
  '16:9': '16:9',
  '9:16': '9:16',
  '4:3': '4:3',
  '3:4': '3:4',
};

export const falNanoBananaProProvider: Provider = {
  id: 'fal-nano-banana-pro',
  label: 'Nano Banana Pro (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  supportedResolutions: ['1080p', '2K', '4K'],
  models: [
    { id: NANO_PRO, label: 'Nano Banana Pro — text→image', price: '$0.15/image' },
    { id: NANO_PRO_EDIT, label: 'Nano Banana Pro Edit — needs a source', price: '$0.15/image' },
    { id: NANO_2, label: 'Nano Banana 2 — cheaper', price: '$0.08/image' },
  ],
  typicalLatency: '10-30s',
  tier: 'premium',
  priceRange: '$0.08-$0.30 per image',
  notes:
    'Google\'s flagship image model. Best in class at rendering readable text ' +
    'inside an image, which every other model here fails at. 4K output is ' +
    'billed at double rate.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const requested = req.model ?? NANO_PRO;
    const endpoint = [NANO_PRO, NANO_PRO_EDIT, NANO_2].includes(requested) ? requested : NANO_PRO;
    const isEdit = endpoint === NANO_PRO_EDIT;

    if (isEdit && !req.sourceImage) {
      throw new ProviderError('Nano Banana Pro Edit needs a source image', 400);
    }

    const is4k = req.resolution === '4K';
    const base = endpoint === NANO_2 ? RENDER_RATES.nanoBanana2 : RENDER_RATES.nanoBananaPro;
    const cost = is4k ? base * 2 : base;
    assertWithinBudget(cost, 'Nano Banana Pro');

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      num_images: 1,
      output_format: 'png',
      // 1K unless the caller explicitly asked for more — 4K doubles the bill.
      resolution: req.resolution === '4K' ? '4K' : req.resolution === '2K' ? '2K' : '1K',
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.aspectRatio) input.aspect_ratio = NANO_ASPECT[req.aspectRatio];

    if (isEdit) {
      input.image_urls = [await falUploadImage(req.sourceImage as string, ctx)];
      // The edit endpoint infers framing from the source unless told otherwise.
      if (!req.aspectRatio) input.aspect_ratio = 'auto';
    }

    ctx.onProgress(`submitting to ${endpoint} — ${costNote(cost)}`);
    const result = await runFalQueued(endpoint, input, ctx);
    return persistFirstImage(result, ctx, 'Nano Banana Pro');
  },
};

// ---------------------------------------------------------------------------
// Seedream 5.0 Pro — ByteDance
// ---------------------------------------------------------------------------

const SEEDREAM_T2I = 'bytedance/seedream/v5/pro/text-to-image';
const SEEDREAM_EDIT = 'bytedance/seedream/v5/pro/edit';

export const falSeedream5Provider: Provider = {
  id: 'fal-seedream5-pro',
  label: 'Seedream 5.0 Pro (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  supportedResolutions: ['1080p', '2K'],
  models: [
    { id: SEEDREAM_T2I, label: 'Seedream 5.0 Pro — text→image', price: '$0.0675/image' },
    { id: SEEDREAM_EDIT, label: 'Seedream 5.0 Pro Edit — needs a source', price: '$0.0675+/image' },
  ],
  typicalLatency: '8-25s',
  tier: 'premium',
  priceRange: '$0.0675-$0.135 per image',
  notes:
    'ByteDance flagship — the cheapest of the premium image models and strong ' +
    'on photographic realism. 2K output costs double; extra input images on the ' +
    'edit endpoint add $0.0045 each.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint = req.model === SEEDREAM_EDIT ? SEEDREAM_EDIT : SEEDREAM_T2I;
    const isEdit = endpoint === SEEDREAM_EDIT;

    if (isEdit && !req.sourceImage) {
      throw new ProviderError('Seedream 5.0 Pro Edit needs a source image', 400);
    }

    const wants2k = req.resolution === '2K' || req.resolution === '4K';
    const cost =
      (wants2k ? RENDER_RATES.seedream5Pro2k : RENDER_RATES.seedream5Pro) +
      (isEdit ? RENDER_RATES.seedreamExtraInputImage : 0);
    assertWithinBudget(cost, 'Seedream 5.0 Pro');

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      num_images: 1,
      output_format: 'png',
      // `auto_1K` keeps the cheap tier; the named ratios also stay under 1536².
      image_size: wants2k ? 'auto_2K' : IMAGE_SIZE[req.aspectRatio ?? '1:1'],
    };

    if (isEdit) {
      input.image_urls = [await falUploadImage(req.sourceImage as string, ctx)];
    }

    ctx.onProgress(`submitting to ${endpoint} — ${costNote(cost)}`);
    const result = await runFalQueued(endpoint, input, ctx);
    return persistFirstImage(result, ctx, 'Seedream 5.0 Pro');
  },
};

// ---------------------------------------------------------------------------
// Ideogram V3 — text rendering and design work
// ---------------------------------------------------------------------------

const IDEOGRAM_V3 = 'fal-ai/ideogram/v3';

/** Rendering speed is the price dial: TURBO $0.03 / BALANCED $0.06 / QUALITY $0.09. */
const IDEOGRAM_MODELS: ModelOption[] = [
  { id: 'TURBO', label: 'Ideogram V3 — Turbo', price: '$0.03/image' },
  { id: 'BALANCED', label: 'Ideogram V3 — Balanced', price: '$0.06/image' },
  { id: 'QUALITY', label: 'Ideogram V3 — Quality', price: '$0.09/image' },
];

export const falIdeogramV3Provider: Provider = {
  id: 'fal-ideogram-v3',
  label: 'Ideogram V3 (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: IDEOGRAM_MODELS,
  typicalLatency: '8-25s',
  tier: 'premium',
  priceRange: '$0.03-$0.09 per image',
  notes:
    'Design-oriented: posters, logos, typography. The model choice IS the price ' +
    'dial — Turbo, Balanced, and Quality are the same model at three step counts. ' +
    'Unlike most models here it takes a negative prompt.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const speed =
      req.model === 'TURBO' || req.model === 'QUALITY' || req.model === 'BALANCED'
        ? req.model
        : 'BALANCED';

    const cost = RENDER_RATES.ideogramV3[speed];
    assertWithinBudget(cost, `Ideogram V3 ${speed}`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      rendering_speed: speed,
      num_images: 1,
      image_size: IMAGE_SIZE[req.aspectRatio ?? '1:1'],
      style: 'AUTO',
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;

    ctx.onProgress(`submitting to ${IDEOGRAM_V3} (${speed}) — ${costNote(cost)}`);
    const result = await runFalQueued(IDEOGRAM_V3, input, ctx);
    return persistFirstImage(result, ctx, 'Ideogram V3');
  },
};

// ---------------------------------------------------------------------------
// Topaz — upscale and restore
// ---------------------------------------------------------------------------

const TOPAZ = 'fal-ai/topaz/upscale/image';

export const falTopazUpscaleProvider: Provider = {
  id: 'fal-topaz-upscale',
  label: 'Topaz Upscale (fal)',
  modality: 'image',
  // This is a post-process, not a generator: the input image IS the job.
  requiresSourceImage: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1'],
  models: [
    { id: 'Standard V2', label: 'Standard V2 — general purpose', price: '$0.08 up to 24MP' },
    { id: 'High Fidelity V2', label: 'High Fidelity V2 — preserve detail', price: '$0.08 up to 24MP' },
    { id: 'Low Resolution V2', label: 'Low Resolution V2 — small/blurry input', price: '$0.08 up to 24MP' },
    { id: 'CGI', label: 'CGI — renders and game art', price: '$0.08 up to 24MP' },
    { id: 'Text Refine', label: 'Text Refine — screenshots and documents', price: '$0.08 up to 24MP' },
    { id: 'Recovery V2', label: 'Recovery V2 — heavy damage', price: '$0.08 up to 24MP' },
  ],
  typicalLatency: '15-60s',
  tier: 'premium',
  priceRange: '$0.08-$1.36 per image',
  notes:
    'Finishing pass, not a generator: takes an existing image to a higher ' +
    'resolution. Generate first, then "Use as source" here. The prompt is ' +
    'ignored — Topaz upscales what it is given.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError('Topaz upscale needs a source image', 400);
    }

    // 2× on anything this studio produces stays under 24MP, the $0.08 tier.
    assertWithinBudget(RENDER_RATES.topazUpTo24mp, 'Topaz upscale');

    const input: Record<string, unknown> = {
      image_url: await falUploadImage(req.sourceImage, ctx),
      model: req.model || 'Standard V2',
      upscale_factor: 2,
      output_format: 'png',
    };

    ctx.onProgress(`submitting to ${TOPAZ} — ${costNote(RENDER_RATES.topazUpTo24mp)}`);
    const result = await runFalQueued(TOPAZ, input, ctx);

    // NOTE: singular `image`, not `images[]` — this endpoint differs from the
    // generation endpoints above.
    const image = result.image as FalFile | undefined;
    if (!image?.url) throw new ProviderError('Topaz returned no image', 502);

    const { data, mimeType } = await downloadFalFile(image, ctx, 'image/png');
    return [await saveArtifact(data, mimeType)];
  },
};
