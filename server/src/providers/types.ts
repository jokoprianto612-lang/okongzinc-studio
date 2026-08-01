/**
 * Provider contract.
 *
 * A provider turns a validated `GenerateRequest` into one or more persisted
 * artifacts. Adding a backend means implementing this interface and appending
 * it to the registry in `providers/index.ts` — nothing else in the app changes.
 */

import type { Artifact, AspectRatio, GenerateRequest, Modality, ProviderInfo } from '../types.js';

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
  readonly models: { id: string; label: string }[];
  readonly typicalLatency?: string;
  readonly notes?: string;

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
    models: p.models,
    typicalLatency: p.typicalLatency,
    notes: p.notes,
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
