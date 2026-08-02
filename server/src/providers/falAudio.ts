/**
 * Audio providers on fal — ElevenLabs and ByteDance Seed Audio.
 *
 * This is the studio's fourth modality. It is a real modality rather than a flag
 * on video because the capability set is entirely different: no aspect ratio, no
 * negative prompt, and the artifact plays in an `<audio>` element. Two of these
 * providers do not even generate media in the usual sense — Scribe v2 returns
 * words, and Audio Isolation returns a cleaned version of what you gave it.
 *
 * Schemas read from fal's live OpenAPI on 2026-08-02:
 *
 *   fal-ai/elevenlabs/tts/eleven-v3              text                → audio
 *   fal-ai/elevenlabs/tts/multilingual-v2        text                → audio
 *   fal-ai/elevenlabs/music                      (prompt optional)   → audio
 *   fal-ai/elevenlabs/sound-effects/v2           text                → audio
 *   fal-ai/elevenlabs/speech-to-text/scribe-v2   audio_url           → text, words
 *   fal-ai/elevenlabs/audio-isolation            audio_url|video_url → audio
 *   bytedance/seed-audio-1.0                     prompt              → audio
 *
 * Field shapes that are wrong if guessed:
 *   - ElevenLabs TTS takes **`text`**, not `prompt`. Every other provider in this
 *     studio takes `prompt`, so the request mapping has to translate.
 *   - ElevenLabs Music takes **`music_length_ms`** (3000..600000) — milliseconds,
 *     not seconds, and the prompt is nullable because you can pass a
 *     `composition_plan` instead.
 *   - Sound Effects takes `duration_seconds` as a **float 0.5..22**, unrelated to
 *     the music field above.
 *   - Seed Audio takes `prompt` plus optional `audio_urls` (an ARRAY, for voice
 *     cloning references) and `voice` as a free string.
 *   - Scribe v2's output has no file at all: `{ text, words, language_code,
 *     language_probability }`. It is persisted as a .txt artifact so it appears
 *     in history like everything else, with the transcript also on
 *     `artifact.text` for the UI to render inline.
 */

import { saveArtifact } from '../storage.js';
import type { Artifact, GenerateRequest, ModelOption } from '../types.js';
import {
  downloadFalFile,
  falAvailability,
  falUploadMedia,
  runFalQueued,
  type FalFile,
} from './falClient.js';
import { assertWithinBudget, costNote, premiumAvailability } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

/** Download and persist the `audio` field of a fal result. */
async function persistAudio(
  result: Record<string, unknown>,
  ctx: GenerationContext,
  label: string,
): Promise<Artifact[]> {
  const audio = result.audio as FalFile | undefined;
  if (!audio?.url) throw new ProviderError(`${label} returned no audio`, 502);
  const { data, mimeType } = await downloadFalFile(audio, ctx, 'audio/mpeg');
  return [await saveArtifact(data, mimeType)];
}

// ---------------------------------------------------------------------------
// ElevenLabs — text to speech
// ---------------------------------------------------------------------------

const TTS_V3 = 'fal-ai/elevenlabs/tts/eleven-v3';
const TTS_MULTILINGUAL = 'fal-ai/elevenlabs/tts/multilingual-v2';
const TTS_TURBO = 'fal-ai/elevenlabs/tts/turbo-v2.5';

/**
 * A curated slice of ElevenLabs' voice catalogue.
 *
 * Deliberately not the full list: the catalogue is hundreds of entries and
 * changes, and a dropdown of hundreds is worse than a short list plus the
 * knowledge that `voice` is a free string the vendor resolves by name.
 */
const ELEVEN_VOICES = [
  'Rachel',
  'Adam',
  'Antoni',
  'Arnold',
  'Bella',
  'Domi',
  'Elli',
  'Josh',
  'Sam',
];

