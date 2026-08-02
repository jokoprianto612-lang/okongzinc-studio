/**
 * Shared types for the Worker runtime.
 *
 * These mirror `server/src/types.ts` and `web/src/lib/types.ts` on the wire. They
 * are duplicated rather than imported because the Worker builds independently of
 * the Express server — the same reason `web/` keeps its own copy.
 */

export interface Env {
  STUDIO_JOBS: KVNamespace;

  /** Required. Without it every provider reports unavailable. */
  FAL_KEY?: string;
  /**
   * Required in production. A Worker is public the moment it deploys, so an
   * unset API_KEY means anyone can spend the fal balance. Generation is refused
   * outright rather than served openly.
   */
  API_KEY?: string;

  PREMIUM_ENABLED?: string;
  PREMIUM_MAX_COST_PER_JOB_USD?: string;
  JOB_TTL_SECONDS?: string;
  /** Optional. Only raises Jina Reader rate limits; anonymous access works. */
  JINA_API_KEY?: string;
}

export type Modality = 'image' | 'video' | 'model3d';
export type ProviderTier = 'free' | 'standard' | 'premium';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
export type Resolution = '480p' | '720p' | '1080p' | '2K' | '4K';

export interface ModelOption {
  id: string;
  label: string;
  price?: string;
}

export interface GenerateRequest {
  modality: Modality;
  provider: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: AspectRatio;
  seed?: number;
  model?: string;
  sourceImage?: string;
  durationSeconds?: number;
  resolution?: Resolution;
  generateAudio?: boolean;
  shotOptionIds?: string[];
}

export interface Artifact {
  /**
   * Absolute https URL on the provider's CDN.
   *
   * This is the one place the Worker deviates from the Express server, which
   * writes bytes to disk and returns a relative `/media/...` path. R2 is
   * disabled on this account, so there is nowhere to copy the file to; the
   * provider's own URL is stored instead. fal serves these with
   * `access-control-allow-origin: *` and an immutable cache header, so the
   * gallery renders them directly — but they are only as durable as fal's
   * retention. See wrangler.toml for the full note.
   */
  url: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  modality: Modality;
  provider: string;
  request: GenerateRequest;
  artifacts: Artifact[];
  error?: string;
  progressNote?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  modality: Modality;
  available: boolean;
  unavailableReason?: string;
  requiresSourceImage: boolean;
  supportsSeed: boolean;
  supportsNegativePrompt: boolean;
  supportedAspectRatios: AspectRatio[];
  supportedResolutions?: Resolution[];
  models: ModelOption[];
  typicalLatency?: string;
  notes?: string;
  tier: ProviderTier;
  priceRange?: string;
  producesAudio?: boolean;
}

/** Expected, user-facing failure with an HTTP status attached. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
