/**
 * Character and lipsync video on fal — Sora 2, Kling AI Avatar, Pixverse.
 *
 * These fill the gap the rest of the video providers leave: everything else here
 * animates a scene, these animate a PERSON, or move deliberately between two
 * frames. For a game project that is the difference between b-roll and a
 * cutscene.
 *
 *   Sora 2            OpenAI's model. Consistent characters across shots via
 *                     `character_ids`, and durations up to 20s where Veo caps at 8.
 *   Kling AI Avatar   A portrait + an audio track → that face speaking it. The
 *                     one true talking-head path here.
 *   Pixverse Lipsync  Re-syncs an EXISTING clip's mouth to new audio or text.
 *   Pixverse Transition First frame + last frame + prompt → the motion between.
 *   Veo 3.1 Reference Up to three reference images to lock a subject's look.
 *
 * Endpoint set discovered from gokayfem/ComfyUI-fal-API and
 * filliptm/ComfyUI_Fill-Nodes, which wrap these as ComfyUI nodes. Every schema
 * and price below was then read from fal's own metadata on 2026-08-02 — the
 * ComfyUI wrappers were the pointer, not the source:
 *
 *   schema  GET https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>
 *   price   fal's model listing, plus ComfyUI-fal-API's committed
 *           data/fal_registry.json for the Sora tiers fal's public listing omits
 *
 * Field shapes that are wrong if guessed:
 *   - Sora's `duration` is an INTEGER enum [4, 8, 12, 16, 20]. Veo uses '4s'
 *     strings and Kling v3 uses '3'..'15' strings. Three video families, three
 *     different duration encodings.
 *   - Sora t2v `resolution` is a bare string; only the /pro variant enumerates
 *     720p | 1080p | true_1080p. The i2v variants add 'auto'.
 *   - Kling AI Avatar requires BOTH `audio_url` and `image_url`, and its `prompt`
 *     defaults to '.' — it is genuinely optional there.
 *   - Pixverse Lipsync takes `video_url` (not image) plus EITHER `audio_url` OR
 *     `text` + `voice_id`. Sending neither produces a silent no-op.
 *   - Pixverse Transition requires `first_image_url` AND `end_image_url` — not
 *     `image_url`.
 *   - Veo Reference takes `image_urls` (array), unlike Veo i2v's scalar
 *     `image_url`.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest, ModelOption } from '../types.js';
import {
  downloadFalFile,
  falUploadImage,
  falUploadMedia,
  runFalQueued,
  type FalFile,
} from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

async function persistVideo(
  result: Record<string, unknown>,
  ctx: GenerationContext,
  label: string,
): Promise<Artifact[]> {
  const video = result.video as FalFile | undefined;
  if (!video?.url) throw new ProviderError(`${label} returned no video`, 502);
  const { data, mimeType } = await downloadFalFile(video, ctx, 'video/mp4');
  return [await saveArtifact(data, mimeType)];
}

// ---------------------------------------------------------------------------
// Sora 2
// ---------------------------------------------------------------------------

const SORA_T2V = 'fal-ai/sora-2/text-to-video';
const SORA_T2V_PRO = 'fal-ai/sora-2/text-to-video/pro';
const SORA_I2V = 'fal-ai/sora-2/image-to-video';
const SORA_I2V_PRO = 'fal-ai/sora-2/image-to-video/pro';

/**
 * Per-second rates, from ComfyUI-fal-API's committed registry (fal's public
 * model listing does not expose a pricing string for these endpoints).
 *
 *   standard: $0.10/s at any resolution
 *   pro:      $0.30/s @720p, $0.50/s legacy 1080p, $0.70/s true 1080p
 */
const SORA_RATE = {
  standard: 0.1,
  pro720: 0.3,
  pro1080: 0.5,
  proTrue1080: 0.7,
} as const;

/** Sora accepts only these durations, as INTEGERS. */
function soraDuration(seconds: number | undefined): number {
  const allowed = [4, 8, 12, 16, 20];
  const target = seconds ?? 4;
  // Snap DOWN so nobody silently pays for a longer clip than they asked for.
  let picked = allowed[0] as number;
  for (const step of allowed) if (step <= target) picked = step;
  return picked;
}

