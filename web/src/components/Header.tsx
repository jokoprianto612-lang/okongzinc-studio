/** App header: brand mark, backend health, and the API-key control. */

import { useEffect, useState } from 'react';
import { fetchHealth, getApiKey, setApiKey } from '../lib/api';

export function Header() {
  const [health, setHealth] = useState<{ ok: boolean; authenticated: boolean } | null>(null);
  const [offline, setOffline] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState(getApiKey());

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const h = await fetchHealth();
        if (!alive) return;
        setHealth(h);
        setOffline(false);
      } catch {
        if (alive) setOffline(true);
      }
    };
    void check();
    const timer = setInterval(check, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <header className="border-b border-ink-700 bg-ink-900">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-3">
          <img
            src="/brand/icon.svg"
            alt="OkongzINC logo"
            className="h-9 w-9 rounded-md border border-ink-700 object-cover"
          />
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-slate-100">
              OkongzINC Studio
            </h1>
            <p className="text-[11px] text-slate-500">image · video · 3D · audio</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            className="flex items-center gap-1.5 text-[11px] text-slate-400"
            title={offline ? 'API unreachable' : 'API reachable'}
          >
            <span
              className={`h-2 w-2 rounded-full ${
                offline ? 'bg-red-500' : health ? 'bg-emerald-500' : 'bg-slate-600'
              }`}
            />
            {offline ? 'API offline' : health ? 'API online' : 'checking'}
          </span>

          <button type="button" className="btn-ghost !px-3 !py-1.5" onClick={() => setShowKey((v) => !v)}>
            {getApiKey() ? 'API key set' : 'Set API key'}
          </button>
        </div>
      </div>

      {showKey ? (
        <div className="border-t border-ink-700 bg-ink-850 px-4 py-3">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="field-label" htmlFor="api-key">
                X-Api-Key (only needed if the server sets API_KEY)
              </label>
              <input
                id="api-key"
                type="password"
                className="input"
                value={keyDraft}
                placeholder="leave blank for local development"
                onChange={(e) => setKeyDraft(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setApiKey(keyDraft.trim());
                setShowKey(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </header>
  );
}