export const falElevenTtsProvider: Provider = {
  id: 'fal-elevenlabs-tts',
  label: 'ElevenLabs TTS (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  // Audio has no geometry. The form hides the aspect control for this modality.
  supportedAspectRatios: [],
  models: [
    { id: TTS_V3, label: 'Eleven v3 — most expressive' },
    { id: TTS_MULTILINGUAL, label: 'Multilingual v2 — 29 languages' },
    { id: TTS_TURBO, label: 'Turbo v2.5 — fastest, lowest latency' },
  ],
  typicalLatency: '3-20s',
  tier: 'premium',
  priceRange: 'per character, billed by ElevenLabs',
  voices: ELEVEN_VOICES,
  notes:
    'Puts the prompt in a voice. v3 is the most expressive and takes audio tags ' +
    'like [whispers] or [laughs] inline; Turbo is the one to use when latency ' +
    'matters. fal bills per character, so no per-render price is quoted.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const endpoint =
      req.model === TTS_MULTILINGUAL || req.model === TTS_TURBO ? req.model : TTS_V3;

    // NOTE: `text`, not `prompt`. Every other provider here uses `prompt`.
    const input: Record<string, unknown> = {
      text: req.prompt,
      voice: req.voice || 'Rachel',
      stability: 0.5,
    };
    // Only the non-v3 endpoints expose these; v3 rejects unknown fields silently
    // rather than erroring, but sending them is still wrong.
    if (endpoint !== TTS_V3) {
      input.similarity_boost = 0.75;
      input.speed = 1;
    }

    ctx.onProgress(`submitting to ${endpoint} as ${String(input.voice)}`);
    const result = await runFalQueued(endpoint, input, ctx);
    return persistAudio(result, ctx, 'ElevenLabs TTS');
  },
};

// ---------------------------------------------------------------------------
// ElevenLabs — music
// ---------------------------------------------------------------------------

const MUSIC = 'fal-ai/elevenlabs/music';

/** $0.80 per output minute, rounded UP to the next whole minute. */
const MUSIC_USD_PER_MINUTE = 0.8;

export const falElevenMusicProvider: Provider = {
  id: 'fal-elevenlabs-music',
  label: 'ElevenLabs Music (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: MUSIC, label: 'ElevenLabs Music', price: '$0.80 per output minute' }],
  typicalLatency: '20s-2min',
  tier: 'premium',
  priceRange: '$0.80 per output minute',
  notes:
    'Full instrumental or vocal tracks from a text description. Billing rounds UP ' +
    'to the whole minute, so a 30-second clip costs the same $0.80 as a 60-second ' +
    'one — ask for the full minute. Duration is 3s to 10min.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    // durationSeconds is capped at 60 by validation; the endpoint allows 600.
    const seconds = Math.min(Math.max(req.durationSeconds ?? 30, 3), 600);
    // Rounded up, matching how fal actually bills.
    const billedMinutes = Math.ceil(seconds / 60);
    const cost = billedMinutes * MUSIC_USD_PER_MINUTE;
    assertWithinBudget(cost, `ElevenLabs Music (${billedMinutes} min billed)`);

    const input: Record<string, unknown> = {
      prompt: req.prompt,
      // NOTE: milliseconds, range 3000..600000.
      music_length_ms: seconds * 1000,
      output_format: 'mp3_44100_128',
    };

    ctx.onProgress(`submitting to ${MUSIC} — ${seconds}s, ${costNote(cost)}`);
    const result = await runFalQueued(MUSIC, input, ctx);
    return persistAudio(result, ctx, 'ElevenLabs Music');
  },
};

// ---------------------------------------------------------------------------
// ElevenLabs — sound effects
// ---------------------------------------------------------------------------

const SFX = 'fal-ai/elevenlabs/sound-effects/v2';

export const falElevenSfxProvider: Provider = {
  id: 'fal-elevenlabs-sfx',
  label: 'ElevenLabs Sound Effects (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: SFX, label: 'Sound Effects v2' }],
  typicalLatency: '3-15s',
  tier: 'premium',
  priceRange: 'per generation, billed by ElevenLabs',
  notes:
    'Short one-shot effects — footsteps, a door, UI clicks, ambience. Max 22 ' +
    'seconds. Useful for game audio: describe the material and the action ' +
    '("heavy boot on wet gravel"), not the emotion.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const input: Record<string, unknown> = {
      // NOTE: `text`, and duration here is a float 0.5..22 — a different field
      // and a different unit from the Music endpoint above.
      text: req.prompt,
      prompt_influence: 0.3,
      output_format: 'mp3_44100_128',
    };
    if (req.durationSeconds) {
      input.duration_seconds = Math.min(Math.max(req.durationSeconds, 0.5), 22);
    }

    ctx.onProgress(`submitting to ${SFX}`);
    const result = await runFalQueued(SFX, input, ctx);
    return persistAudio(result, ctx, 'ElevenLabs Sound Effects');
  },
};

