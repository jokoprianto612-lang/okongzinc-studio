/**
 * Provider registry.
 *
 * The single place that knows every backend. Adding a provider means importing
 * it here and appending it to `ALL_PROVIDERS`.
 */

import type { Modality, ProviderInfo } from '../types.js';
import { describeProvider, type Provider } from './types.js';
import { pollinationsProvider } from './pollinations.js';
import { googleImageProvider, googleVideoProvider } from './google.js';
import { openaiImageProvider } from './openaiImage.js';
import { modalTrellisProvider } from './modalTrellis.js';
import { modalLongcatProvider } from './modalLongcat.js';

export const ALL_PROVIDERS: Provider[] = [
  pollinationsProvider,
  googleImageProvider,
  openaiImageProvider,
  googleVideoProvider,
  modalLongcatProvider,
  modalTrellisProvider,
];

const BY_ID = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): Provider | undefined {
  return BY_ID.get(id);
}

export function listProviders(modality?: Modality): ProviderInfo[] {
  const list = modality ? ALL_PROVIDERS.filter((p) => p.modality === modality) : ALL_PROVIDERS;
  return list.map(describeProvider);
}

/** First available provider for a modality — used as the UI's default pick. */
export function defaultProviderFor(modality: Modality): string | undefined {
  return ALL_PROVIDERS.find((p) => p.modality === modality && p.availability().available)?.id;
}

export { ProviderError } from './types.js';
export type { Provider } from './types.js';
