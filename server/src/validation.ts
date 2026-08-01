/**
 * Request validation.
 *
 * Zod schemas keep provider code free of defensive input checks: by the time a
 * request reaches a provider, its shape is guaranteed.
 */

import { z } from 'zod';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const MODALITIES = ['image', 'video', 'model3d'] as const;

/**
 * A source image is either an http(s) URL or a `/media/...` path produced by a
 * previous job. Anything else (bare filesystem paths, `file://`, `..`) is
 * rejected here so no provider can be tricked into reading arbitrary files.
 */
const sourceImageSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => /^https?:\/\//i.test(v) || (v.startsWith('/media/') && !v.includes('..')),
    { message: 'sourceImage must be an http(s) URL or a /media/... path' },
  );

export const generateRequestSchema = z.object({
  modality: z.enum(MODALITIES),
  provider: z.string().trim().min(1).max(64),
  prompt: z.string().trim().min(1, 'prompt is required').max(4000),
  negativePrompt: z.string().trim().max(2000).optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  model: z.string().trim().max(128).optional(),
  sourceImage: sourceImageSchema.optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
});

export type ValidatedGenerateRequest = z.infer<typeof generateRequestSchema>;

export const uploadSchema = z.object({
  /** Data URL (`data:image/png;base64,...`) or bare base64. */
  dataUrl: z.string().min(16).max(30_000_000),
  filename: z.string().trim().max(200).optional(),
});

/**
 * Reach request. The URL itself is validated further in `reach.ts`
 * (`assertPublicHttpUrl`), which also blocks private and loopback hosts.
 */
export const reachSchema = z.object({
  url: z.string().trim().min(8).max(2048).url('must be a valid URL'),
});