// ---------------------------------------------------------------------------
// ByteDance Seed Audio 1.0
// ---------------------------------------------------------------------------

const SEED_AUDIO = 'bytedance/seed-audio-1.0';

export const falSeedAudioProvider: Provider = {
  id: 'fal-seed-audio',
  label: 'Seed Audio 1.0 (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: SEED_AUDIO, label: 'Seed Audio 1.0' }],
  typicalLatency: '5-30s',
  tier: 'premium',
  priceRange: 'billed per request by fal',
  notes:
    'ByteDance speech synthesis with voice cloning: give it reference audio and ' +
    'it speaks the prompt in that voice. Also takes pitch, speed, and volume ' +
    'dials, and a multilingual switch. fal publishes no fixed price for this one.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      output_format: 'mp3',
      sample_rate: 44100,
      speed: 1,
      volume: 1,
      pitch: 0,
      multilingual: true,
    };
    if (req.voice) input.voice = req.voice;
    // audio_urls is an ARRAY of reference clips for cloning.
    if (req.sourceAudio) {
      input.audio_urls = [await falUploadMedia(req.sourceAudio, ctx, 'audio')];
    }

    ctx.onProgress(`submitting to ${SEED_AUDIO}`);
    const result = await runFalQueued(SEED_AUDIO, input, ctx);
    return persistAudio(result, ctx, 'Seed Audio 1.0');
  },
};

// ---------------------------------------------------------------------------
// ElevenLabs — Scribe v2 (speech to text)
// ---------------------------------------------------------------------------

const SCRIBE_V2 = 'fal-ai/elevenlabs/speech-to-text/scribe-v2';

/** $0.008 per INPUT audio minute; +30% when keyterms are used. */
const SCRIBE_USD_PER_INPUT_MINUTE = 0.008;

interface ScribeWord {
  text?: string;
  start?: number;
  end?: number;
  speaker_id?: string;
  type?: string;
}

/**
 * Format the word list into a speaker-labelled transcript.
 *
 * Scribe returns diarised words, not sentences. Joining them raw produces one
 * wall of text with the speaker information thrown away, which is the main thing
 * diarisation was for.
 */
function formatTranscript(text: string, words: ScribeWord[]): string {
  const spoken = words.filter((w) => w.type !== 'spacing' && w.text);
  const speakers = new Set(spoken.map((w) => w.speaker_id).filter(Boolean));

  // Single speaker (or none identified): the flat text is already correct.
  if (speakers.size <= 1) return text;

  const lines: string[] = [];
  let current: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length > 0) {
      lines.push(`${current ?? 'speaker'}: ${buffer.join(' ')}`);
      buffer = [];
    }
  };

  for (const word of spoken) {
    if (word.speaker_id !== current) {
      flush();
      current = word.speaker_id;
    }
    if (word.text) buffer.push(word.text.trim());
  }
  flush();

  return lines.join('\n');
}

