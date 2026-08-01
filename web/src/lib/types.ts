/**
 * Wire types shared with the server.
 *
 * Keep in sync with `server/src/types.ts` — these are hand-mirrored rather than
 * imported so the two packages install and build independently.
 */

export type Modality = 'image' | 'video' | 'model3d';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

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
}

export interface Artifact {
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
  models: { id: string; label: string }[];
  typicalLatency?: string;
  notes?: string;
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  defaults: Partial<Record<Modality, string>>;
}

export const MODALITY_LABELS: Record<Modality, string> = {
  image: 'Image',
  video: 'Video',
  model3d: '3D',
};

export function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
