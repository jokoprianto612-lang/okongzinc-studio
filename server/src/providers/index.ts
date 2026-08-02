/**
 * Provider registry.
 *
 * The single place that knows every backend. Adding a provider means importing
 * it here and appending it to `ALL_PROVIDERS`.
 */

import type { Modality, ProviderInfo, ProviderTier } from '../types.js';
import { describeProvider, type Provider } from './types.js';
import { pollinationsProvider } from './pollinations.js';
import { googleImageProvider, googleVideoProvider } from './google.js';
import { openaiImageProvider } from './openaiImage.js';
import { modalTrellisProvider } from './modalTrellis.js';
import { modalLongcatProvider } from './modalLongcat.js';
import {
  falImageProvider,
  falLongcatVideoProvider,
  falSeedanceProvider,
  falTrellisProvider,
} from './fal.js';
import { falIdeogramCharacterProvider } from './falIdeogram.js';
import {
  falFlux2ProProvider,
  falIdeogramV3Provider,
  falNanoBananaProProvider,
  falSeedream5Provider,
  falTopazUpscaleProvider,
} from './falPremiumImage.js';
import { falKlingV3Provider, falVeo31Provider } from './falPremiumVideo.js';
import { falHunyuan3dProvider, falTripoProvider } from './falPremium3d.js';
import { falKrea2Provider } from './falKrea.js';
import { AUDIO_PROVIDERS } from './falAudio.js';
import { VIDEO_UTILITY_PROVIDERS } from './falVideoUtils.js';
import { CHARACTER_VIDEO_PROVIDERS } from './falCharacterVideo.js';

/**
 * Order matters twice over.
 *
 * `defaultProviderFor()` prefers the cheapest tier, so the picker never lands on
 * a dollars-per-render backend by itself. Within a tier, order is preference:
 * Pollinations leads image because it is free, and the hosted fal providers lead
 * video and 3D because the Modal alternatives need a deploy first.
 *
 * Premium providers are listed last within each modality deliberately. A default
 * that quietly spends $3 per click would be a trap no matter how good the output.
 */
export const ALL_PROVIDERS: Provider[] = [
  // --- image · free ---
  pollinationsProvider,
  // --- image · standard ---
  falImageProvider,
  falIdeogramCharacterProvider,
  googleImageProvider,
  openaiImageProvider,
  // --- image · premium ---
  falFlux2ProProvider,
  falNanoBananaProProvider,
  falSeedream5Provider,
  falKrea2Provider,
  falIdeogramV3Provider,
  falTopazUpscaleProvider,
  // --- video · standard ---
  falLongcatVideoProvider,
  falSeedanceProvider,
  modalLongcatProvider,
  // --- video · premium ---
  falVeo31Provider,
  falKlingV3Provider,
  googleVideoProvider,
  // --- video · premium character/lipsync (Sora, avatars, keyframe motion) ---
  ...CHARACTER_VIDEO_PROVIDERS,
  // --- video · premium utilities (upscalers; cheapest first) ---
  ...VIDEO_UTILITY_PROVIDERS,
  // --- 3d · standard ---
  falTrellisProvider,
  modalTrellisProvider,
  // --- 3d · premium ---
  falTripoProvider,
  falHunyuan3dProvider,
  // --- audio · premium (TTS, music, SFX, transcription, cleanup) ---
  ...AUDIO_PROVIDERS,
];

const BY_ID = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));

export function getProvider(id: string): Provider | undefined {
  return BY_ID.get(id);
}

export function listProviders(modality?: Modality): ProviderInfo[] {
  const list = modality ? ALL_PROVIDERS.filter((p) => p.modality === modality) : ALL_PROVIDERS;
  return list.map(describeProvider);
}

/** Cheapest tier first — the order `defaultProviderFor` walks. */
const TIER_PREFERENCE: ProviderTier[] = ['free', 'standard', 'premium'];

/**
 * First available provider for a modality — used as the UI's default pick.
 *
 * Deliberately prefers a cheaper tier rather than plain registry order: a premium
 * provider only becomes the default when nothing free or standard is available
 * for that modality. Otherwise enabling the premium tier would silently move
 * every default onto a backend that bills dollars per render.
 *
 * Audio has no free or standard tier at all, so its default IS premium — there is
 * no cheaper option to prefer. The tier badge still says so in the UI.
 */
export function defaultProviderFor(modality: Modality): string | undefined {
  const candidates = ALL_PROVIDERS.filter(
    (p) => p.modality === modality && p.availability().available,
  );
  for (const tier of TIER_PREFERENCE) {
    const match = candidates.find((p) => p.tier === tier);
    if (match) return match.id;
  }
  return undefined;
}

export { ProviderError } from './types.js';
export type { Provider } from './types.js';