export const falScribeProvider: Provider = {
  id: 'fal-scribe-v2',
  label: 'Scribe v2 — transcribe (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [
    { id: SCRIBE_V2, label: 'ElevenLabs Scribe v2', price: '$0.008 per input audio minute' },
  ],
  typicalLatency: '5-60s',
  tier: 'premium',
  priceRange: '$0.008 per input audio minute',
  requiresSourceAudio: true,
  // There is nothing to prompt: it transcribes whatever it is given.
  ignoresPrompt: true,
  notes:
    'Transcribes speech with speaker diarisation and audio-event tagging. Takes ' +
    'an audio OR video source — point it at a generated clip to caption it. The ' +
    'result is text, so it lands in history as a .txt artifact you can read ' +
    'inline. Billed on INPUT length, so a long file costs more regardless of how ' +
    'little was said.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const source = req.sourceAudio ?? req.sourceVideo;
    if (!source) {
      throw new ProviderError('Scribe v2 needs a source audio or video file', 400);
    }

    // Cost depends on input length, which is not known before upload. Quote one
    // minute so the ceiling still catches an absurdly low limit, and say so.
    assertWithinBudget(SCRIBE_USD_PER_INPUT_MINUTE, 'Scribe v2 (per input minute)');

    const kind = req.sourceAudio ? 'audio' : 'video';
    const input: Record<string, unknown> = {
      audio_url: await falUploadMedia(source, ctx, kind),
      diarize: true,
      tag_audio_events: true,
    };

    ctx.onProgress(`submitting to ${SCRIBE_V2}`);
    const result = await runFalQueued(SCRIBE_V2, input, ctx);

    const text = typeof result.text === 'string' ? result.text : '';
    if (!text) throw new ProviderError('Scribe returned no transcript', 502);

    const words = Array.isArray(result.words) ? (result.words as ScribeWord[]) : [];
    const language = typeof result.language_code === 'string' ? result.language_code : 'unknown';
    const confidence =
      typeof result.language_probability === 'number' ? result.language_probability : undefined;

    const transcript = formatTranscript(text, words);
    const header =
      `# Transcript\n` +
      `language: ${language}` +
      `${confidence !== undefined ? ` (confidence ${(confidence * 100).toFixed(0)}%)` : ''}\n\n`;
    const body = header + transcript + '\n';

    ctx.onProgress(`transcribed ${text.length} characters (${language})`);

    // Persisted as a real file so it behaves like any other artifact in history,
    // with the text also inline for the UI.
    const artifact = await saveArtifact(new TextEncoder().encode(body), 'text/plain');
    return [{ ...artifact, text: transcript }];
  },
};

// ---------------------------------------------------------------------------
// ElevenLabs — audio isolation
// ---------------------------------------------------------------------------

const AUDIO_ISOLATION = 'fal-ai/elevenlabs/audio-isolation';

export const falAudioIsolationProvider: Provider = {
  id: 'fal-elevenlabs-isolate',
  label: 'Audio Isolation (fal)',
  modality: 'audio',
  requiresSourceImage: false,
  supportsSeed: false,
  supportsNegativePrompt: false,
  supportedAspectRatios: [],
  models: [{ id: AUDIO_ISOLATION, label: 'ElevenLabs Audio Isolation' }],
  typicalLatency: '5-40s',
  tier: 'premium',
  priceRange: 'billed per request by ElevenLabs',
  requiresSourceAudio: true,
  ignoresPrompt: true,
  notes:
    'Strips background noise and music, leaving clean speech. Takes audio OR ' +
    'video — it will pull the track out of a video for you. A cleanup pass, not ' +
    'a generator, so there is nothing to prompt.',

  availability: premiumAvailability,

  async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
    const input: Record<string, unknown> = {};

    // The endpoint takes audio_url OR video_url — both nullable, but one must be
    // present or there is nothing to isolate.
    if (req.sourceAudio) {
      input.audio_url = await falUploadMedia(req.sourceAudio, ctx, 'audio');
    } else if (req.sourceVideo) {
      input.video_url = await falUploadMedia(req.sourceVideo, ctx, 'video');
    } else {
      throw new ProviderError('Audio Isolation needs a source audio or video file', 400);
    }

    ctx.onProgress(`submitting to ${AUDIO_ISOLATION}`);
    const result = await runFalQueued(AUDIO_ISOLATION, input, ctx);
    return persistAudio(result, ctx, 'Audio Isolation');
  },
};

/** Everything in this file, for the registry. */
export const AUDIO_PROVIDERS: Provider[] = [
  falElevenTtsProvider,
  falElevenMusicProvider,
  falElevenSfxProvider,
  falSeedAudioProvider,
  falScribeProvider,
  falAudioIsolationProvider,
];

/** Re-exported for tests and docs. */
export const AUDIO_MODEL_IDS: ModelOption[] = AUDIO_PROVIDERS.flatMap((p) => p.models);
