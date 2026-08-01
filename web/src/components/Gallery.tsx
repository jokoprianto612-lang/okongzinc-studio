/** History of past jobs. Clicking a succeeded image reuses it as a source. */

import { MODALITY_LABELS, type Job } from '../lib/types';
import { EmptyState, StatusBadge, formatBytes } from './Primitives';

interface Props {
  jobs: Job[];
  onReuse: (mediaUrl: string) => void;
}

export function Gallery({ jobs, onReuse }: Props) {
  if (jobs.length === 0) {
    return (
      <div className="panel">
        <EmptyState
          title="No generations yet"
          hint="Finished jobs appear here. History lives in memory, so it resets when the server restarts — the files themselves stay on disk."
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

        return (
          <article key={job.id} className="panel overflow-hidden">
            <div className="relative aspect-square bg-ink-850">
              {artifact && isImage ? (
                <img
                  src={artifact.url}
                  alt={job.request.prompt.slice(0, 80)}
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
                {job.request.prompt}
              </p>
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span className="font-mono">{job.provider}</span>
                {artifact ? <span>{formatBytes(artifact.bytes)}</span> : null}
              </div>
              {artifact && isImage ? (
                <button
                  type="button"
                  className="btn-ghost w-full !px-2 !py-1 !text-xs"
                  onClick={() => onReuse(artifact.url)}
                >
                  Use as source
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}
