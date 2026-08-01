/**
 * Per-model prompting guidance.
 *
 * Video models respond to different prompt shapes: Veo rewards technical
 * cinematography vocabulary and explicit audio cues, Seedance handles
 * multi-shot narrative with timing markers. Surfacing the difference in the
 * UI is cheaper than letting a user discover it one wasted render at a time.
 *
 * Tips adapted from ilkerzg/awesome-video-prompts. Only models this studio can
 * actually run are included — guidance for a backend we do not serve would be
 * dead weight.
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
