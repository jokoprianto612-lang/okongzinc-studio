/**
 * Shot Composer — pick cinematography terms, get them folded into the prompt.
 *
 * The value is not the vocabulary list itself: it is that each term carries a
 * reference clip, so you can see what "rack focus" or "neon city lighting"
 * actually looks like before spending a render on it.
 *
 * Selected ids are sent to the server as `shotOptionIds` rather than being
 * concatenated here, so the stored job records the exact prompt that was sent.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchShots } from '../lib/api';
import type { ShotCategory } from '../lib/types';
import { ErrorNote } from './Primitives';

interface Props {
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function ShotComposer({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<ShotCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<string>('');

  // Fetch lazily: 22 categories of data is wasted bytes for someone who never
  // opens the panel.
  useEffect(() => {
    if (!open || categories.length > 0 || loading) return;
    setLoading(true);
    fetchShots()
      .then(({ categories: list }) => {
        setCategories(list);
        setActiveCategory(list[0]?.id ?? '');
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'could not load shot vocabulary'),
      )
      .finally(() => setLoading(false));
  }, [open, categories.length, loading]);

  const active = useMemo(
    () => categories.find((c) => c.id === activeCategory),
    [categories, activeCategory],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <section className="panel" aria-label="Shot composer">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>
          <span className="block text-sm font-medium text-slate-200">Shot composer</span>
          <span className="block text-xs text-slate-500">
            {selected.length > 0
              ? `${selected.length} term${selected.length === 1 ? '' : 's'} added to the prompt`
              : 'Cinematography terms, each with a reference clip'}
          </span>
        </span>
        <span className="font-mono text-xs text-slate-500">{open ? '−' : '+'}</span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-ink-700 px-4 py-3">
          {error ? <ErrorNote message={error} /> : null}
          {loading ? <p className="text-xs text-slate-500">loading vocabulary…</p> : null}

          {categories.length > 0 ? (
            <>
              {/* category picker */}
              <div>
                <label className="field-label" htmlFor="shot-category">
                  Category
                </label>
                <select
                  id="shot-category"
                  className="input"
                  value={activeCategory}
                  onChange={(e) => {
                    setActiveCategory(e.target.value);
                    setPreview('');
                  }}
                >
                  {categories.map((c) => {
                    const picked = c.options.filter((o) => selectedSet.has(o.id)).length;
                    return (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {picked > 0 ? ` (${picked})` : ''}
                      </option>
                    );
                  })}
                </select>
                {active ? (
                  <p className="mt-1.5 text-xs text-slate-500">{active.description}</p>
                ) : null}
              </div>

              {/* options */}
              <ul className="space-y-1.5">
                {active?.options.map((option) => {
                  const isSelected = selectedSet.has(option.id);
                  return (
                    <li key={option.id}>
                      <div
                        className={`rounded-md border px-2.5 py-2 transition-colors ${
                          isSelected
                            ? 'border-brand-cyan bg-ink-800'
                            : 'border-ink-700 hover:border-ink-600'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            id={`shot-${option.id}`}
                            checked={isSelected}
                            onChange={() => toggle(option.id)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-brand-cyan"
                          />
                          <div className="min-w-0 flex-1">
                            <label
                              htmlFor={`shot-${option.id}`}
                              className="block cursor-pointer text-sm text-slate-200"
                            >
                              {option.label}
                            </label>
                            <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                              {option.description}
                            </p>
                          </div>
                          {option.video ? (
                            <button
                              type="button"
                              className="btn-ghost shrink-0 !px-2 !py-0.5 !text-[11px]"
                              onClick={() =>
                                setPreview(preview === option.video ? '' : option.video)
                              }
                            >
                              {preview === option.video ? 'Hide' : 'Preview'}
                            </button>
                          ) : null}
                        </div>

                        {preview === option.video && option.video ? (
                          <video
                            src={option.video}
                            className="mt-2 w-full rounded border border-ink-700"
                            controls
                            autoPlay
                            muted
                            loop
                            playsInline
                            aria-label={`Reference clip: ${option.label}`}
                          />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {selected.length > 0 ? (
                <div className="flex items-center justify-between gap-2 border-t border-ink-700 pt-2.5">
                  <p className="text-xs text-slate-500">
                    {selected.length} term{selected.length === 1 ? '' : 's'} will be appended
                  </p>
                  <button
                    type="button"
                    className="btn-ghost !px-2.5 !py-1 !text-xs"
                    onClick={() => onChange([])}
                  >
                    Clear all
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
