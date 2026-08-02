/**
 * Provider contract.
 *
 * A provider turns a validated `GenerateRequest` into one or more persisted
 * artifacts. Adding a backend means implementing this interface and appending
 * it to the registry in `providers/index.ts` — nothing else in the app changes.
 */

import type {
  Artifact,
  AspectRatio,
  GenerateRequest,
  Modality,
  ModelOption,
  ProviderInfo,
  ProviderTier,
  Resolution,
} from '../types.js';

export interface GenerationContext {
  /** Report a human-readable stage; surfaces in the UI while the job runs. */
  onProgress(note: string): void;
  /** Aborts when the client cancels or the process shuts down. */
  signal: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly modality: Modality;
  readonly requiresSourceImage: boolean;
  readonly supportsSeed: boolean;
  readonly supportsNegativePrompt: boolean;
  readonly supportedAspectRatios: AspectRatio[];
  /** Resolutions this provider honours; omit when it has no resolution dial. */
  readonly supportedResolutions?: Resolution[];
  readonly models: ModelOption[];
  readonly typicalLatency?: string;
  readonly notes?: string;
  /**
   * Commercial tier. Drives the cost badge in the UI and, for `premium`, the
   * PREMIUM_ENABLED admin gate. Omitting it would make an expensive backend
   * look identical to a free one in the picker, which is how a user accidentally
   * spends $2 on a click.
   */
  readonly tier: ProviderTier;
  /** Vendor-quoted price span across this provider's models. */
  readonly priceRange?: string;
  /** True when the model also generates an audio track. */
  readonly producesAudio?: boolean;
  /** Input requirements beyond an image, so the form asks for the right file. */
  readonly requiresSourceAudio?: boolean;
  readonly requiresSourceVideo?: boolean;
  /** Accepts LoRA weight references (`url` or `url:scale`). */
  readonly supportsLoras?: boolean;
  /** Accepts style/character reference images separate from a source image. */
  readonly supportsReferenceImages?: boolean;
  /** Curated named voices, when the provider has any. */
  readonly voices?: string[];
  /** True when a prompt is meaningless here (upscalers, transcription). */
  readonly ignoresPrompt?: boolean;
  /** Takes a closing keyframe as well as an opening one (Pixverse Transition). */
  readonly requiresEndImage?: boolean;

  /**
   * Whether this provider can run right now. Return a reason string when it
   * cannot (missing API key, unset endpoint) so the UI can explain itself.
   */
  availability(): { available: boolean; reason?: string };

  generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]>;
}

export function describeProvider(p: Provider): ProviderInfo {
  const { available, reason } = p.availability();
  return {
    id: p.id,
    label: p.label,
    modality: p.modality,
    available,
    unavailableReason: reason,
    requiresSourceImage: p.requiresSourceImage,
    supportsSeed: p.supportsSeed,
    supportsNegativePrompt: p.supportsNegativePrompt,
    supportedAspectRatios: p.supportedAspectRatios,
    supportedResolutions: p.supportedResolutions,
    models: p.models,
    typicalLatency: p.typicalLatency,
    notes: p.notes,
    tier: p.tier,
    priceRange: p.priceRange,
    producesAudio: p.producesAudio,
    requiresSourceAudio: p.requiresSourceAudio,
    requiresSourceVideo: p.requiresSourceVideo,
    supportsLoras: p.supportsLoras,
    supportsReferenceImages: p.supportsReferenceImages,
    voices: p.voices,
    ignoresPrompt: p.ignoresPrompt,
    requiresEndImage: p.requiresEndImage,
  };
}

/** Thrown for expected, user-facing failures (bad input, provider 4xx). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** fetch with a timeout that respects an external abort signal. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
  signal: AbortSignal,
): Promise<Response> {
  const { timeoutMs = 120_000, ...rest } = init;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  const onOuterAbort = () => timeoutController.abort();
  signal.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await fetch(url, { ...rest, signal: timeoutController.signal });
  } catch (err) {
    if (signal.aborted) throw new ProviderError('job cancelled', 499);
    if (timeoutController.signal.aborted) {
      throw new ProviderError(`provider request timed out after ${timeoutMs}ms`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onOuterAbort);
  }
}
