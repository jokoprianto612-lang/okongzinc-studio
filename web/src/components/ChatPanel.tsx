/** Agent-chat panel: type what you want, get a video job back.
 *
 * No provider picker, no aspect dial — the message IS the prompt, and the
 * cheapest available video provider renders it. Results land in the job list
 * like any other generation, so the gallery can reuse them.
 */

import { useCallback, useState } from 'react';
import { fetchChat } from '../lib/api';
import { fetchJob } from '../lib/api';
import {
  ChatMessage,
  isTerminal,
} from '../lib/types';
import { useJobPolling } from '../hooks/useJobPolling';
import { ErrorNote, ProgressBar, StatusBadge } from './Primitives';

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // In-flight job from this panel, so we can poll its progress.
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  const { job, setJob } = useJobPolling(
    null,
    (finished) => {
      setMessages((current) =>
        current.map((m) =>
          m.jobId === finished.id ? { ...m, status: finished.status } : m,
        ),
      );
      setActiveJobId(null);
      void refreshJob();
    },
  );

  const refreshJob = useCallback(async () => {
    if (!activeJobId) return;
    try {
      const { job: fresh } = await fetchJob(activeJobId);
      setJob(fresh);
      setMessages((current) =>
        current.map((m) =>
          m.jobId === fresh.id ? { ...m, status: fresh.status } : m,
        ),
      );
      if (isTerminal(fresh.status)) setActiveJobId(null);
    } catch {
      // Transient: next poll tick will try again via useJobPolling.
    }
  }, [activeJobId, setJob]);

  const submit = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setError('');
    setSending(true);
    try {
      const { job: created, parsed } = await fetchChat({ message: text });
      const id = created.id;
      const userMsg: ChatMessage = {
        id: `${id}-user`,
        role: 'user',
        content: text,
      };
      const parts = [
        `Generating video with ${created.provider}`,
        parsed.durationSeconds ? `— ${parsed.durationSeconds}s` : null,
        parsed.aspectRatio ? `— ${parsed.aspectRatio}` : null,
        `— job ${id.slice(0, 8)}`,
      ].filter(Boolean).join(' ');
      const assistantMsg: ChatMessage = {
        id: `${id}-assistant`,
        role: 'assistant',
        content: parts,
        jobId: id,
        status: created.status,
      };
      setMessages((current) => [...current, userMsg, assistantMsg]);
      setInput('');
      setActiveJobId(id);
      void refreshJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'chat request failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel space-y-3 p-4" aria-label="Agent chat">
      <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500 flex items-center gap-2">
        <span>💬</span> Agent chat — video
      </h2>

      {error ? <ErrorNote message={error} /> : null}

      <div className="space-y-2 max-h-[420px] overflow-y-auto pr-2">
        {messages.length === 0 ? (
          <div className="text-[11px] text-slate-500 italic">
            Tell it what to generate — e.g. "a cyberpunk street in neon rain, 5 seconds"
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex gap-2 ${
                m.role === 'user' ? 'flex-row-reverse' : ''
              }`}
            >
              <div
                className={`max-w-[80%] rounded border p-2 text-sm leading-snug ${
                  m.role === 'user'
                    ? 'bg-ink-800 border-ink-700 text-slate-200 ml-auto'
                    : 'bg-ink-850 border-ink-700 text-slate-300'
                }`}
              >
                {m.content}
                {m.jobId && m.status && !isTerminal(m.status) ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <StatusBadge status={m.status} />
                    <span className="font-mono text-[10px] text-slate-500">
                      {m.jobId.slice(0, 8)}
                    </span>
                  </div>
                ) : null}
                {m.jobId && m.status === 'succeeded' ? (
                  <p className="mt-1 text-[10px] text-emerald-400">
                    Video ready — check the gallery on the right.
                  </p>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="mt-2 flex gap-2">
        <input
          id="chat-input"
          className="input flex-1"
          placeholder="What video should I generate?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={sending || !input.trim()}
          onClick={submit}
        >
          {sending ? 'Sending…' : 'Generate'}
        </button>
      </div>

      {job && activeJobId ? (
        <div className="mt-3 rounded border border-ink-700 bg-ink-850 p-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-slate-400">Job status</span>
            <StatusBadge status={job.status} />
          </div>
          {!isTerminal(job.status) ? (
            <ProgressBar note={job.progressNote} />
          ) : job.error ? (
            <ErrorNote message={job.error} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