export const falSora2Provider: Provider = {
  id: 'fal-sora-2',
  label: 'Sora 2 (OpenAI, fal)',
  modality: 'video',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9', '9:16'],
  supportedResolutions: ['720p', '1080p'],
  producesAudio: true,
  models: [
    { id: SORA_T2V, label: 'Sora 2 — text→video', price: '$0.10 per second' },
    { id: SORA_I2V, label: 'Sora 2 — image→video', price: '$0.10 per second' },
    {
      id: SORA_T2V_PRO,
      label: 'Sora 2 Pro — text→video',
      price: '$0.30/s @720p · $0.50/s @1080p',
    },
    {
      id: SORA_I2V_PRO,
      label: 'Sora 2 Pro — image→video',
      price: '$0.30/s @720p · $0.50/s @1080p',
    },
  ],
  typicalLatency: '1-6 min',
  tier: 'premium',
  priceRange: '$0.40-$14.00 per clip',
  notes:
    'OpenAI Sora 2. Goes to 20 seconds where Veo stops at 8, and generates audio ' +
    'natively. Durations are 4, 8, 12, 16, or 20 seconds only — nothing between. ' +
    'The Pro tier is 3-7x the standard rate, so a 20s Pro clip at true 1080p is ' +
    '$14: check the quote before running one.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint =
      req.model && [SORA_T2V, SORA_T2V_PRO, SORA_I2V, SORA_I2V_PRO].includes(req.model)
        ? req.model
        : SORA_T2V;
    const isPro = endpoint.endsWith('/pro');
    const isI2V = endpoint.includes('/image-to-video');

    if (isI2V && !req.sourceImage) {
      throw new ProviderError('this Sora endpoint is image→video and needs a source image', 400);
    }

    const duration = soraDuration(req.durationSeconds);
    const rate = isPro
      ? req.resolution === '1080p'
        ? SORA_RATE.pro1080
        : SORA_RATE.pro720
      : SORA_RATE.standard;
    const cost = rate * duration;
    assertWithinBudget(cost, `Sora 2${isPro ? ' Pro' : ''} (${duration}s)`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // INTEGER, not a string with a unit.
      duration,
      aspect_ratio: req.aspectRatio === '9:16' ? '9:16' : '16:9',
      // fal deletes the clip from OpenAI's side after delivery; keep that default.
      delete_video: true,
    };
    // The standard tier's `resolution` is a bare string; pro enumerates it.
    input.resolution = isPro ? (req.resolution === '1080p' ? '1080p' : '720p') : '720p';

    if (isI2V) {
      input.image_url = await falUploadImage(req.sourceImage as string, ctx);
      // i2v derives framing from the source unless told otherwise.
      if (!req.aspectRatio) input.aspect_ratio = 'auto';
      input.resolution = isPro && req.resolution === '1080p' ? '1080p' : 'auto';
    }

    ctx.onProgress(`submitting to ${endpoint} — ${duration}s, ${costNote(cost)}`);
    const result = await runFalQueued(endpoint, input, ctx);
    return persistVideo(result, ctx, 'Sora 2');
  },
};

// ---------------------------------------------------------------------------
// Kling AI Avatar — a portrait that speaks
// ---------------------------------------------------------------------------

const AI_AVATAR = 'fal-ai/kling-video/v1/pro/ai-avatar';

export const falKlingAvatarProvider: Provider = {
  id: 'fal-kling-avatar',
  label: 'Kling AI Avatar (fal)',
  modality: 'video',
  requiresSourceImage: true,
  requiresSourceAudio: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  // Output geometry follows the portrait.
  supportedAspectRatios: [],
  models: [{ id: AI_AVATAR, label: 'Kling AI Avatar Pro' }],
  typicalLatency: '2-8 min',
  tier: 'premium',
  priceRange: 'billed per request by fal',
  notes:
    'A portrait plus an audio track becomes that face speaking it, lip-synced. ' +
    'The only talking-head path here. Pair it with ElevenLabs TTS: generate the ' +
    'voice line first, then feed the result in as the audio source. fal publishes ' +
    'no fixed price for this endpoint.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError('Kling AI Avatar needs a portrait as the source image', 400);
    }
    if (!req.sourceAudio) {
      throw new ProviderError(
        'Kling AI Avatar needs a source audio track — generate one with ElevenLabs ' +
          'TTS first, then reuse it here',
        400,
      );
    }

    const input: Record<string, unknown> = {
      image_url: await falUploadImage(req.sourceImage, ctx),
      audio_url: await falUploadMedia(req.sourceAudio, ctx, 'audio'),
      // The endpoint defaults this to '.' — it is genuinely optional here.
      prompt: req.prompt || '.',
    };

    ctx.onProgress(`submitting to ${AI_AVATAR}`);
    const result = await runFalQueued(AI_AVATAR, input, ctx);
    return persistVideo(result, ctx, 'Kling AI Avatar');
  },
};

