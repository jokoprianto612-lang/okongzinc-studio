/**
 * Shared domain types for OkongzINC Studio.
 *
 * These mirror the wire format the web client consumes, so keep this file and
 * `web/src/lib/types.ts` in sync when changing the API surface.
 */

/**
 * What a backend produces.
 *
 * `audio` joined image/video/model3d when the ElevenLabs and Seed Audio
 * providers landed. It is a real modality rather than a flag on video because
 * the whole capability set differs: no aspect ratio, no seed on most endpoints,
 * and the artifact is an `<audio>` element rather than a `<video>`.
 */
export type Modality = 'image' | 'video' | 'model3d' | 'audio';

/**
 * Commercial tier of a backend, so the UI can separate "costs nothing" from
 * "spends real money per click".
 *
 *   free      — no credential, no bill (Pollinations).
 *   standard  — paid, but cents per render (LongCat, TRELLIS, Seedance mini).
 *   premium   — flagship models that can cost dollars per render (Veo 3.1,
 *               Kling v3 Pro, Nano Banana Pro). Gated behind PREMIUM_ENABLED so
 *               an admin has to opt in deliberately.
 */
export type ProviderTier = 'free' | 'standard' | 'premium';

/** One selectable model/endpoint within a provider. */
export interface ModelOption {
  id: string;
  label: string;
  /**
   * Vendor-quoted price for one render, verbatim from the vendor's own
   * metadata. Shown next to the model in the UI so a user knows what a click
   * costs BEFORE clicking. Never estimated in code.
   */
  price?: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Aspect ratios the UI offers. Providers map these to their own params. */
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

/**
 * Output resolution. Only premium video and a few image models honour this;
 * everyone else ignores it. It exists because on Veo 3.1 the difference between
 * 1080p and 4k is 2× the bill, so it has to be an explicit choice rather than a
 * silent default.
 */
export type Resolution = '480p' | '720p' | '1080p' | '2K' | '4K';

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
};

/** What the client sends to start a generation. */
export interface GenerateRequest {
  modality: Modality;
  provider: string;
  /**
   * The instruction. Always a string by the time a provider sees it, but it can
   * be EMPTY for providers that declare `ignoresPrompt` — upscalers and
   * transcription have nothing to prompt. The route rejects an empty prompt for
   * every other provider, so a generator never receives one.
   */
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: AspectRatio;
  seed?: number;
  /** Provider-specific model id override (e.g. 'flux', 'turbo'). */
  model?: string;
  /**
   * Source image for image-to-video or image-to-3D. Either an absolute http(s)
   * URL or a relative `/media/...` path returned by a previous job.
   */
  sourceImage?: string;
  /** Video duration in seconds; ignored by image providers. */
  durationSeconds?: number;
  /**
   * Mask for inpainting-style edits (white = repaint, black = keep). Same URL
   * rules as `sourceImage`. Only Ideogram Character Edit uses this today.
   */
  maskImage?: string;
  /**
   * Base image to edit when it differs from the reference. Defaults to
   * `sourceImage` when omitted.
   */
  baseImage?: string;
  /**
   * Requested output resolution. Honoured by premium video (Veo 3.1, Kling v3)
   * and a few premium image models; ignored elsewhere. Left optional so the
   * vendor's own default applies when the user does not care.
   */
  resolution?: Resolution;
  /**
   * Generate an audio track alongside the video. Only Veo 3.1, Kling v3, and
   * Seedance support it. Defaults to OFF for premium video because audio doubles
   * Veo's price — an opt-in cost should not be a silent default.
   */
  generateAudio?: boolean;
  /**
   * Source audio for speech-to-text, audio isolation, and voice work. Same URL
   * rules as `sourceImage`: an http(s) URL or a `/media/...` path from a
   * previous job.
   */
  sourceAudio?: string;
  /**
   * Source video for the video utilities (upscale, transcribe a clip's audio).
   * Same URL rules as `sourceImage`.
   */
  sourceVideo?: string;
  /**
   * Named voice for text-to-speech. Provider-specific ('Rachel' on ElevenLabs);
   * left as a free string because the vendor's voice list is long and changes.
   */
  voice?: string;
  /**
   * LoRA weights to apply, as `url_or_hf_repo` or `url_or_hf_repo:scale`.
   * Only the Krea 2 LoRA endpoint reads this. Scale is clamped 0..4 by fal.
   */
  loras?: string[];
  /**
   * Style/character reference images. Distinct from `sourceImage`: these steer
   * appearance rather than being the thing edited, and Krea 2 Style takes
   * several at once.
   */
  referenceImages?: string[];
}

/** One produced file belonging to a job. */
export interface Artifact {
  /** Public URL path, e.g. `/media/2026-08-01/abc123.jpg`. */
  url: string;
  /** Absolute path on disk. Not sent to clients. */
  absolutePath?: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  /**
   * Text payload for backends that return words rather than pixels — Scribe v2
   * transcription is the only one today. Kept on the artifact rather than
   * inventing a parallel result type, so the gallery and job view need no
   * special case: an artifact with `text` renders as a transcript.
   */
  text?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  modality: Modality;
  provider: string;
  request: GenerateRequest;
  artifacts: Artifact[];
  error?: string;
  /** Human-readable stage, e.g. 'polling Veo operation (12s)'. */
  progressNote?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Public view of a job — strips absolute filesystem paths. */
export interface JobView extends Omit<Job, 'artifacts'> {
  artifacts: Omit<Artifact, 'absolutePath'>[];
}

/** Capability descriptor a provider advertises to the UI. */
export interface ProviderInfo {
  id: string;
  label: string;
  modality: Modality;
  /** False when required credentials are missing — UI disables the option. */
  available: boolean;
  /** Why it is unavailable, shown as a hint in the UI. */
  unavailableReason?: string;
  /** Whether this provider needs `sourceImage`. */
  requiresSourceImage: boolean;
  supportsSeed: boolean;
  supportsNegativePrompt: boolean;
  supportedAspectRatios: AspectRatio[];
  /**
   * Output resolutions this provider honours. Empty/absent means it has no
   * resolution dial and the UI hides the control — the same capability-driven
   * rule the aspect and seed fields follow.
   */
  supportedResolutions?: Resolution[];
  models: ModelOption[];
  /** Rough guidance shown in the UI, e.g. '~5-45s'. */
  typicalLatency?: string;
  notes?: string;
  /** Commercial tier — drives the cost badge and the premium grouping. */
  tier: ProviderTier;
  /** Vendor-quoted price range for the whole provider, e.g. '$0.03-$0.09'. */
  priceRange?: string;
  /** True when this provider generates audio along with the video. */
  producesAudio?: boolean;
  /**
   * What the provider needs as input, so the form renders the right upload
   * control instead of always asking for an image. Absent means "nothing".
   */
  requiresSourceAudio?: boolean;
  requiresSourceVideo?: boolean;
  /** True when the provider accepts LoRA weight references. */
  supportsLoras?: boolean;
  /** True when the provider accepts style/character reference images. */
  supportsReferenceImages?: boolean;
  /**
   * Named voices this provider offers. Present means the UI shows a voice
   * picker; the list is a curated subset, not the vendor's full catalogue.
   */
  voices?: string[];
  /**
   * True when the prompt field is meaningless for this provider (upscalers,
   * audio isolation, transcription). The form hides the prompt box and the
   * route stops requiring one.
   */
  ignoresPrompt?: boolean;
}

export function toJobView(job: Job): JobView {
  return {
    ...job,
    artifacts: job.artifacts.map(({ absolutePath: _absolutePath, ...rest }) => rest),
  };
}
