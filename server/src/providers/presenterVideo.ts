/**
 * Presenter video pipeline — the lanshu workflow as one provider.
 *
 * https://github.com/cclank/lanshu-create-ai-presenter-video is a Codex skill,
 * not a library: a playbook that orchestrates whatever generation backends the
 * environment has into a digital-human video — lock the narration first, then
 * generate the presenter against that audio timeline, then a QA/repair pass.
 * This provider implements that orchestration on top of backends the studio
 * already has, so the multi-step flow becomes ONE job instead of three
 * hand-offs through the gallery:
 *
 *   stage 1 · voice     ElevenLabs TTS          script → narration track
 *                       (skipped when a sourceAudio track is supplied)
 *   stage 2 · presenter Kling AI Avatar         portrait + narration → talking head
 *   stage 3 · repair    Pixverse Lipsync        re-sync the mouth to the track
 *
 * Lanshu's load-bearing insight is that the NARRATION is the timeline: the
 * avatar and every later pass position against the same audio, which is what
 * keeps lip-sync drift and clip seams down. So the pipeline generates (or
 * accepts) the full narration up front and never asks any stage for a
 * duration — the track decides.
 *
 * Why `model` selects pipeline depth rather than a new request flag: the two
 * variants differ only in whether the paid repair stage runs, and the model
 * dropdown already renders from `models[]`. No interface churn, and the choice
 * is visible where the other cost choices are.
 *
 *   pipeline/fast   voice → presenter            (2 stages)
 *   pipeline/qa     voice → presenter → repair   (lanshu's full flow)
 *
 * Cost discipline: Kling Avatar has no vendor-published price (the standalone
 * provider says the same), so no per-job ceiling is asserted for it — quoting
 * "$0.15/s" here would be invented. Pixverse repair DOES have published rates
 * ($0.04/s of output), estimated conservatively from script length and checked
 * against PREMIUM_MAX_COST_PER_JOB_USD before submission.
 *
 * Failure semantics of the repair stage: it is polish on already-paid-for
 * work, so a repair failure does not fail the job. It reports loudly through
 * `onProgress` and returns the presenter cut — never a silent fallback, and
 * the notes tell the operator stage 3 is best-effort.
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
import { assertWithinBudget, premiumAvailability } from './premium.js';
import { ProviderError, type GenerationContext, type Provider } from './types.js';

// ---------------------------------------------------------------------------
// Backends — the same endpoints the standalone providers wrap
// ---------------------------------------------------------------------------

const TTS_ENDPOINT = 'fal-ai/elevenlabs/tts/eleven-v3';
const AVATAR_ENDPOINT = 'fal-ai/kling-video/v1/pro/ai-avatar';
const LIPSYNC_ENDPOINT = 'fal-ai/pixverse/lipsync';

/** Pixverse's published rate: $0.04 per second of output. */
const LIPSYNC_USD_PER_SECOND = 0.04;

/**
 * Speech-rate estimate for pricing a track that does not exist yet:
 * ~15 characters per spoken second, padded ×1.5 so the ceiling errs high.
 * An estimate is acceptable here ONLY because its direction is safe — the
 * alternative is billing an unbounded repair pass with no check at all.
 */
function estimateTrackSeconds(script: string): number {
  return Math.max(4, Math.ceil(script.length / 15 / 0.66));
}