// ---------------------------------------------------------------------------
// Pixverse Lipsync — re-sync an existing clip
// ---------------------------------------------------------------------------

const LIPSYNC = 'fal-ai/pixverse/lipsync';

/** Pixverse's own voice list, for the text-driven path. */
const PIXVERSE_VOICES = [
  'Auto',
  'Emily',
  'James',
  'Isabella',
  'Liam',
  'Chloe',
  'Adrian',
  'Harper',
  'Ava',
  'Sophia',
  'Julia',
  'Mason',
  'Jack',
  'Oliver',
  'Ethan',
];

export const falPixverseLipsyncProvider: Provider = {
  id: 'fal-pixverse-lipsync',
  label: 'Pixverse Lipsync (fal)',
  modality: 'video',
  requiresSourceImage: false,
  requiresSourceVideo: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  voices: PIXVERSE_VOICES,
  models: [
    { id: LIPSYNC, label: 'Pixverse Lipsync', price: '$0.04/s of output · $0.24 per 100 chars' },
  ],
  typicalLatency: '1-5 min',
  tier: 'premium',
  priceRange: '$0.04 per output second',
  notes:
    'Re-syncs an existing clip\'s mouth to new dialogue. Two ways in: give it a ' +
    'source audio track, or type the line and pick a voice. Supplying audio is ' +
    'cheaper — the text path bills $0.24 per 100 characters on top.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceVideo) {
      throw new ProviderError('Pixverse Lipsync needs a source video to re-sync', 400);
    }
    // Audio OR text. Neither means there is nothing to lip-sync TO, and the
    // endpoint would silently return the clip unchanged.
    if (!req.sourceAudio && !req.prompt) {
      throw new ProviderError(
        'Pixverse Lipsync needs either a source audio track or dialogue text in the ' +
          'prompt field',
        400,
      );
    }

    const seconds = req.durationSeconds ?? 10;
    // $0.04/s of output, plus $0.24 per 100 characters when text-driven.
    const textCost = req.sourceAudio ? 0 : Math.ceil((req.prompt.length || 1) / 100) * 0.24;
    const cost = 0.04 * seconds + textCost;
    assertWithinBudget(cost, `Pixverse Lipsync (~${seconds}s)`);

    const input: Record<string, unknown> = {
      video_url: await falUploadMedia(req.sourceVideo, ctx, 'video'),
    };
    if (req.sourceAudio) {
      input.audio_url = await falUploadMedia(req.sourceAudio, ctx, 'audio');
    } else {
      input.text = req.prompt;
      input.voice_id = req.voice && PIXVERSE_VOICES.includes(req.voice) ? req.voice : 'Auto';
    }

    ctx.onProgress(
      `submitting to ${LIPSYNC} (${req.sourceAudio ? 'audio-driven' : 'text-driven'}) — ${costNote(cost)}`,
    );
    const result = await runFalQueued(LIPSYNC, input, ctx);
    return persistVideo(result, ctx, 'Pixverse Lipsync');
  },
};

// ---------------------------------------------------------------------------
// Pixverse Transition — first frame to last frame
// ---------------------------------------------------------------------------

const TRANSITION = 'fal-ai/pixverse/v5/transition';

