/** Small presentational pieces shared across panels. */

import type { JobStatus } from '../lib/types';

const STATUS_STYLES: Record<JobStatus, string> = {
  queued: 'bg-ink-700 text-slate-300',
  running: 'bg-brand-cyan/20 text-brand-cyan',
  succeeded: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-amber-500/20 text-amber-400',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge ${STATUS_STYLES[status]}`}>{status}</span>;
}

/** Indeterminate bar — providers give no percentage, so don't fake one. */
export function ProgressBar({ note }: { note?: string }) {
  return (
    <div className="space-y-1.5">
      <div className="h-1 w-full overflow-hidden rounded bg-ink-700">
        <div className="progress-sweep h-full w-1/3 rounded bg-brand-cyan" />
      </div>
      {note ? <p className="font-mono text-xs text-slate-400">{note}</p> : null}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-slate-400">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
    >
      {message}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
