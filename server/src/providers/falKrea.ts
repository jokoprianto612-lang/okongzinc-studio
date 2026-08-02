/**
 * Krea 2 on fal — LoRA inference and style transfer.
 *
 * Krea 2 is the one image family here that takes **custom weights**. That is the
 * whole reason it exists alongside FLUX.2 Pro and Nano Banana: those two render a
 * prompt, this one renders a prompt *in a style you trained or borrowed*. For a
 * game project that means a consistent art direction across hundreds of assets
 * instead of re-describing the look every time.
 *
 * Three endpoints, three different jobs:
 *
 *   fal-ai/krea-2/turbo         prompt                        → images
 *   fal-ai/krea-2/turbo/lora    prompt + loras[]              → images
 *   fal-ai/krea-2/turbo/style   prompt + reference_image_urls  → images
 *   krea/v2/large/text-to-image prompt (+ styles, moodboards)  → images
 *
 * Schemas read from fal's live OpenAPI on 2026-08-02. The parts that are wrong if
 * guessed:
 *
 *   - `loras` is an array of `{path, scale}` objects — NOT strings. `path` takes a
 *     URL, a HuggingFace repo id (`owner/repo`), or a local path; `scale` is
 *     0..4, default 1.
 *   - The style endpoint requires **`reference_image_urls`** (an array) as well as
 *     a prompt, and adds `style_scale`. Sending `image_url` is a 422.
 *   - `krea/v2/large/text-to-image` is a DIFFERENT model from `fal-ai/krea-2/*`,
 *     with its own vocabulary: `aspect_ratio` as a literal ratio string (and it
 *     offers `2.35:1`, which fal's named sizes cannot express), plus `creativity`
 *     ('raw'|'low'|'medium'|'high'), `styles`, and `moodboards`. It does NOT take
 *     `image_size`.
 *   - Only Krea 2 Large has a published price ($0.060/image, $0.065 with style
 *     references). The turbo endpoints publish none, so none is claimed.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, AspectRatio, GenerateRequest } from '../types.js';
import {
  downloadFalFile,
  falUploadImage,
  runFalQueued,
  type FalFile,
} from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

const KREA2_TURBO = 'fal-ai/krea-2/turbo';
const KREA2_LORA = 'fal-ai/krea-2/turbo/lora';
const KREA2_STYLE = 'fal-ai/krea-2/turbo/style';
const KREA2_LARGE = 'krea/v2/large/text-to-image';

/** fal's named-size vocabulary, used by the turbo endpoints. */
const IMAGE_SIZE: Record<AspectRatio, string> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

/** Krea 2 Large takes literal ratios instead, and offers more of them. */
const LARGE_ASPECT: Record<AspectRatio, string> = {
  '1:1': '1:1',
  '16:9': '16:9',
  '9:16': '9:16',
  '4:3': '4:3',
  '3:4': '2:3',
};

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

/**
 * Parse the client's LoRA strings into fal's `{path, scale}` objects.
 *
 * The wire format is `url_or_repo` or `url_or_repo:scale`, because a plain text
 * input is far easier to paste a HuggingFace repo id into than a JSON editor.
 * A malformed scale is ignored rather than throwing — the default of 1 is a
 * reasonable answer, and failing a whole render over a typo in an optional dial
 * would be worse.
 *
 * Note the split is on the LAST colon: `https://host/x.safetensors` contains one
 * already, and splitting on the first would break every URL.
 */
export function parseLoras(specs: string[]): { path: string; scale: number }[] {
  const out: { path: string; scale: number }[] = [];
  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) continue;

    const lastColon = spec.lastIndexOf(':');
    // Only treat the tail as a scale when it actually parses as one; this is what
    // keeps 'https://...' and 'owner/repo' intact. A leading minus is accepted so
    // that ':-3' is read as a scale and clamped to 0 (LoRA off) rather than being
    // silently glued onto the path, which would fail at fal as "weights not
    // found" and look like our bug.
    if (lastColon > 0) {
      const tail = spec.slice(lastColon + 1);
      const scale = Number.parseFloat(tail);
      if (tail.length > 0 && Number.isFinite(scale) && /^-?[\d.]+$/.test(tail)) {
        out.push({
          path: spec.slice(0, lastColon),
          // fal clamps to 0..4; do it here so a bad value is a no-op, not a 422.
          scale: Math.min(Math.max(scale, 0), 4),
        });
        continue;
      }
    }
    out.push({ path: spec, scale: 1 });
  }
  return out;
}