export const PRESENTER_VIDEO_PROVIDERS: Provider[] = [
  {
    id: 'presenter-video',
    label: 'Presenter Video Pipeline (lanshu)',
    modality: 'video',
    requiresSourceImage: true,
    supportsSeed: false,
    supportsNegativePrompt: false,
    // Output geometry follows the portrait, as with the standalone avatar.
    supportedAspectRatios: [],
    models: [
      {
        id: 'pipeline/fast',
        label: 'Fast — voice + presenter (2 stages)',
        price: 'TTS per character + avatar (unpublished by fal)',
      },
      {
        id: 'pipeline/qa',
        label: 'QA — voice + presenter + lipsync repair (3 stages)',
        price: 'adds $0.04/s for the Pixverse repair pass',
      },
    ],
    typicalLatency: '3-12 min',
    tier: 'premium',
    priceRange: 'TTS per character · avatar unpublished · repair $0.04/s',
    producesAudio: true,
    notes:
      'The lanshu digital-human workflow as one job: ElevenLabs writes the ' +
      'narration, Kling AI Avatar makes the portrait speak it, and (QA model) ' +
      'Pixverse re-syncs the mouth to the track as a repair pass. Supply a ' +
      'script as the prompt, or bring your own narration as source audio to ' +
      'skip stage 1. The repair pass is best-effort: if it fails the job still ' +
      'delivers the presenter cut and says so in the progress log.',

    availability: premiumAvailability,

    async generate(req: GenerateRequest, ctx: GenerationContext): Promise<Artifact[]> {
      const qaPass = req.model !== 'pipeline/fast';
      const artifacts: Artifact[] = [];

      // -- stage 1 · narration ------------------------------------------------
      let trackUrl: string;
      if (req.sourceAudio) {
        ctx.onProgress('stage 1/3 · voice — using supplied narration track');
        trackUrl = await falUploadMedia(req.sourceAudio, ctx, 'audio');
      } else {
        if (!req.prompt?.trim()) {
          throw new ProviderError(
            'Presenter pipeline needs a script as the prompt, or a finished ' +
              'narration as source audio',
            400,
          );
        }
        ctx.onProgress('stage 1/3 · voice — ElevenLabs TTS');
        const tts = await runFalQueued(
          TTS_ENDPOINT,
          { text: req.prompt, voice: req.voice || 'Rachel', stability: 0.5 },
          ctx,
        );
        const narration = tts.audio as FalFile | undefined;
        if (!narration?.url) {
          throw new ProviderError('ElevenLabs TTS returned no audio', 502);
        }
        const { data, mimeType } = await downloadFalFile(narration, ctx, 'audio/mpeg');
        const audioArtifact = await saveArtifact(data, mimeType);
        artifacts.push(audioArtifact);
        trackUrl = await falUploadMedia(audioArtifact.url, ctx, 'audio');
      }

      // -- stage 2 · presenter ------------------------------------------------
      ctx.onProgress('stage 2/3 · presenter — Kling AI Avatar against the track');
      const portraitUrl = await falUploadImage(req.sourceImage as string, ctx);
      const presented = await runFalQueued(
        AVATAR_ENDPOINT,
        { image_url: portraitUrl, audio_url: trackUrl, prompt: req.prompt || '.' },
        ctx,
      );
      const head = presented.video as FalFile | undefined;
      if (!head?.url) {
        throw new ProviderError('Kling AI Avatar returned no video', 502);
      }
      const { data: headData, mimeType: headMime } = await downloadFalFile(
        head,
        ctx,
        'video/mp4',
      );
      const presenterCut = await saveArtifact(headData, headMime);
      artifacts.push(presenterCut);

      if (!qaPass) return artifacts;

      // -- stage 3 · lipsync repair (best-effort) -----------------------------
      try {
        // The track already exists, so this is the cheap audio-driven path.
        const repairSeconds = req.durationSeconds ?? estimateTrackSeconds(req.prompt ?? '');
        const repairCost = LIPSYNC_USD_PER_SECOND * repairSeconds;
        assertWithinBudget(repairCost, `Pixverse repair pass (~${repairSeconds}s)`);

        ctx.onProgress(
          `stage 3/3 · repair — Pixverse Lipsync, ${costNoteOf(repairCost)}`,
        );
        const repaired = await runFalQueued(LIPSYNC_ENDPOINT, {
          video_url: await falUploadMedia(presenterCut.url, ctx, 'video'),
          audio_url: trackUrl,
        }, ctx);
        const fixed = repaired.video as FalFile | undefined;
        if (!fixed?.url) throw new ProviderError('Pixverse returned no video', 502);
        const { data: fixData, mimeType: fixMime } = await downloadFalFile(
          fixed,
          ctx,
          'video/mp4',
        );
        artifacts.push(await saveArtifact(fixData, fixMime));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.onProgress(
          `stage 3/3 · repair failed (${reason}) — delivering the presenter cut`,
        );
      }

      return artifacts;
    },
  },
];

function costNoteOf(usd: number): string {
  return `about $${usd.toFixed(2)}`;
}
