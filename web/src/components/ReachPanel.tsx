/**
 * Reach panel — pull a reference URL down to markdown to ground a prompt.
 *
 * The fetched text is untrusted page content. It is shown read-only for a human
 * to read and copy from; nothing is auto-inserted into the prompt and nothing is
 * executed. "Append to prompt" is an explicit click.
 */

import { useState } from 'react';
import { reachFetch } from '../lib/api';
import type { ReachResult } from '../lib/types';
import { ErrorNote } from './Primitives';

interface Props {
  /** Called when the user explicitly appends the excerpt to the prompt. */
  onAppendToPrompt: (text: string) => void;
  /** Which backend the server would use, from /api/health. */
  backend?: string;
}

export function ReachPanel({ onAppendToPrompt, backend }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReachResult | null>(null);

  const run = async () => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const { result: r } = await reachFetch(url.trim());
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reach failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-label="Reference research">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <span className="block text-sm font-medium text-slate-200">Reach a reference</span>
          <span className="block text-xs text-slate-500">
            Turn a URL into text you can build a prompt from
          </span>
        </span>
        <span className="font-mono text-xs text-slate-500">{open ? '−' : '+'}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-ink-700 px-4 py-3">
          <div>
            <label className="field-label" htmlFor="reach-url">
              Reference URL
            </label>
            <div className="flex gap-2">
              <input
                id="reach-url"
                className="input"
                value={url}
                placeholder="https://…"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && url.trim() && !busy) {
                    e.preventDefault();
                    void run();
                  }
                }}
              />
              <button
                type="button"
                className="btn-primary whitespace-nowrap"
                disabled={busy || url.trim().length < 8}
                onClick={() => void run()}
              >
                {busy ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
            {backend ? (
              <p className="mt-1.5 text-xs text-slate-500">
                backend: <span className="font-mono">{backend}</span>
                {backend === 'jina-reader'
                  ? ' — install the agent-reach CLI to unlock Twitter, Reddit, YouTube subtitles, and Bilibili'
                  : ' — Twitter, Reddit, YouTube, Bilibili, and XiaoHongShu available'}
              </p>
            ) : null}
          </div>

          {error ? <ErrorNote message={error} /> : null}

          {result ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs text-slate-400" title={result.title ?? result.url}>
                  {result.title ?? result.url}
                </p>
                <span className="badge bg-ink-700 text-slate-400">{result.backend}</span>
              </div>

              <textarea
                readOnly
                className="input min-h-[160px] resize-y font-mono text-xs"
                value={result.content}
                aria-label="Fetched reference content"
              />

              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-slate-500">
                  {result.chars.toLocaleString()} chars in {(result.elapsedMs / 1000).toFixed(1)}s
                  {result.truncated ? ' · truncated' : ''}
                </p>
                <button
                  type="button"
                  className="btn-ghost !px-2.5 !py-1 !text-xs"
                  onClick={() => onAppendToPrompt(result.content.slice(0, 1500))}
                >
                  Append to prompt
                </button>
              </div>

              <p className="text-[11px] text-slate-600">
                This is raw page content from an external site. Read it before using it — it is
                shown as text and never sent to a model on its own.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
