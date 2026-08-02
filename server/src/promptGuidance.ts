/**
 * Per-model prompting guidance.
 *
 * Video models respond to different prompt shapes: Veo rewards technical
 * cinematography vocabulary and explicit audio cues, Seedance handles
 * multi-shot narrative with timing markers. Surfacing the difference in the
 * UI is cheaper than letting a user discover it one wasted render at a time.
 *
 * The same logic now covers audio and LoRA work, where the gap between a naive
 * prompt and a good one is larger still — "footstep" and "boot on wet gravel,
 * close-mic, dry" are not close to the same request.
 *
 * Tips adapted from ilkerzg/awesome-video-prompts, plus each vendor's own
 * documented behaviour. Only models this studio can actually run are included —
 * guidance for a backend we do not serve would be dead weight.
 */

export interface PromptGuidance {
  /** Provider id this guidance applies to. */
  providerId: string;
  summary: string;
  /** Recommended prompt ceiling in characters. */
  maxLength: number;
  tips: string[];
}

export const PROMPT_GUIDANCE: PromptGuidance[] = [
  {
    providerId: 'fal-krea-2',
    summary:
      'Krea 2 — the only image model here that takes custom LoRA weights, so it '
      + 'is how you hold one art direction across a whole asset set.',
    maxLength: 2000,
    tips: [
      'Paste a HuggingFace repo id or a .safetensors URL, one per line',
      'Append :scale (0-4) to dial a LoRA down; 0.6-0.8 usually beats 1.0',
      'Stacking two LoRAs works, but lower both scales or they fight',
      'Use the Style endpoint instead when you have reference images, not weights',
      'Krea 2 Large is the only tier with a published price — start on turbo',
    ],
  },
  {
    providerId: 'fal-elevenlabs-tts',
    summary:
      'ElevenLabs TTS — v3 reads inline audio tags, which is what makes it sound '
      + 'directed rather than read aloud.',
    maxLength: 4000,
    tips: [
      'v3 takes inline tags: [whispers], [laughs], [sighs], [excited]',
      'Punctuation is prosody — commas and ellipses actually change the pacing',
      'Write numbers and dates as you want them said, not as digits',
      'Turbo v2.5 for latency, Multilingual v2 for non-English, v3 for performance',
      'Billed per character, so a long script costs proportionally more',
    ],
  },
  {
    providerId: 'fal-elevenlabs-music',
    summary:
      'ElevenLabs Music — full tracks from a description. Billing rounds UP to the '
      + 'whole minute, so ask for the whole minute.',
    maxLength: 4100,
    tips: [
      'Name genre, instrumentation, tempo, and mood — all four measurably help',
      'A 30s clip costs the same $0.80 as 60s; request 60 and trim locally',
      'Say "instrumental" explicitly if you do not want vocals',
      'Structure words work: intro, build, drop, breakdown, outro',
      'Reference an era or a production style rather than naming an artist',
    ],
  },
  {
    providerId: 'fal-elevenlabs-sfx',
    summary:
      'ElevenLabs Sound Effects — one-shot effects up to 22 seconds. Describe '
      + 'material and action, not emotion.',
    maxLength: 1000,
    tips: [
      'Name the material and the surface: "boot on wet gravel", not "footstep"',
      'Add the perspective: close-mic, distant, interior, outdoors',
      'Keep it to a single event; two effects in one prompt blur together',
      'Set duration explicitly for loops and ambience (0.5-22s)',
      'For UI sounds, ask for "short", "dry", and "no reverb"',
    ],
  },
  {
    providerId: 'fal-seed-audio',
    summary:
      'Seed Audio 1.0 — ByteDance speech with voice cloning from a reference clip.',
    maxLength: 2000,
    tips: [
      'Give it a clean reference clip; background noise clones into the voice',
      'Multilingual is on, so mixed-language text works in one pass',
      'Speed, pitch, and volume are separate dials — do not encode them in text',
      'Isolate the reference audio first if it has music behind it',
    ],
  },

  {
    providerId: 'fal-veo31',
    summary:
      'Google Veo 3.1 — the highest-fidelity video here and the most expensive. '
      + 'Rewards technical cinematography language and explicit audio direction.',
    maxLength: 2000,
    tips: [
      'Duration snaps to 4s, 6s, or 8s — asking for 7 gets you 6',
      'Audio is off unless you tick the box; describe the sound when you do',
      'Responds to real camera terms (rack focus, dolly in, crane down)',
      'State the lighting explicitly (golden hour, volumetric fog, rim light)',
      'Naming a film stock or colour science measurably changes the grade',
      'Start on Lite while iterating: same prompt, roughly a seventh of the cost',
    ],
  },
  {
    providerId: 'fal-kling-v3',
    summary:
      'Kling 3.0 — cinematic motion with native audio, and the only model here '
      + 'that renders up to 15 seconds in a single call.',
    maxLength: 2500,
    tips: [
      'Duration is any whole number of seconds from 3 to 15',
      'Ships a tuned negative prompt by default — only override it deliberately',
      'Handles physical motion and crowds better than it handles fine text',
      'Standard is ~25% cheaper than Pro; test the motion there first',
      'Image→video takes a start frame, so generate a still and reuse it',
    ],
  },
  {
    providerId: 'fal-nano-banana-pro',
    summary:
      'Google Nano Banana Pro — the only image model here that reliably renders '
      + 'readable text inside an image.',
    maxLength: 2000,
    tips: [
      'Write the exact wording you want in quotes; it will spell it correctly',
      'Best pick for posters, UI mockups, packaging, and signage',
      '4K output is billed at double rate — stay at 1K while iterating',
      'It accepts a system prompt, so style rules can be separated from the subject',
    ],
  },
  {
    providerId: 'fal-flux2-pro',
    summary:
      'FLUX.2 Pro — Black Forest Labs flagship. Strongest prompt adherence of '
      + 'the image models, priced per output megapixel.',
    maxLength: 2000,
    tips: [
      'Long, structured prompts hold up: it follows clause order',
      'Priced per megapixel, so 1024x1024 is the cheap tier at $0.03',
      'No negative prompt — state what you want, not what you do not',
      'The edit endpoint takes an array of images, so it can blend references',
    ],
  },
  {
    providerId: 'fal-ideogram-v3',
    summary:
      'Ideogram V3 — design and typography work. The rendering speed you pick '
      + 'is the price: Turbo $0.03, Balanced $0.06, Quality $0.09.',
    maxLength: 2000,
    tips: [
      'One of the few models here that takes a negative prompt — use it',
      'Turbo is genuinely usable for layout iteration; only finish on Quality',
      'Strong on logos, posters, and editorial layout',
      'Describe the composition as a designer would: grid, hierarchy, whitespace',
    ],
  },
  {
    providerId: 'fal-seedream5-pro',
    summary:
      'Seedream 5.0 Pro — ByteDance flagship, cheapest of the premium image '
      + 'models and strong on photographic realism.',
    maxLength: 2000,
    tips: [
      'Photographic language works better than illustration language here',
      '2K output costs double; 1536x1536 and under stays on the cheap tier',
      'No seed support, so reruns will not reproduce exactly',
    ],
  },
  {
    providerId: 'fal-tripo',
    summary:
      'Tripo3D v2.5 — the only image→3D option here that outputs quad topology '
      + 'and PBR materials, which is what a game engine actually wants.',
    maxLength: 1000,
    tips: [
      'Feed it a clean, centred subject on a plain background',
      'Run "geometry only" at $0.20 while iterating on silhouette',
      'Only pay for HD textures once the shape is right',
      'Quad topology costs $0.05 more and saves manual retopology',
    ],
  },
  {
    providerId: 'fal-seedance',
    summary: 'ByteDance Seedance 2.0 — multi-shot editing, real-world physics, director-level camera control, native audio.',
    maxLength: 3000,
    tips: [
      'Supports multi-shot with timing markers',
      'Natural language descriptions work best',
      'Physics-aware: describe realistic motion and gravity',
      'Director-level camera control via natural language',
      'Can handle complex narratives in a single prompt',
    ],
  },
  {
    providerId: 'google-veo',
    summary: 'Google Veo 3.1 — cinematic quality, realistic physics, complex camera moves, audio generation.',
    maxLength: 2000,
    tips: [
      'Loves highly detailed cinematic descriptions',
      'Responds well to technical camera terms (rack focus, dolly, crane)',
      'Specify lighting explicitly (golden hour, volumetric fog, rim light)',
      'Mention film stock or color science for better results',
      'Audio descriptions improve generated sound',
    ],
  },
  {
    providerId: 'fal-longcat-video',
    summary:
      'LongCat-Video 13.6B — pretrained on video continuation, so it extends '
      + 'clips without colour drift. Distilled endpoints trade detail for cost.',
    maxLength: 2000,
    tips: [
      'Ships upstream\'s tuned negative prompt by default — do not fight it',
      'Describe one continuous scene; it is not a multi-shot model',
      'Frames are counted at 15fps (480p) or 30fps (720p), so duration maps to num_frames',
      'Distilled endpoints run 16 steps instead of 50: cheaper, slightly softer',
      'Use the continuation path to extend a clip rather than re-prompting from scratch',
    ],
  },
];

/** Guidance for a provider, or undefined when none is curated. */
export function guidanceFor(providerId: string): PromptGuidance | undefined {
  return PROMPT_GUIDANCE.find((g) => g.providerId === providerId);
}
