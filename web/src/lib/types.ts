/**
 * Wire types shared with the server.
 *
 * Keep in sync with `server/src/types.ts` — these are hand-mirrored rather than
 * imported so the two packages install and build independently.
 */

export type Modality = 'image' | 'video' | 'model3d' | 'audio';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';

export type Resolution = '480p' | '768p' | '720p' | '1080p' | '2K' | '4K';

/**
 * Commercial tier. Drives the cost badge and the premium grouping in the picker,
 * so a $0.40/second model never looks like the free one.
 */
export type ProviderTier = 'free' | 'standard' | 'premium';

export interface ModelOption {
  id: string;
  label: string;
  /** Vendor-quoted price for one render, shown next to the model. */
  price?: string;
}

export interface GenerateRequest {
  modality: Modality;
  provider: string;
  /** Empty is allowed only for providers that declare `ignoresPrompt`. */
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: AspectRatio;
  seed?: number;
  model?: string;
  sourceImage?: string;
  durationSeconds?: number;
  /** Inpainting mask (white = repaint, black = keep). */
  maskImage?: string;
  /** Base image to edit when different from the reference. */
  baseImage?: string;
  /** Output resolution; honoured by premium video and some premium image models. */
  resolution?: Resolution;
  /** Vendor-side prompt rewriting (Hailuo 02's `prompt_optimizer`, default true). */
  promptOptimizer?: boolean;
  /** Generate an audio track. Off by default — on Veo it doubles the price. */
  generateAudio?: boolean;
  /** Audio input for transcription, isolation, and voice cloning. */
  sourceAudio?: string;
  /** Video input for the upscalers and for transcribing a clip. */
  sourceVideo?: string;
  /** Named voice for TTS; the vendor resolves the name. */
  voice?: string;
  /** LoRA references as `url_or_repo` or `url_or_repo:scale`. */
  loras?: string[];
  /** Style/character reference images, distinct from a source image. */
  referenceImages?: string[];
  /** Closing keyframe for two-frame video (Pixverse Transition). */
  endImage?: string;
  /**
   * Shot-vocabulary option ids. Composed into the prompt server-side so the
   * stored job records exactly what was sent.
   */
  shotOptionIds?: string[];
}

export interface ShotOption {
  id: string;
  label: string;
  description: string;
  /** Reference clip demonstrating the term. */
  video: string;
}

export interface ShotCategory {
  id: string;
  name: string;
  description: string;
  options: ShotOption[];
}

export interface PromptGuidance {
  providerId: string;
  summary: string;
  maxLength: number;
  tips: string[];
}

/** One LLM the prompt studio can run on. */
export interface PromptLlm {
  id: string;
  label: string;
}

/**
 * Whether the LLM-assisted prompt studio can run. Reported by /api/guidance so
 * the UI hides the Enhance and Break down buttons rather than offering something
 * that returns 503.
 */
export interface PromptStudioInfo {
  available: boolean;
  reason?: string;
  models: PromptLlm[];
  categories: string[];
}

/** A rewritten prompt, shaped for a specific provider. */
export interface EnhanceResult {
  original: string;
  enhanced: string;
  /** Which provider's guidance shaped the rewrite, when one was found. */
  guidanceUsed?: string;
  model: string;
  maxLength?: number;
  elapsedMs: number;
}

/** An idea broken into cinematography categories. */
export interface BreakdownResult {
  original: string;
  categories: Record<string, string>;
  /** The categories joined into a ready-to-render prompt. */
  composed: string;
  model: string;
  elapsedMs: number;
}

export interface Artifact {
  url: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Transcript text, for backends that return words rather than pixels. */
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
  /** Resolutions this provider honours; absent means it has no resolution dial. */
  supportedResolutions?: Resolution[];
  models: ModelOption[];
  typicalLatency?: string;
  notes?: string;
  tier: ProviderTier;
  /** Vendor-quoted price span across this provider's models. */
  priceRange?: string;
  /** True when the model also generates an audio track. */
  producesAudio?: boolean;
  /** Input requirements beyond an image, so the form asks for the right file. */
  requiresSourceAudio?: boolean;
  requiresSourceVideo?: boolean;
  /** Accepts LoRA weight references. */
  supportsLoras?: boolean;
  /** Accepts style/character reference images. */
  supportsReferenceImages?: boolean;
  /** Curated named voices; present means show a voice picker. */
  voices?: string[];
  /** True when a prompt is meaningless here (upscalers, transcription). */
  ignoresPrompt?: boolean;
  /** Takes a closing keyframe as well as an opening one (Pixverse Transition). */
  requiresEndImage?: boolean;
}

export const TIER_LABELS: Record<ProviderTier, string> = {
  free: 'Free',
  standard: 'Paid',
  premium: 'Premium',
};

export interface ReachResult {
  url: string;
  backend: 'agent-reach' | 'jina-reader';
  title?: string;
  content: string;
  truncated: boolean;
  chars: number;
  elapsedMs: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  queue: { running: number; queued: number; total: number };
  authenticated: boolean;
  reach?: { enabled: boolean; backend: string };
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
  defaults: Partial<Record<Modality, string>>;
}

export const MODALITY_LABELS: Record<Modality, string> = {
  image: 'Image',
  video: 'Video',
  model3d: '3D',
  audio: 'Audio',
};

export function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