export const falKrea2Provider: Provider = {
  id: 'fal-krea-2',
  label: 'Krea 2 (fal)',
  modality: 'image',
  requiresSourceImage: false,
  supportsSeed: true,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  supportsLoras: true,
  supportsReferenceImages: true,
  models: [
    { id: KREA2_TURBO, label: 'Krea 2 Turbo — plain text→image' },
    { id: KREA2_LORA, label: 'Krea 2 Turbo + LoRA — custom weights' },
    { id: KREA2_STYLE, label: 'Krea 2 Turbo Style — needs reference images' },
    {
      id: KREA2_LARGE,
      label: 'Krea 2 Large — best quality',
      price: '$0.060/image ($0.065 with style references)',
    },
  ],
  typicalLatency: '5-25s',
  tier: 'premium',
  priceRange: '$0.060-$0.065 per image (Large); turbo unpriced',
  notes:
    'The only image model here that takes custom LoRA weights — paste a ' +
    'HuggingFace repo id or a .safetensors URL, optionally with :scale (0-4). ' +
    'Use the Style endpoint instead when you have reference images rather than ' +
    'trained weights. Krea 2 Large is the quality tier and the only one with a ' +
    'published price.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const requested = req.model ?? KREA2_TURBO;
    const endpoint = [KREA2_TURBO, KREA2_LORA, KREA2_STYLE, KREA2_LARGE].includes(requested)
      ? requested
      : KREA2_TURBO;

    // Only Krea 2 Large publishes a price, so it is the only one the budget gate
    // can honestly check. Quoting a number for the turbo endpoints would be
    // inventing one.
    if (endpoint === KREA2_LARGE) {
      const hasRefs = (req.referenceImages?.length ?? 0) > 0;
      const cost = hasRefs ? 0.065 : 0.06;
      assertWithinBudget(cost, 'Krea 2 Large');
      ctx.onProgress(`Krea 2 Large — ${costNote(cost)}`);
    }

    if (endpoint === KREA2_LARGE) {
      const input: Record<string, unknown> = {
        prompt: req.prompt,
        // Literal ratio strings; this model has no image_size field.
        aspect_ratio: LARGE_ASPECT[req.aspectRatio ?? '1:1'],
        creativity: 'medium',
      };
      if (req.seed !== undefined) input.seed = req.seed;
      if (req.referenceImages?.length) {
        input.image_style_references = await Promise.all(
          req.referenceImages.map((r) => falUploadImage(r, ctx)),
        );
      }

      ctx.onProgress(`submitting to ${endpoint}`);
      const result = await runFalQueued(endpoint, input, ctx);
      return persistFirstImage(result, ctx, 'Krea 2 Large');
    }

    // --- turbo family ---
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      image_size: IMAGE_SIZE[req.aspectRatio ?? '1:1'],
      num_images: 1,
      output_format: 'png',
      acceleration: 'regular',
    };
    if (req.seed !== undefined) input.seed = req.seed;

    if (endpoint === KREA2_LORA) {
      const loras = parseLoras(req.loras ?? []);
      if (loras.length === 0) {
        throw new ProviderError(
          'Krea 2 LoRA needs at least one LoRA reference. Paste a HuggingFace ' +
            'repo id (owner/repo) or a .safetensors URL, optionally as ' +
            'path:scale — or pick plain Krea 2 Turbo instead.',
          400,
        );
      }
      // Array of {path, scale} objects — not strings.
      input.loras = loras;
      ctx.onProgress(
        `submitting to ${endpoint} with ${loras.length} LoRA${loras.length === 1 ? '' : 's'}`,
      );
    } else if (endpoint === KREA2_STYLE) {
      // The reference images ARE the style, so a source image counts too.
      const refs = req.referenceImages?.length
        ? req.referenceImages
        : req.sourceImage
          ? [req.sourceImage]
          : [];
      if (refs.length === 0) {
        throw new ProviderError(
          'Krea 2 Style needs at least one reference image — that is what defines ' +
            'the style. Use plain Krea 2 Turbo if you have none.',
          400,
        );
      }
      input.reference_image_urls = await Promise.all(refs.map((r) => falUploadImage(r, ctx)));
      input.style_scale = 1;
      ctx.onProgress(`submitting to ${endpoint} with ${refs.length} reference image(s)`);
    } else {
      ctx.onProgress(`submitting to ${endpoint}`);
    }

    const result = await runFalQueued(endpoint, input, ctx);
    return persistFirstImage(result, ctx, 'Krea 2');
  },
};
