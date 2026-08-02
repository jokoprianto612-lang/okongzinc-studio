/**
 * Prompt studio — LLM-assisted prompt authoring.
 *
 * Two buttons over one textarea:
 *
 *   Enhance    rewrite the idea the way the SELECTED provider wants it read
 *   Break down turn the idea into editable cinematography categories
 *
 * The breakdown is editable on purpose. An LLM that returns twelve fields and no
 * way to change them is a slot machine; the value is in adjusting `lighting` and
 * re-composing without re-running the model. `composeFromCategories` here mirrors
 * the server's function exactly, so the preview cannot disagree with what gets
 * submitted.
 *
 * SECURITY: everything shown here is untrusted LLM output. It lands in a textarea
 * for a human to read and edit — nothing is auto-submitted as a generation, and
 * `Use this prompt` requires a deliberate click.
 */

import { useState } from 'react';
import { breakdownPrompt, enhancePrompt } from '../lib/api';
import type { BreakdownResult, PromptStudioInfo } from '../lib/types';
import { ErrorNote } from './Primitives';

interface Props {
  studio: PromptStudioInfo;
  /** The current prompt from App, so both actions operate on what is on screen. */
  prompt: string;
  /** Replace the prompt in the form. */
  onPromptChange: (text: string) => void;
  /** Which provider is selected, so Enhance can use its guidance. */
  providerId: string;
}

/**
 * Category order for display.
 *
 * Comes from the server via `studio.categories`, so the two stay in step. Falling
 * back to the object's own key order would reorder the composed prompt whenever
 * the LLM emitted fields in a different sequence.
 */
export function PromptStudio({ studio, prompt, onPromptChange, providerId }: Props) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<'' | 'enhance' | 'breakdown'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [breakdown, setBreakdown] = useState<BreakdownResult | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});

  const canRun = prompt.trim().length >= 3 && busy === '';

  /** Same rule as the server's composeFromCategories — keep them identical. */
  const compose = (categories: Record<string, string>): string => {
    const order = studio.categories;
    const subject = categories.subject?.trim();
    const action = categories.action?.trim();
    const lead = [subject, action].filter(Boolean).join(', ');
    const rest = order
      .filter((k) => k !== 'subject' && k !== 'action')
      .map((k) => categories[k]?.trim())
      .filter((v): v is string => Boolean(v));

    if (!lead) return rest.join(', ');
    if (rest.length === 0) return lead;
    return `${lead}. ${rest.join(', ')}`;
  };

  const runEnhance = async () => {
    setError('');
    setNote('');
    setBusy('enhance');
    try {
      const { result } = await enhancePrompt({
        prompt: prompt.trim(),
        providerId: providerId || undefined,
        model: model || undefined,
      });
      onPromptChange(result.enhanced);
      setNote(
        result.guidanceUsed
          ? `Rewritten for ${result.guidanceUsed} using ${result.model} in ${(result.elapsedMs / 1000).toFixed(1)}s.`
          : `Rewritten with generic advice using ${result.model} — this provider has no curated guidance yet.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'enhance failed');
    } finally {
      setBusy('');
    }
  };

  const runBreakdown = async () => {
    setError('');
    setNote('');
    setBusy('breakdown');
    try {
      const { result } = await breakdownPrompt({
        prompt: prompt.trim(),
        model: model || undefined,
      });
      setBreakdown(result);
      setEdited(result.categories);
      setNote(
        `${Object.keys(result.categories).length} categories from ${result.model} in ${(result.elapsedMs / 1000).toFixed(1)}s. Edit any field, then use the prompt.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'breakdown failed');
    } finally {
      setBusy('');
    }
  };

  const composed = breakdown ? compose(edited) : '';

  return (
    <section className="panel" aria-label="Prompt studio">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <span className="block text-sm font-medium text-slate-200">Prompt studio</span>
          <span className="block text-xs text-slate-500">
            {studio.available
              ? 'Rewrite for the selected model, or break the idea into shot categories'
              : 'Unavailable'}
          </span>
        </span>
        <span className="font-mono text-xs text-slate-500">{open ? '−' : '+'}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-ink-700 px-4 py-3">
          {!studio.available ? (
            <p className="text-xs text-amber-400">
              {studio.reason ?? 'The prompt studio is not available on this deployment.'}
            </p>
          ) : (
            <>
              {error ? <ErrorNote message={error} /> : null}

              <div>
                <label className="field-label" htmlFor="prompt-llm">
                  LLM
                </label>
                <select
                  id="prompt-llm"
                  className="input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="">Default (cheapest)</option>
                  {studio.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
                  Billed as tokens on your fal key — a rewrite costs a fraction of a cent, far
                  less than one wasted render.
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-ghost flex-1 !py-1.5 !text-xs"
                  disabled={!canRun}
                  onClick={() => void runEnhance()}
                >
                  {busy === 'enhance' ? 'Enhancing…' : 'Enhance prompt'}
                </button>
                <button
                  type="button"
                  className="btn-ghost flex-1 !py-1.5 !text-xs"
                  disabled={!canRun}
                  onClick={() => void runBreakdown()}
                >
                  {busy === 'breakdown' ? 'Breaking down…' : 'Break down'}
                </button>
              </div>

              {prompt.trim().length < 3 ? (
                <p className="text-[11px] text-slate-500">
                  Type an idea in the prompt field first — even a few words is enough.
                </p>
              ) : null}

              {note ? <p className="text-[11px] text-brand-cyan">{note}</p> : null}

              {/* editable category breakdown */}
              {breakdown ? (
                <div className="space-y-2 border-t border-ink-700 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-medium uppercase tracking-wider text-slate-500">
                      Categories
                    </h3>
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-0.5 !text-[11px]"
                      onClick={() => {
                        setBreakdown(null);
                        setEdited({});
                        setNote('');
                      }}
                    >
                      Clear
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {studio.categories
                      .filter((key) => key in edited)
                      .map((key) => (
                        <div key={key}>
                          <label
                            className="block text-[11px] text-slate-500"
                            htmlFor={`cat-${key}`}
                          >
                            {key.replace(/_/g, ' ')}
                          </label>
                          <input
                            id={`cat-${key}`}
                            className="input !py-1 !text-xs"
                            value={edited[key] ?? ''}
                            onChange={(e) =>
                              setEdited((current) => ({ ...current, [key]: e.target.value }))
                            }
                          />
                        </div>
                      ))}
                  </div>

                  <div className="border-t border-ink-700 pt-2">
                    <p className="text-[11px] text-slate-500">Composed prompt</p>
                    <p className="mt-1 max-h-32 overflow-auto text-[11px] leading-snug text-slate-300">
                      {composed || '(all fields empty)'}
                    </p>
                    <button
                      type="button"
                      className="btn-primary mt-2 w-full !py-1.5 !text-xs"
                      disabled={!composed}
                      onClick={() => {
                        onPromptChange(composed);
                        setNote('Composed prompt moved into the prompt field.');
                      }}
                    >
                      Use this prompt
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
