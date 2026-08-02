/**
 * History of past jobs.
 *
 * Each finished job offers to reuse its output as an input elsewhere — that is
 * the studio's main workflow, not a convenience: generate a still, upscale it,
 * animate it, upscale the clip, transcribe the audio. The reuse buttons are what
 * chain those steps without copy-pasting URLs.
 */

import { MODALITY_LABELS, type Job } from '../lib/types';
import { EmptyState, StatusBadge, formatBytes } from './Primitives';

interface Props {
  jobs: Job[];
  /** Load an image into the source-image field. */
  onReuseImage: (mediaUrl: string) => void;
  /** Load a video into the source-video field (upscalers, transcription). */
  onReuseVideo: (mediaUrl: string) => void;
  /** Load audio into the source-audio field (transcription, isolation). */
  onReuseAudio: (mediaUrl: string) => void;
}

export function Gallery({ jobs, onReuseImage, onReuseVideo, onReuseAudio }: Props) {
  if (jobs.length === 0) {
    return (
      <div className="panel">
        <EmptyState
          title="No generations yet"
          hint="Finished jobs appear here. History is stored server-side, so it survives a reload."
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {jobs.map((job) => {
        const artifact = job.artifacts[0];
        const isImage = artifact?.mimeType.startsWith('image/') ?? false;
        const isVideo = artifact?.mimeType.startsWith('video/') ?? false;
        const isAudio = artifact?.mimeType.startsWith('audio/') ?? false;
        const isText = Boolean(artifact?.text) || (artifact?.mimeType.startsWith('text/') ?? false);

        return (
          <article key={job.id} className="panel overflow-hidden">
            <div className="relative aspect-square bg-ink-850">
              {artifact && isImage ? (
                <img
                  src={artifact.url}
                  alt={job.request.prompt.slice(0, 80) || 'Generated image'}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : artifact && isVideo ? (
                <video
                  src={artifact.url}
                  muted
                  loop
                  playsInline
                  className="h-full w-full object-cover"
                  onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                  onMouseLeave={(e) => e.currentTarget.pause()}
                />
              ) : artifact && isAudio ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-3">
                  <span className="text-[11px] uppercase tracking-wider text-slate-500">
                    Audio
                  </span>
                  <audio src={artifact.url} controls className="w-full" aria-label="Generated audio" />
                </div>
              ) : artifact && isText ? (
                /* Transcripts get a readable excerpt instead of a blank tile. */
                <p className="line-clamp-6 h-full overflow-hidden px-3 py-3 text-[11px] leading-snug text-slate-400">
                  {artifact.text}
                </p>
              ) : (
                <div className="flex h-full items-center justify-center px-3 text-center">
                  <span className="text-xs text-slate-500">
                    {job.status === 'failed' ? (job.error ?? 'failed') : MODALITY_LABELS[job.modality]}
                  </span>
                </div>
              )}
              <div className="absolute left-2 top-2">
                <StatusBadge status={job.status} />
              </div>
            </div>

            <div className="space-y-2 p-2.5">
              <p className="line-clamp-2 text-xs text-slate-400" title={job.request.prompt}>
                {job.request.prompt || <span className="italic text-slate-600">no prompt</span>}
              </p>
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span className="font-mono">{job.provider}</span>
                {artifact ? <span>{formatBytes(artifact.bytes)}</span> : null}
              </div>

              {/*
                Reuse routes to the field that matches the artifact's type. An
                image goes to source-image, a clip to source-video (upscalers and
                transcription), a track to source-audio. Text has nothing to feed.
              */}
              {artifact && isImage ? (
                <button
                  type="button"
                  className="btn-ghost w-full !px-2 !py-1 !text-xs"
                  onClick={() => onReuseImage(artifact.url)}
                >
                  Use as source
                </button>
              ) : null}
              {artifact && isVideo ? (
                <button
                  type="button"
                  className="btn-ghost w-full !px-2 !py-1 !text-xs"
                  onClick={() => onReuseVideo(artifact.url)}
                >
                  Upscale or transcribe
                </button>
              ) : null}
              {artifact && isAudio ? (
                <button
                  type="button"
                  className="btn-ghost w-full !px-2 !py-1 !text-xs"
                  onClick={() => onReuseAudio(artifact.url)}
                >
                  Transcribe or clean up
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
