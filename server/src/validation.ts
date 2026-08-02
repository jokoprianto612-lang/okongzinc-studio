/**
 * Request validation.
 *
 * Zod schemas keep provider code free of defensive input checks: by the time a
 * request reaches a provider, its shape is guaranteed.
 */

import { z } from 'zod';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const MODALITIES = ['image', 'video', 'model3d', 'audio'] as const;
const RESOLUTIONS = ['480p', '720p', '1080p', '2K', '4K'] as const;

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

/**
 * Same guard, reused for audio and video sources. The rule is about where the
 * bytes may come from, not what kind of media they are, so one schema covers all
 * three — a `/media/...` path that escapes the storage root is exactly as
 * dangerous whether it ends in .png or .mp3.
 */
const sourceMediaSchema = sourceImageSchema;

/**
 * A LoRA reference: a URL, a HuggingFace repo id, or either with `:scale`
 * appended. Kept as a loose string because the vendor resolves it — validating
 * the shape of a HuggingFace id here would just reject valid inputs when their
 * naming rules change. The length cap is the real protection.
 */
const loraSchema = z.string().trim().min(3).max(400);

export const generateRequestSchema = z.object({
  modality: z.enum(MODALITIES),
  provider: z.string().trim().min(1).max(64),
  /**
   * Optional rather than required, because the upscalers and transcription
   * providers have nothing to prompt (`ignoresPrompt`). The route enforces a
   * prompt for every provider that does not declare that, so the requirement did
   * not disappear — it moved to where the capability is known.
   */
  prompt: z.string().trim().max(4000).optional(),
  negativePrompt: z.string().trim().max(2000).optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  model: z.string().trim().max(128).optional(),
  sourceImage: sourceImageSchema.optional(),
  durationSeconds: z.number().int().min(1).max(600).optional(),
  // Same guard as sourceImage: no bare filesystem paths, no file://, no '..'.
  maskImage: sourceImageSchema.optional(),
  baseImage: sourceImageSchema.optional(),
  /** Audio input for transcription, isolation, and voice cloning. */
  sourceAudio: sourceMediaSchema.optional(),
  /** Video input for the upscalers and for transcribing a clip. */
  sourceVideo: sourceMediaSchema.optional(),
  /** Named voice for TTS. Free string: the vendor resolves it. */
  voice: z.string().trim().max(80).optional(),
  /** LoRA references (`url_or_repo` or `url_or_repo:scale`). Krea 2 only. */
  loras: z.array(loraSchema).max(8).optional(),
  /** Style/character reference images, distinct from a source image. */
  referenceImages: z.array(sourceImageSchema).max(8).optional(),
  /** Closing keyframe for two-frame video (Pixverse Transition). */
  endImage: sourceImageSchema.optional(),
  /** Output resolution; honoured by premium video and some premium image models. */
  resolution: z.enum(RESOLUTIONS).optional(),
  /**
   * Generate audio with the video. Defaults to false server-side because on Veo
   * 3.1 audio doubles the price — a costly option must be an explicit choice.
   */
  generateAudio: z.boolean().optional(),
  /** Shot-vocabulary option ids to fold into the prompt server-side. */
  shotOptionIds: z.array(z.string().trim().min(1).max(64)).max(24).optional(),
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

/**
 * Prompt studio requests.
 *
 * `providerId` is optional: without one the enhancer falls back to generic
 * advice rather than failing, because a user may want a better prompt before
 * they have decided which model will render it.
 */
export const enhanceSchema = z.object({
  prompt: z.string().trim().min(3, 'give it something to work with').max(4000),
  providerId: z.string().trim().max(64).optional(),
  model: z.string().trim().max(80).optional(),
});

export const breakdownSchema = z.object({
  prompt: z.string().trim().min(3, 'give it something to work with').max(4000),
  model: z.string().trim().max(80).optional(),
});