const TRANSITION_STYLES: ModelOption[] = [
  { id: '', label: 'No style (photographic)' },
  { id: 'anime', label: 'Anime' },
  { id: '3d_animation', label: '3D animation' },
  { id: 'clay', label: 'Clay' },
  { id: 'comic', label: 'Comic' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
];

export const falPixverseTransitionProvider: Provider = {
  id: 'fal-pixverse-transition',
  label: 'Pixverse Transition (fal)',
  modality: 'video',
  // Both keyframes are required; sourceImage is the first, endImage the last.
  requiresSourceImage: true,
  requiresEndImage: true,
  supportsSeed: true,
  supportsNegativePrompt: true,
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
  supportedResolutions: ['720p', '1080p'],
  models: TRANSITION_STYLES,
  typicalLatency: '1-4 min',
  tier: 'premium',
  priceRange: '$0.15-$0.40 per 5s clip',
  notes:
    'Give it an opening frame and a closing frame; it invents the motion between ' +
    'them. The most controllable video here — you decide exactly where the shot ' +
    'starts and ends instead of describing it and hoping. Duration is 5s or 8s.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    if (!req.sourceImage) {
      throw new ProviderError('Pixverse Transition needs a first frame (source image)', 400);
    }
    if (!req.endImage) {
      throw new ProviderError(
        'Pixverse Transition needs a last frame too — that is what defines the motion',
        400,
      );
    }

    // $0.15 @360/540p, $0.20 @720p, $0.40 @1080p for a 5s clip; 8s scales up.
    const is1080 = req.resolution === '1080p';
    const base = is1080 ? 0.4 : 0.2;
    const seconds = (req.durationSeconds ?? 5) > 5 ? 8 : 5;
    const cost = base * (seconds / 5);
    assertWithinBudget(cost, `Pixverse Transition (${seconds}s ${is1080 ? '1080p' : '720p'})`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // NOTE: first_image_url / end_image_url, NOT image_url.
      first_image_url: await falUploadImage(req.sourceImage, ctx),
      end_image_url: await falUploadImage(req.endImage, ctx),
      duration: String(seconds),
      resolution: is1080 ? '1080p' : '720p',
      aspect_ratio: req.aspectRatio ?? '16:9',
    };
    if (req.seed !== undefined) input.seed = req.seed;
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    // '' is the "no style" option, and sending it would be a 422.
    if (req.model) input.style = req.model;

    ctx.onProgress(`submitting to ${TRANSITION} — ${seconds}s, ${costNote(cost)}`);
    const result = await runFalQueued(TRANSITION, input, ctx);
    return persistVideo(result, ctx, 'Pixverse Transition');
  },
};

// ---------------------------------------------------------------------------
// Veo 3.1 Reference-to-Video — lock a subject's appearance
// ---------------------------------------------------------------------------

const VEO_REFERENCE = 'fal-ai/veo3.1/reference-to-video';

export const falVeoReferenceProvider: Provider = {
  id: 'fal-veo31-reference',
  label: 'Veo 3.1 Reference (fal)',
  modality: 'video',
  requiresSourceImage: true,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: ['16:9', '9:16'],
  supportedResolutions: ['720p', '1080p', '4K'],
  supportsReferenceImages: true,
  producesAudio: true,
  models: [{ id: VEO_REFERENCE, label: 'Veo 3.1 Reference-to-Video' }],
  typicalLatency: '1-5 min',
  tier: 'premium',
  priceRange: '$0.20-$0.60 per second',
  notes:
    'Veo, but with reference images that lock a character or object\'s appearance ' +
    'across the shot. Use it when the same subject has to appear in several clips ' +
    'and look like itself. Same price as regular Veo 3.1, so audio still doubles it.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    // The reference images ARE the point; the source image counts as one.
    const refs = req.referenceImages?.length
      ? req.referenceImages
      : req.sourceImage
        ? [req.sourceImage]
        : [];
    if (refs.length === 0) {
      throw new ProviderError(
        'Veo Reference needs at least one reference image — that is what keeps the ' +
          'subject consistent. Use plain Veo 3.1 if you have none.',
        400,
      );
    }

    const withAudio = req.generateAudio === true;
    const is4k = req.resolution === '4K';
    const perSecond = is4k ? (withAudio ? 0.6 : 0.4) : withAudio ? 0.4 : 0.2;
    // The endpoint's duration is a bare string and defaults to 8s.
    const seconds = 8;
    const cost = perSecond * seconds;
    assertWithinBudget(
      cost,
      `Veo Reference (${seconds}s ${is4k ? '4k' : '1080p'}${withAudio ? ' with audio' : ''})`,
    );

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // image_urls (array) — Veo i2v uses a scalar image_url instead.
      image_urls: await Promise.all(refs.map((r) => falUploadImage(r, ctx))),
      duration: '8s',
      resolution: is4k ? '4k' : req.resolution === '1080p' ? '1080p' : '720p',
      generate_audio: withAudio,
      aspect_ratio: req.aspectRatio === '9:16' ? '9:16' : '16:9',
    };

    ctx.onProgress(
      `submitting to ${VEO_REFERENCE} with ${refs.length} reference(s) — ${costNote(cost)}`,
    );
    const result = await runFalQueued(VEO_REFERENCE, input, ctx);
    return persistVideo(result, ctx, 'Veo 3.1 Reference');
  },
};

/** Everything in this file, for the registry. */
export const CHARACTER_VIDEO_PROVIDERS: Provider[] = [
  falSora2Provider,
  falVeoReferenceProvider,
  falKlingAvatarProvider,
  falPixverseLipsyncProvider,
  falPixverseTransitionProvider,
];
