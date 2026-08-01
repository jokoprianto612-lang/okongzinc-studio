/**
 * Shared domain types for OkongzINC Studio.
 *
 * These mirror the wire format the web client consumes, so keep this file and
 * `web/src/lib/types.ts` in sync when changing the API surface.
 */

export type Modality = 'image' | 'video' | 'model3d';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Aspect ratios the UI offers. Providers map these to their own params. */
export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

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
  models: { id: string; label: string }[];
  /** Rough guidance shown in the UI, e.g. '~5-45s'. */
  typicalLatency?: string;
  notes?: string;
}

export function toJobView(job: Job): JobView {
  return {
    ...job,
    artifacts: job.artifacts.map(({ absolutePath: _absolutePath, ...rest }) => rest),
  };
}
