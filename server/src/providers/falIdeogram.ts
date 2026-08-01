/**
 * Ideogram V3 character providers on fal.
 *
 * Two endpoints, both keyed on *character consistency* — generating the same
 * face across different scenes, which plain text-to-image cannot do reliably:
 *
 *   fal-ai/ideogram/character        reference image(s) → new image, same character
 *   fal-ai/ideogram/character/edit   masked edit: keep background, replace a region
 *
 * The masked-edit flow (reference + base + mask) is the pattern demonstrated by
 * ilkerzg/ideogram-v3-fal-playground. Field names here were confirmed against
 * fal's live OpenAPI spec, not copied from the playground — the two disagree:
 * the playground sends `negative_prompt` and `style` to `/character/edit`, but
 * the spec only accepts those on `/character`.
 *
 * Verified 2026-08-01:
 *   /character        required: prompt, reference_image_urls
 *   /character/edit   required: prompt, image_url, mask_url, reference_image_urls
 *   both              rendering_speed: TURBO | BALANCED | QUALITY
 *   /character only   style: AUTO | REALISTIC | FICTION
 *   output            { images: File[], seed }
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest } from '../types.js';
import {
  downloadFalFile,
  falAvailability,
  falUploadImage,
  runFalQueued,
  type FalFile,
} from './falClient.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

const CHARACTER = 'fal-ai/ideogram/character';
const CHARACTER_EDIT = 'fal-ai/ideogram/character/edit';

/** Ideogram takes a named size rather than pixel dimensions. */
const IMAGE_SIZE: Record<string, string> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

export const falIdeogramCharacterProvider: Provider = {
  id: 'fal-ideogram-character',
  label: 'Ideogram V3 Character (fal)',
  modality: 'image',
  // The reference image IS the point of this model — without one it is just a
  // worse text-to-image.
  requiresSourceImage: true,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
  models: [
    { id: CHARACTER, label: 'Character — same face, new scene' },
    { id: CHARACTER_EDIT, label: 'Character Edit — masked region (needs maskImage)' },
  ],
  typicalLatency: '10-30s',
  notes:
    'Keeps a character consistent across images. Give it a reference portrait as ' +
    'the source. The Edit variant additionally needs a mask (white = repaint, ' +
    'black = keep) passed as maskImage.',

  availability: falAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError(
        'Ideogram Character needs a reference image — that is what keeps the character consistent',
        400,
      );
    }

    const endpoint = req.model === CHARACTER_EDIT ? CHARACTER_EDIT : CHARACTER;
    const isEdit = endpoint === CHARACTER_EDIT;

    if (isEdit && !req.maskImage) {
      throw new ProviderError(
        'Ideogram Character Edit needs a mask image (white = repaint, black = keep). ' +
          'Use the plain Character endpoint if you have no mask.',
        400,
      );
    }

    const referenceUrl = await falUploadImage(req.sourceImage, ctx);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      reference_image_urls: [referenceUrl],
      rendering_speed: 'BALANCED',
      num_images: 1,
    };
    if (req.seed !== undefined) input.seed = req.seed;

    if (isEdit) {
      // The edit endpoint repaints a masked region of a base image. We use the
      // reference as the base too unless a distinct base is supplied, which is
      // the common "fix this face" case.
      input.image_url = req.baseImage ? await falUploadImage(req.baseImage, ctx) : referenceUrl;
      input.mask_url = await falUploadImage(req.maskImage as string, ctx);
      // NOTE: negative_prompt and style are NOT accepted here — see header.
    } else {
      input.image_size = IMAGE_SIZE[req.aspectRatio ?? '1:1'] ?? 'square_hd';
      input.style = 'AUTO';
      if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    }

    ctx.onProgress(`submitting to ${endpoint}`);
    const result = await runFalQueued(endpoint, input, ctx);

    const images = result.images as FalFile[] | undefined;
    const first = images?.[0];
    if (!first?.url) throw new ProviderError('Ideogram returned no images', 502);

    const { data, mimeType } = await downloadFalFile(first, ctx, 'image/png');
    return [await saveArtifact(data, mimeType)];
  },
};
